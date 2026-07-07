# 舞萌机厅队列预测算法

**版本** 2.1.0 · **模块** `src/predictor.ts` · `src/event-quality.ts` · `src/chart.ts`

---

## 摘要

本文档描述 koishi-plugin-mai-queue 中 `predict` 指令背后的预测系统。该系统面向街机厅（机台）排队场景：在群友报卡与 Nearcade 上报的离散观测下，**在线学习**每机厅独立的到达/离场速率与时段画像，并输出：

1. **等待时间估计** \( \hat{W} \)
2. **未来 \(H\) 小时人数轨迹** \( \{\hat{N}(t_k)\} \)（默认 \(H=8\)，步长 30 分钟）
3. **推荐出勤时段**
4. **24 小时趋势图**（历史实线 + 预测虚线）

算法为轻量级启发式混合模型，不依赖外部 ML 服务；强调**营业时段约束**、**数据可信度过滤**与**周中/周末异质性**。

---

## 1. 问题定义

### 1.1 观测

每个机厅 \(a\) 维护事件序列：

\[
\mathcal{E}_a = \{(t_i, N_i, \Delta_i, m_i, s_i)\}_{i=1}^{n}
\]

| 符号 | 含义 |
|------|------|
| \(t_i\) | ISO 时间戳 |
| \(N_i\) | 在场人数 |
| \(\Delta_i = N_i - N_{i-1}\) | 单次变化量 |
| \(m_i\) | 机台数 |
| \(s_i \in \{\text{local}, \text{nearcade}\}\) | 数据来源 |

机台容量：

\[
C = m \cdot p
\]

其中 \(p\) 为每台同时游玩人数（默认 2）。

### 1.2 预测任务

给定当前人数 \(N_0\)、时刻 \(t_0\)，估计：

- **等待时间** \(W\)：新到玩家需等待多久才能上机
- **未来人数** \(\hat{N}(t_0 + \tau)\)，\(\tau \in \{30, 60, \ldots, H \times 60\}\) 分钟
- **最优出勤时刻** \(\tau^\*\)（在营业时段内使预期人数较低）

### 1.3 约束

- 仅在**营业时段**或**闭店宽容期**内允许 \(N > 0\) 的可信上报
- 非营业时段预测强制 \(\hat{N} = 0\)
- 每机厅模型独立，持久化于 `data/mai-queue-history.yml`

---

## 2. 系统架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ 群友报卡     │────▶│  Event Quality   │────▶│  Online Learner │
│ Nearcade    │     │  (可信性过滤)     │     │  (EMA 参数更新)  │
└─────────────┘     └──────────────────┘     └────────┬────────┘
                                                      │
                    ┌─────────────────────────────────┼─────────────────────────────────┐
                    ▼                                 ▼                                 ▼
            ┌───────────────┐               ┌─────────────────┐               ┌──────────────┐
            │ Wait Time     │               │ Crowd Forecast  │               │ Chart (24h)  │
            │ Formula+Sim   │               │ WLSR + Profile    │               │ Break-axis   │
            └───────────────┘               └─────────────────┘               └──────────────┘
```

**数据流**：上报 → 校验 → 写入事件日志 → 增量更新模型 → 推理时读取可信子集 → 输出文本与 PNG 图。

---

## 3. 数据质量层

可信事件集合 \(\mathcal{E}_a^\*\subseteq \mathcal{E}_a\) 由 `validateQueueEvent` 判定。拒绝条件包括：

| 规则 | 说明 |
|------|------|
| 时间戳无效 / 未来 / 超过 90 天 | 防止脏数据与时钟漂移 |
| \(N < 0\) 或非有限 | 基本合法性 |
| \(N > N_{\max}\) | \(N_{\max} = 6 \cdot C\)（合理上限） |
| 非营业且非宽容期且 \(N > 0\) | 如凌晨有人玩 |
| \(|\Delta| > 20\) | 单次跳变过大 |

### 3.1 营业时段

配置 \([h_{\text{open}}, h_{\text{close}}]\)（两端均含，默认 10–23 点）。判定函数 `isOperatingHour`：

\[
\text{open}(t) \iff h_{\text{open}} \le \text{hour}(t) \le h_{\text{close}}
\]

（跨午夜营业另行处理。）

### 3.2 闭店宽容期

正式打烊后 \(g\) 分钟内（默认 \(g=90\)）仍视为 `isOperatingOrGrace`，允许延迟闭店场景下的上报与预测。

宽容进度（用于人数衰减）：

\[
\gamma(t) = \min\left(1,\; \frac{\text{mins}(t) - (h_{\text{close}}+1)\times 60}{g}\right)
\]

### 3.3 凌晨清零事件

平台或系统在 00:00–00:30 将人数重置为 0，产生虚假「大规模离场」。识别条件：

\[
\text{reset}(t, N, \Delta) \iff N=0 \land \Delta<0 \land \text{hour}(t)=0 \land \text{minute}(t)\le 30
\]

**处理策略**：

- 不更新离场速率、游玩时长模型
- 不写入时段画像 EMA
- 事件仍可保留于日志（作为 0 值记录）

启动时 `sanitizeAll` 会剔除不可信事件并**全量重放**模型参数。

---

## 4. 在线学习模型

每机厅维护状态向量 \(\theta_a\)：

| 参数 | 符号 | 含义 |
|------|------|------|
| `avgPlayMinutes` | \(\bar{T}\) | 人均游玩时长（分钟） |
| `avgArrivalRate` | \(\lambda\) | 到达速率（人/小时） |
| `avgDepartureRate` | \(\mu\) | 离场速率（人/小时） |
| `hourAvgCountWeekday[h]` | \(\bar{N}_w(h)\) | 周中第 \(h\) 小时 EMA 均值 |
| `hourAvgCountWeekend[h]` | \(\bar{N}_e(h)\) | 周末第 \(h\) 小时 EMA 均值 |
| `sampleCount` | — | 游玩时长样本计数 |

学习率 \(\alpha = 0.12\)（EMA）。

### 4.1 游玩时长

当 \(\Delta < 0\)（有人离场）时，向前搜索历史事件，找到人数曾 \(\ge N_{\text{current}} + |\Delta|\) 的时刻，计算历时 \(\Delta t\)（分钟），则每人游玩时长样本为 \(\Delta t / |\Delta|\)。若 \(1 < \Delta t < 180\)：

\[
\bar{T} \leftarrow \alpha \cdot \frac{\Delta t}{|\Delta|} + (1-\alpha) \cdot \bar{T}
\]

### 4.2 到达 / 离场速率

相邻事件间隔 \(\Delta h\) 小时（要求 \(0 < \Delta h \le 6\)）：

\[
\lambda \leftarrow \alpha \cdot \frac{\max(\Delta, 0)}{\Delta h} + (1-\alpha)\cdot \lambda
\]
\[
\mu \leftarrow \alpha \cdot \frac{\max(-\Delta, 0)}{\Delta h} + (1-\alpha)\cdot \mu
\]

### 4.3 时段画像

对可信事件（非凌晨清零），按本地小时 \(h\) 与日类型 \(d \in \{w,e\}\)：

\[
\bar{N}_d(h) \leftarrow \alpha \cdot N + (1-\alpha)\cdot \bar{N}_d(h)
\]

预测时取 \(\text{profile}(t) = \bar{N}_d(\text{hour}(t))\)，其中 \(d\) 由 `getDayType(t)` 决定。

---

## 5. 等待时间预测

等待时间模型针对**舞萌DX**的实际游玩机制设计：一台机可 1P 或 2P 游玩，单轮时长约 **14 分钟（1P）/ 17 分钟（2P）**；越拥挤，2P 拼机与结伴占比越高。

### 5.1 拥挤度自适应单轮模型

设队列超额 \(Q = N - C\)（\(N \le C\) 时 \(W = 0\)），拥挤度：

\[
\kappa = \min\left(1,\; \frac{Q}{C}\right)
\]

单轮时长与每台每轮平均消化人数随拥挤度插值：

\[
T_{\text{round}}(\kappa) = 14 + 3\kappa \qquad (\text{1P 为主} \to \text{2P 为主})
\]
\[
g(\kappa) = 1.3 + 0.7\kappa \qquad (\text{每台混合人数} \to 2)
\]

注意二者方向相反的补偿效应：人多时单轮更长（17 分钟），但每轮吞吐也翻倍（\(m \cdot g\) 人/轮），净等待增长平缓——符合「人多反而两人更多」的现场观察。

### 5.2 未上报离场修正（staleness decay）

玩家常**打完直接走、不报数**，导致报数系统性偏高。设距上次上报 \(\Delta t_u\) 分钟，有效队列按指数衰减：

\[
Q_{\text{eff}} = Q \cdot \exp\left(-\frac{\max(0,\, \Delta t_u - 5)}{90}\right)
\]

（5 分钟内视为新鲜；时间常数 90 分钟。）例如报数 12 人（\(C=8\)、\(Q=4\)）在 60 分钟前上报，实际按 \(Q_{\text{eff}} \approx 2.2\) 估算。

### 5.3 等待公式

机台错峰结束，新到玩家平均额外等待约 0.45 轮：

\[
W_{\text{formula}} = \mathrm{round}\left(T_{\text{round}}(\kappa) \cdot \left(\frac{Q_{\text{eff}}}{m \cdot g(\kappa)} + 0.45\right)\right)
\]

### 5.4 仿真辅助（受限）

离场速率 \(\mu\) 已学到时：

\[
W_{\text{sim}} = \min\Big(\frac{Q_{\text{eff}}}{\mu}\times 60,\; 1.15\,W_{\text{formula}} + 3\Big)
\]

### 5.5 融合与软上限

\[
\hat{W} = \min\Big(\mathrm{round}(0.75\,W_{\text{formula}} + 0.25\,W_{\text{sim}}),\; 22 + 5\max(0,\lceil Q/C\rceil - 1)\Big)
\]

**典型输出**（4 台机、\(C = 8\)、刚上报）：

| 报数 \(N\) | 9 | 10 | 12 | 14 | 16 |
|-----------|---|----|----|----|----|
| \(\hat{W}\)（分钟） | 9 | 12 | 16 | 21 | 22 |

### 5.6 下次上机间隔

若用户刚下机：

\[
\hat{T}_{\text{next}} = \hat{W} + T_{\text{round}}(\kappa)
\]

游玩时长学习（用于展示与仿真速率兜底）：单次样本上限 22 分钟、事件间隔上限 45 分钟，防止把报卡间隔误当游玩时长。

### 5.4 下次上机间隔

若用户刚下机（`hasLastPlayTime`）：

\[
\hat{T}_{\text{next}} = \hat{W} + T
\]

---

## 6. 人数预测（核心）

### 6.1 加权线性回归（短期趋势）

取近 12 小时内可信事件。优先使用与**当前日类型相同**的样本（若 \(\ge 4\) 条），否则使用全部近期样本。

构造加权最小二乘（WLS）点集 \(\{(x_j, y_j, w_j)\}\)：

\[
x_j = \frac{t_j - t_{\text{cut}}}{3600\ \text{s}}, \quad y_j = N_j, \quad w_j = e^{-\text{age}_j / 6}
\]

其中 \(\text{age}_j\) 为样本距今小时数（**6 小时半衰期**）。当前点 \((x_0, N_0, w=1.2)\) 一并纳入。

WLS 闭式解：

\[
\hat{\beta}_1 = \frac{(\sum w)(\sum wxy) - (\sum wx)(\sum wy)}{(\sum w)(\sum wx^2) - (\sum wx)^2}, \quad
\hat{\beta}_0 = \frac{\sum wy - \hat{\beta}_1 \sum wx}{\sum w}
\]

未来 \(\tau\) 分钟时：

\[
\hat{N}_{\text{reg}}(\tau) = \hat{\beta}_0 + \hat{\beta}_1 \cdot \left( x_0 + \frac{\tau}{60} \right)
\]

残差均值给出置信区间半宽 \(\text{margin}\)。

### 6.2 时段画像（长期模式）

\[
\hat{N}_{\text{prof}}(\tau) = \text{profile}(t_0 + \tau)
\]

### 6.3 混合预测

令远期进度 \(p = \min(1,\; \tau / H_{\text{min}})\)（\(H_{\text{min}} \ge 60\) 分钟）。画像权重：

\[
w_p = \begin{cases}
0 & \hat{N}_{\text{prof}} = 0 \\
0.15 + 0.65p & \text{otherwise}
\end{cases}
\]

\[
\hat{N}_{\text{blend}} = (1 - w_p)\,\hat{N}_{\text{reg}} + w_p\,\hat{N}_{\text{prof}}
\]

### 6.4 营业与宽容修正

- 若 \(t_0+\tau\) 不在 `isOperatingOrGrace` 内：\(\hat{N} = 0\)
- 若在宽容期：\(\hat{N}_{\text{blend}} \leftarrow \hat{N}_{\text{blend}} \cdot (1 - \gamma(t))\)
- 钳制：\(\hat{N} \leftarrow \min(\hat{N}, N_{\max})\)，再取 \(\max(0, \text{round}(\cdot))\)

### 6.5 序列平滑

对 \(k=1,\ldots,K\) 个未来步长的原始 \(\hat{N}_k\) 做窗口为 3 的移动平均 `smoothSeries`，再与单点衰减取 \(\min\)（宽容期内保证单调向 0）。

默认 \(K = H \times 60 / 30 = 16\)（8 小时、30 分钟步长）。

---

## 7. 出勤推荐

在预测序列 \(\{\hat{N}_k\}\) 中，**优先**筛选正式营业时段且 \(\hat{N}_k > 0\) 的点；若无则退回宽容期。

评分（越低越优）：

\[
\text{score}_k = \hat{N}_k + \mathbb{1}[\hat{N}_k > C] \cdot 2
\]

取 \(\tau^\* = \arg\min_k \text{score}_k\)，生成自然语言推荐理由（是否低于容量、是否少于当前人数等）。

---

## 8. 置信度

启发式分数（上限 85%）：

\[
\text{conf} = \text{clip}_{[8,85]}\Big(
  \text{cap}(\text{samples}) \cdot (0.5 + 0.5 \cdot \rho_{\text{op}})
\Big)
\]

其中：

- 基础分 12；模型样本 + 近 12h 密度 + Nearcade 来源加分
- \(\rho_{\text{op}}\)：近 24h 事件中落在营业时段的比例
- 近 12h 样本 \(<4\) 时强制 \(\le 35\%\)，以此类推阶梯上限
- 未启用学习模型时 \(\le 40\%\)

---

## 9. 可视化

### 9.1 历史曲线（24h）

- 窗口：\([t_0 - 24\text{h},\, t_0]\)
- 仅使用可信事件；在营业+宽容时段内做**前向保持**（30 分钟步长），空档维持上一观测值
- 夜间闭店段不填充 → 曲线自然断开

### 9.2 预测曲线（8h）

- 0 值点不绘制（文字表亦省略）
- Catmull-Rom 样条平滑（`smoothPath`）

### 9.3 压缩断轴

时间轴按数据段自适应：空档 \(>75\) 分钟折叠为固定 28px 窄带，标注 `…Xh` 省略时长；有数据段按真实时长比例分配像素，刻度密度自适应（30 分钟–8 小时档位）。

---

## 10. 超参数一览

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `EMA_ALPHA` | 0.12 | 在线学习率 |
| `MAX_EVENTS_PER_ARCADE` | 1000 | 每厅事件上限 |
| `forecastHours` | 8 | 预测时长 |
| `forecastStepMinutes` | 30 | 预测步长 |
| `DEFAULT_HISTORY_HOURS` | 24 | 图表历史窗口 |
| 回归窗口 | 12h | 趋势拟合 |
| 回归半衰期 | 6h | 样本时间权重 |
| `operatingOpenHour` | 10 | 全局营业开始 |
| `operatingCloseHour` | 23 | 全局营业结束（含） |
| `operatingCloseGraceMinutes` | 90 | 闭店宽容 |
| 平滑窗口 | 3 | 预测序列 |
| 单轮时长 | 14 / 17 分钟 | 1P / 2P（随拥挤度插值） |
| 每台混合人数 | 1.3 → 2.0 | 随拥挤度插值 |
| 错峰余量 | 0.45 轮 | 机台错峰结束 |
| 陈旧衰减常数 | 90 分钟 | 未上报离场修正 |
| 公式/仿真融合 | 0.75 / 0.25 | 等待时间 |
| 等待软上限 | 22 + 5/轮 | 常态 ≤22 分钟 |
| 画像权重 | 0.15 → 0.80 | 随远期线性增加 |

机厅级可覆盖 `operatingOpenHour`、`operatingCloseHour`、`operatingCloseGraceMinutes`；未配置则继承全局。

---

## 11. 局限与假设
1. **离散上报**：非均匀采样；依赖前向保持与 EMA 缓解，但无法捕捉亚小时级突发。未上报离场以指数衰减近似，无法精确还原真实在场人数。
2. **独立机厅**：不建模厅间迁移或节假日特殊日。
3. **容量静态**：\(C = m \cdot p\) 不随机台故障变化。
4. **线性趋势**：WLS 对强非线性客流（如活动日）可能欠拟合；画像项起长期校正作用。
5. **Nearcade 历史**：仅当日 `reported[]` 可导入，无全量 API。
6. **仅供参考**：输出附带免责声明；置信度为启发式，非统计置信区间。

---

## 12. 参考文献（概念来源）

- **指数加权移动平均（EMA）**：经典在线平滑，用于速率与时段画像。
- **加权最小二乘（WLS）**：近期样本主导的趋势外推。
- **M/M/c 排队论启发**：公式法与离场速率仿真。
- **断轴时间轴（axis break）**：科学图表中压缩无数据区间的常见做法。
- **机厅群**：我给群友蒸馏了。

---

## 附录 A：本地验证

```bash
npm run test:predict
```

沙盒脚本 `scripts/test-predict.js` 自动校验：24h 窗口、前向保持、断轴省略、凌晨清零防护、宽容期衰减、预测标签间距、0 值省略等。

---

## 附录 B：相关源码

| 文件 | 职责 |
|------|------|
| `src/predictor.ts` | 学习、等待时间、人数预测、推荐 |
| `src/event-quality.ts` | 营业时段、宽容期、可信性、清零识别 |
| `src/chart.ts` | SVG/PNG 趋势图、断轴、前向保持 |
| `src/index.ts` | `predict` 命令、配置、模板渲染 |
