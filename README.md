# koishi-plugin-mai-queue

舞萌DX排卡状态报告插件，支持 QQ 群查/报卡，并可同步到 [Nearcade](https://nearcade.cn)。

## 配置

```yaml
plugins:
  mai-queue:
    nearcadeApiToken: ""              # 全局 Token，启用同步时必填
    nearcadeBaseUrl: "https://nearcade.cn"
    nearcadeBotName: "mai-queue"      # 写入 Nearcade 同步备注的 Bot 名
    nearcadeRequestTimeoutMs: 5000    # Nearcade 请求超时；失败/超时后查卡回退本地
    enableWeather: true               # 全局开启出勤天气预报
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
          weatherLocation: 上海市嘉定区  # 建议改用 weatherCity + weatherDistrict
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
| `weatherLatitude` / `weatherLongitude` | 天气坐标（最高优先，最准） |
| `weatherCity` | 城市，如 `上海`（未填经纬度时用） |
| `weatherDistrict` | 可选区/县，如 `静安` / `嘉定区`（配合 city，优先区级坐标） |
| `weatherLocation` | 兼容旧字段：单行地名（建议改用 city+district） |
| `enableWeather` | 机厅级天气开关（可选，跟随全局） |

## 使用

```
yf1          # 设为 1 人
yf+1         # 加 1 人
yf几         # 查询（有恶劣天气时自动附带提醒）
predict yf   # 预测等待时间与人数趋势（含趋势图）
weather yf   # 查看机厅今日天气
subweather yf        # 本群订阅 yf 机厅天气推送
unsubweather yf      # 取消订阅
subweather list      # 查看本群订阅
nearcade.search 悠方   # 管理员：查机厅 ID
```

## 天气预报

数据源（优先级）：

- **已配置和风**：实况 / 逐小时 / 逐日走和风；**预警走新版** `/weatheralert/v1/current/{纬度}/{经度}`（旧版 `/v7/warning/now` 仅作回退）；失败时回退 Open-Meteo
- **未配置和风**：Open-Meteo 免费预报

### 和风天气配置

在[和风控制台](https://console.qweather.com/)创建项目，获取**专属 API Host**。

**方式 A：JWT（推荐）**

```yaml
qweatherApiHost: "abcxyz.qweatherapi.com"   # 项目专属域名
qweatherProjectId: "12345ABCDE"             # Project ID (JWT sub)
qweatherCredentialId: "ABCDE12345"          # Credential ID (JWT kid)
qweatherPrivateKey: |
  -----BEGIN PRIVATE KEY-----
  MC4CAQAwBQYDK2VwBCIEI...
  -----END PRIVATE KEY-----
qweatherAuthMode: auto                      # auto / jwt / apikey
```

**方式 B：API Key**

```yaml
qweatherApiHost: "abcxyz.qweatherapi.com"
qweatherApiKey: "your-api-key"
qweatherAuthMode: apikey
```

注意：JWT 与 API Key **不要同时使用**。`auto` 模式下有 JWT 配置则优先 JWT。

### 全局开关

```yaml
enableWeather: true
weatherLookAheadHours: 4          # 查卡关注未来 N 小时
weatherCacheMinutes: 15
weatherAlertPollMinutes: 30       # 恶劣天气/预警主动推送轮询
enableWeatherDailyDigest: true    # 订阅群是否默认每日推送
weatherDailyDigestHour: 10        # 每日摘要小时（默认 10）
qweatherApiKey: ""                # API Key 认证（与 JWT 二选一）
qweatherApiHost: ""               # 和风专属 API Host
qweatherProjectId: ""             # JWT sub
qweatherCredentialId: ""        # JWT kid
qweatherPrivateKey: ""            # Ed25519 私钥 PEM
qweatherAuthMode: auto            # auto / jwt / apikey
```

### 如何配置机厅区域

优先级：**经纬度 > 城市+区 > 仅城市 > 旧字段 weatherLocation**。

| 字段 | 说明 |
|------|------|
| `weatherLatitude` + `weatherLongitude` | 最准。地图取机厅门口坐标 |
| `weatherCity` | 城市，如 `上海`、`杭州` |
| `weatherDistrict` | **可选**区/县，如 `静安`、`嘉定区`、`南山`。有则优先解析到区 |
| `weatherLocation` | 兼容旧配置（如 `上海市静安区`），会尽量拆成市+区 |
| `enableWeather` | 可选。机厅级覆盖：`false` 关闭该厅 |

```yaml
arcades:
  liehuo:
    config:
      name: 街机烈火
      aliases: [lh, 烈火]
      # 方式 1：经纬度（推荐）
      weatherLatitude: 31.230
      weatherLongitude: 121.456
  youfang:
    config:
      name: 悠方星河奇迹体验馆
      aliases: [yf, 悠方]
      # 方式 2：城市 + 区（区可选）
      weatherCity: 上海
      weatherDistrict: 嘉定        # 可写「嘉定」或「嘉定区」
  wujiaochang:
    config:
      name: 五角场...
      aliases: [wjc]
      # 方式 3：仅城市（用市中心）
      weatherCity: 上海
```

区级解析走 Photon（OSM）；失败时自动回退到该市中心，并在解析名里标明。取经纬度时，国内地图多为 GCJ-02，与预报用的 WGS-84 可能有几十米偏差，机厅场景一般可忽略。

### 群内效果

- **查卡**（`yf几`）：未来几小时有雨/雷/预警时，在回复末尾追加，例如  
  `🌧 4小时内可能有 小雨 哦，出勤记得带伞！`  
  `⚡️ 4小时内可能有 雷暴！不建议出勤...`
- **订阅推送**：`subweather yf` 后，有预警或恶劣天气时主动推群；可选每日 10 点摘要
- 订阅持久化在 `data/mai-queue-weather.yml`

模板可用 `{weather}` 占位；若不写，有提醒时会自动追加到查卡消息末尾。

## 预测模型

每个机厅独立维护历史队列数据（`data/mai-queue-history.yml`），在群友报卡时自动学习。算法细节见 **[docs/PREDICTION_ALGORITHM.md](docs/PREDICTION_ALGORITHM.md)**（含公式、数据质量、等待时间与人数预测、图表断轴等完整说明）。

概要：

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

天气：`{weather}`（异常天气提醒文案；模板未写时会自动追加）

每台机厅可单独配置 `queryMessageTemplate`、`reportMessageTemplate`、`predictMessageTemplate`。

启用 Nearcade 时，`{currentCount}` 优先取平台人数；拉取失败或无数据时回退本地。

同步成功 → `已同步到 Nearcade NET.`；失败 → `暂时无法连接到 Nearcade NET.`

## 开发

```bash
npm run build
```

## License

MIT
