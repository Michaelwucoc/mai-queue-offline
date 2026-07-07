# koishi-plugin-mai-queue

舞萌DX排卡状态报告插件，支持 QQ 群查/报卡，并可同步到 [Nearcade](https://nearcade.cn)。

## 配置

```yaml
plugins:
  mai-queue:
    nearcadeApiToken: ""              # 全局 Token，启用同步时必填
    nearcadeBaseUrl: "https://nearcade.cn"
    nearcadeBotName: "mai-queue"      # 写入 Nearcade 同步备注的 Bot 名
    arcades:
      youfang:
        config:
          name: 悠方星河奇迹体验馆
          aliases: [yf, 悠方]
          machineCount: 4
          notice: 店铺通知（可选）
          groupWhitelist: []          # 空 = 所有群可用
          enableNearcade: true        # 是否同步 Nearcade
          nearcadeId: 16342           # nearcade.search 查询
          nearcadeTitleId: 1          # 机种下拉，默认舞萌 DX
```

### 机厅常用字段

| 字段 | 说明 |
|------|------|
| `name` / `aliases` | 机厅名与别名 |
| `machineCount` | 机台数 |
| `notice` | 店铺通知 |
| `address` / `directionGuide` | 地址、到店引导（可选） |
| `groupWhitelist` | 群白名单 |
| `enableNearcade` + `nearcadeId` | Nearcade 同步 |
| `nearcadeTitleId` | Nearcade 机种（控制台下拉；默认 1=舞萌 DX） |

## 使用

```
yf1          # 设为 1 人
yf+1         # 加 1 人
yf几         # 查询
predict yf   # 预测等待时间与人数趋势（含趋势图）
nearcade.search 悠方   # 管理员：查机厅 ID
```

## 预测模型

每个机厅独立维护历史队列数据（`data/mai-queue-history.yml`），在群友报卡时自动学习：

- **队列仿真**：根据到达/离开速率估算等待时间
- **线性回归 + 周中/周末时段模型**：分日类型学习 24 小时画像，预测未来 8 小时（每 30 分钟一个点）
- **时段模式**：按小时统计历史均值，识别高峰/低谷
- **Nearcade 融合**：从 `GET /api/shops/{id}/attendance` 的 `reported` 字段导入当日上报记录（MongoDB 全量历史暂无公开 API）

`predict <别名>` 会发送逐时预测表 + 推荐出勤时段 + 趋势图。结果含「仅供参考」说明。

```yaml
forecastHours: 8          # 预测时长（小时）
forecastStepMinutes: 30   # 采样密度（分钟）
```

### 页脚（可选，默认关闭）

```yaml
enableMessageFooter: true
messageFooter: "Made By Milk with ❤️ | awmc.cc | v2.1.0"
```

模板中使用 `{footer}` 占位；`enableMessageFooter` 默认为 `false`，不影响旧配置。

## 模板变量

基础：`{name}` `{displayName}` `{gameTitle}` `{currentCount}` `{waitTime}` `{notice}` `{footer}` 等

预测：`{confidence}` `{forecastHours}` `{forecastSchedule}` `{forecastRecommendation}` `{predictedCount}` `{predictedRange}` `{trendDesc}` `{predictionMethod}` `{nearcadeDataPoints}` `{avgPlayMinutes}`

Nearcade：`{nearcadeCount}` `{nearcadeDiff}` `{nearcadeLink}` `{nearcadeSyncStatus}`

每台机厅可单独配置 `queryMessageTemplate`、`reportMessageTemplate`、`predictMessageTemplate`。

启用 Nearcade 时，`{currentCount}` 优先取平台人数；拉取失败或无数据时回退本地。

同步成功 → `已同步到 Nearcade NET.`；失败 → `暂时无法连接到 Nearcade NET.`

## 开发

```bash
npm run build
```

## License

MIT
