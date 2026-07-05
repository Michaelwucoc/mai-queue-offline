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
yf1      # 设为 1 人
yf+1     # 加 1 人
yf几     # 查询
nearcade.search 悠方   # 管理员：查机厅 ID
```

## 模板变量

基础：`{name}` `{currentCount}` `{waitTime}` `{notice}` `{address}` `{directionGuide}` 等

Nearcade：`{nearcadeCount}` `{nearcadeDiff}` `{nearcadeLink}` `{nearcadeSyncStatus}`

启用 Nearcade 时，`{currentCount}` 优先取平台人数；拉取失败或无数据时回退本地。

同步成功 → `已同步到 Nearcade NET.`；失败 → `暂时无法连接到 Nearcade NET.`

## 开发

```bash
npm run build
```

## License

MIT
