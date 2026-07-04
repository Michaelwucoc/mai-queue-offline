# koishi-plugin-mai-queue

舞萌DX排卡状态报告插件，支持在QQ群内上报和查询机厅的排队状态，并可同步到 [Nearcade](https://nearcade.cn)。

## 功能特性

- ✅ 支持机厅别名系统，一个机厅可以设置多个别名
- ✅ 灵活的人数上报格式（别名数字、别名+数字、别名-数字、别名=数字）
- ✅ 自动计算排队时间和上机时间
- ✅ 支持自定义消息模板
- ✅ 群白名单机制，防止串号
- ✅ 店铺通知、地址、到店引导等机厅专属内容
- ✅ **Nearcade 同步**：查询拉取平台人数，上报自动同步到 Nearcade NET

## 安装

```bash
npm install koishi-plugin-mai-queue
```

## 配置

```yaml
plugins:
  mai-queue:
    defaultMachineCount: 5
    defaultPlayTimePerPerson: 15
    playersPerMachine: 2
    nearcadeApiToken: ""              # Nearcade Bearer Token（上报同步必填）
    nearcadeBaseUrl: "https://nearcade.cn"  # 可自定义服务地址
    arcades:
      liehuo:
        config:
          name: 街机烈火
          aliases: [lh, 烈火]
          machineCount: 8
          address: 上海市静安区江宁路77号恒顺大楼4层
          directionGuide: |
            南京西路地铁站1号口步行430米
          notice: 欢迎来到烈火！
          groupWhitelist: []
          enableNearcade: true
          nearcadeId: 10001           # 使用 nearcade.search 命令查找
          nearcadeSource: bemanicn    # 下拉：bemanicn | ziv
          nearcadeGameType: 1         # 下拉：机种 titleId，1=舞萌 DX
```

### Nearcade 机种下拉（nearcadeGameType）

| 值 | 机种 |
|----|------|
| 1 | 舞萌 DX |
| 3 | 中二节奏 |
| 4 | SOUND VOLTEX |
| 5 | beatmania IIDX |
| 6 | jubeat |
| 8 | GuitarFreaks / DrumMania |

插件会按 `titleId` 自动解析该机厅的 `gameId`，一般无需手动填写 `nearcadeGameIdOverride`。

## 使用方法

### 人数上报

```
yf1       # 设置悠方店为1人
yf+1      # 悠方店加1人
yf-1      # 悠方店减1人
yf=5      # 设置悠方店为5人
```

### 查询状态

```
yf几      # 查询悠方店状态
yfj       # 查询悠方店状态
```

### 管理员命令

```
nearcade.search 烈火
```

返回机厅 `nearcadeId` 及各机种的 `titleId` / `gameId`，便于填写配置。

## 模板变量

### 基础变量

- `{name}` `{currentCount}` `{machineCount}` `{updateTime}`
- `{updaterName}` `{updaterId}` `{updaterInfo}`
- `{notice}` `{address}` `{directionGuide}`
- `{waitTime}` `{nextPlayTime}` `{minutesAgo}` `{diff}` `{xql_num}`

### Nearcade 变量

- `{nearcadeCount}` — 平台出勤人数（按所选机种）
- `{nearcadeTotal}` — 平台响应 total
- `{nearcadeDiff}` — 本地人数与平台人数之差
- `{nearcadeLink}` — 机厅页链接（基于 nearcadeBaseUrl）
- `{nearcadeSyncStatus}` — 上报同步成功时为 `已同步到 Nearcade NET.`，否则留空

空字段（地址、引导、链接、同步状态）会在消息中自动隐藏对应段落。

## Nearcade API

与官方 [`nonebot-plugin-nearcade-reporter`](https://pypi.org/project/nonebot-plugin-nearcade-reporter/) 一致：

| 方法 | 路径 |
|------|------|
| GET | `/api/shops?q=&page=&limit=` |
| GET | `/api/shops/{source}/{id}/attendance` |
| POST | `/api/shops/{source}/{id}/attendance` |

## 开发

```bash
npm run build
npm run dev
```

## License

MIT
