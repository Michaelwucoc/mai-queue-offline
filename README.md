# koishi-plugin-mai-queue

舞萌DX排卡状态报告插件，支持在QQ群内上报和查询机厅的排队状态。

## 功能特性

- ✅ 支持机厅别名系统，一个机厅可以设置多个别名
- ✅ 灵活的人数上报格式（别名数字、别名+数字、别名-数字、别名=数字）
- ✅ 自动计算排队时间和上机时间
- ✅ 支持自定义消息模板
- ✅ 群白名单机制，防止串号
- ✅ 店铺通知功能
- ✅ **TurboAPI支持**：支持TurboAPI数据获取，可显示实时玩家数、游玩次数等统计信息

## 安装

```bash
npm install koishi-plugin-mai-queue
```

## 配置

在 Koishi 配置文件中添加插件配置：

```yaml
plugins:
  mai-queue:
    defaultMachineCount: 5          # 默认机台数量
    defaultPlayTimePerPerson: 15    # 平均每人游玩时间（分钟）
    playersPerMachine: 2            # 每台机器可同时游玩人数
    turboApiKey: ""                 # TurboAPI授权密钥（格式：直接填写密钥，例如：979c5f40-130f-4246-94bd-6b2973040b5e）
    arcades:
      wujiaochang:                  # 机厅ID
        config:
          name: 上海五角场百联 ZX 造趣场 AKIBAGO
          aliases:                  # 别名列表
            - wjc
            - 五角场
          machineCount: 5           # 机台数量
          notice: 冬暖夏暖，记得备短袖。最近已改良通风！  # 店铺通知
          groupWhitelist:           # 群白名单（为空则允许所有群）
            - "123456789"
          enableTurbo: false        # 是否启用Turbo兼容
          turboName: ""             # Turbo机厅名称（启用Turbo时必填）
        status:
          currentCount: 0           # 当前人数
          updateTime: ""            # 更新时间
          updaterName: ""           # 更新玩家昵称
          updaterId: ""             # 更新玩家QQ号
```

## 使用方法

### 人数上报

直接输入格式即可，无需命令：

- `别名数字` - 设置人数，例如：`yf1` 表示设置悠方店为1人
- `别名+数字` - 增加人数，例如：`yf+1` 表示悠方店加1人
- `别名-数字` - 减少人数，例如：`yf-1` 表示悠方店减1人
- `别名=数字` - 设置人数（等同于别名数字），例如：`yf=5` 表示设置悠方店为5人

**使用示例：**

```
yf1       # 设置悠方店为1人
yf+1      # 悠方店加1人
yf-1      # 悠方店减1人
yf=5      # 设置悠方店为5人
```

### 查询状态

直接输入格式即可，无需命令：

- `别名几` - 查询状态，例如：`yf几`
- `别名j` - 查询状态，例如：`yfj`

**使用示例：**

```
yf几      # 查询悠方店状态
yfj       # 查询悠方店状态
```

**注意**：使用 `别名几` 或 `别名j` 格式查询时，如果群不在白名单中，消息会被忽略（不会回复）。人数上报也会检查白名单。

### 管理命令

#### 标记刚下机

```
arcade.finish <别名>
```

标记刚下机后，查询时会显示从上次上机到下次大约需要的时间。

**注意**：机厅配置（名称、别名、机台数量、店铺通知、白名单、消息模板等）需要通过配置文件管理，修改配置后需要重启插件才能生效。命令只能用于查询和上报状态，不能修改配置。

## 消息格式

默认消息格式：

```
→ OK！查到了！

- 上海五角场百联 ZX 造趣场 AKIBAGO //店铺名字
目前人数: 99 人 (12 分钟前) 
机台数量: 5 台
更新时间: 2025-12-06 11:55:48
更新玩家: 用户昵称(QQ号)
店铺通知: 
　　冬暖夏暖，记得备短袖。最近已改良通风！

现在出勤大约需要 148 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 164 分钟
```

每个机厅可以自定义消息模板，在配置文件的 `queryMessageTemplate` 和 `reportMessageTemplate` 字段中设置。

### 基础变量（所有机厅可用）

- `{name}` - 机厅名称
- `{currentCount}` - 当前人数
- `{machineCount}` - 机台数量
- `{updateTime}` - 更新时间
- `{updaterName}` - 更新玩家昵称
- `{updaterId}` - 更新玩家QQ号
- `{updaterInfo}` - 更新玩家信息（格式：昵称(QQ号)）
- `{notice}` - 店铺通知
- `{waitTime}` - 排队时间（分钟）
- `{nextPlayTime}` - 从上次上机到下次的时间（分钟）
- `{minutesAgo}` - 距离更新的分钟数
- `{diff}` - 人数变化（仅在上报消息模板中可用，格式：+1、-1等）

### Turbo变量（仅当 `enableTurbo: true` 时可用）

#### 玩家统计数据
- `{thirtyMinutesPlayer}` - 30分钟内玩家数
- `{oneHourPlayer}` - 1小时内玩家数
- `{twoHoursPlayer}` - 2小时内玩家数

#### 游玩次数统计
- `{thirtyMinutesPlayCount}` - 30分钟内游玩次数
- `{oneHourPlayCount}` - 1小时内游玩次数
- `{twoHoursPlayCount}` - 2小时内游玩次数

#### 玩家列表
- `{recentPlayername}` - 最近玩家列表（从playerList提取，每行前面两个空格）
- `{recentPlayername_thirty}` - 最近30分钟玩家列表（从thirtyMinutesPlayerList提取，每行前面两个空格）

#### 机厅统计数据
- `{arcadePlayCount}` - 机厅游玩次数
- `{arcadeRequested}` - 机厅请求数
- `{arcadeCachedRequest}` - 缓存请求数
- `{arcadeFixedRequest}` - 固定请求数
- `{arcadeCachedHitRate}` - 缓存命中率（自动转换为百分比，保留2位小数，例如：64.92%）

**注意**：Turbo变量仅在机厅配置了 `enableTurbo: true` 且配置了 `turboApiKey` 时才会显示实际数据，否则显示默认值（数字为0，列表为空，命中率为0%）。

## 时间计算说明

- **平均每人游玩时间**：默认15分钟（可在配置中修改）
- **每台机器可同时游玩人数**：默认2人（可在配置中修改）
- **排队时间计算**：基于机台数量和当前人数计算
- **上机时间计算**：如果标记了刚下机，会在排队时间基础上加上游玩时间

## TurboAPI配置

### 启用TurboAPI支持

1. **配置全局TurboAPI密钥**：
   ```yaml
   turboApiKey: "979c5f40-130f-4246-94bd-6b2973040b5e"  # 直接填写密钥，无需添加"BotKey"前缀
   ```

2. **为机厅启用Turbo兼容**：
   ```yaml
   arcades:
     liehuo:
       config:
         name: 上海街机烈火
         enableTurbo: true              # 启用Turbo兼容
         turboName: "上海街机烈火"       # Turbo系统中的机厅名称（必须完全一致）
   ```

3. **在消息模板中使用Turbo变量**：
   ```yaml
   queryMessageTemplate: |
     → OK！查到了！
     
     - {name}
     目前人数: {currentCount} 人
     
     [Turbo数据]
     30分钟玩家数: {thirtyMinutesPlayer}
     缓存命中率: {arcadeCachedHitRate}
     最近玩家:
     {recentPlayername}
   ```

### TurboAPI说明

- TurboAPI是舞萌DX加速器，能加速加载时间和获取更多数据
- 启用Turbo后，查询和上报时会自动调用TurboAPI获取实时数据
- 如果API请求失败，Turbo变量会显示默认值，不影响基础功能
- 非Turbo机厅不受影响，正常工作

## 配置管理

**重要**：所有机厅配置（名称、别名、机台数量、店铺通知、白名单、消息模板、Turbo设置等）需要通过配置文件管理：

1. 在配置文件的 `arcades` 字段中添加或修改机厅配置
2. 修改配置后需要重启插件才能生效
3. 状态数据（当前人数、更新时间等）会持久化保存到 `data/mai-queue-status.yml` 文件中

## 注意事项

1. **配置管理**：机厅配置必须通过配置文件设置，命令只能用于查询和上报状态
2. **群白名单**：白名单为空时，所有群都可以使用该机厅的功能；不为空时，只有白名单中的群才能使用
3. **别名**：不区分大小写
4. **人数**：不能为负数（减少时会自动限制为0）
5. **自动重置**：每天凌晨12点自动将所有机厅人数重置为0

## 开发

```bash
# 构建
npm run build

# 开发模式（监听文件变化）
npm run dev
```

## License

MIT

