import { Context, Schema } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import yaml from 'js-yaml'

export const name = 'mai-queue'

export interface ArcadeConfig {
  /** 机厅名称 */
  name: string
  /** 机厅别名列表 */
  aliases: string[]
  /** 机台数量 */
  machineCount: number
  /** 店铺通知内容 */
  notice: string
  /** 允许使用的群列表（白名单） */
  groupWhitelist: string[]
  /** 查询消息模板（可选） */
  queryMessageTemplate?: string
  /** 上报消息模板（可选） */
  reportMessageTemplate?: string
}

export interface ArcadeStatus {
  /** 当前人数 */
  currentCount: number
  /** 更新时间 */
  updateTime: string
  /** 更新玩家昵称 */
  updaterName: string
  /** 更新玩家QQ号 */
  updaterId: string
  /** 上次上机时间（如果刚下机） */
  lastPlayTime?: string
}

export interface ArcadeData {
  config: ArcadeConfig
  status: ArcadeStatus
}

export const Config: Schema<{
  arcades: Record<string, { config: ArcadeConfig }>
  defaultMachineCount: number
  defaultPlayTimePerPerson: number
  playersPerMachine: number
}> = Schema.object({
  arcades: Schema.dict(Schema.object({
    config: Schema.object({
      name: Schema.string().required().description('机厅名称'),
      aliases: Schema.array(Schema.string()).default([]).description('机厅别名列表（支持多个别名，例如：["wjc", "五角场"]）'),
      machineCount: Schema.number().default(5).description('机台数量'),
      notice: Schema.string().default('').description('店铺通知内容（可选，例如：冬暖夏暖，记得备短袖）'),
      groupWhitelist: Schema.array(Schema.string()).default([]).description('群白名单（为空则允许所有群使用，例如：["123456789", "987654321"]）'),
      queryMessageTemplate: Schema.string().role('textarea').default(`→ OK！查到了！

- {name}
目前人数: {currentCount} 人 ({minutesAgo} 分钟前)
机台数量: {machineCount} 台
更新时间: {updateTime}
更新玩家: {updaterInfo}
店铺通知: 
　　{notice}
现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟`).description('查询消息模板（可用变量：{name}, {currentCount}, {machineCount}, {updateTime}, {updaterName}, {updaterId}, {updaterInfo}, {notice}, {waitTime}, {nextPlayTime}, {minutesAgo}）'),
      reportMessageTemplate: Schema.string().role('textarea').default(`→ 已更新！

- {name}
目前人数: {currentCount} 人 ({minutesAgo} 分钟前)
机台数量: {machineCount} 台
更新时间: {updateTime}
更新玩家: {updaterInfo}
店铺通知: 
　　{notice}
现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟`).description('上报消息模板（可用变量：{name}, {currentCount}, {machineCount}, {updateTime}, {updaterName}, {updaterId}, {updaterInfo}, {notice}, {waitTime}, {nextPlayTime}, {minutesAgo}）'),
    }).description('机厅配置'),
  })).description('机厅数据（键名为机厅ID，例如：wujiaochang）'),
  defaultMachineCount: Schema.number().default(5).description('默认机台数量（新机厅的默认值）'),
  defaultPlayTimePerPerson: Schema.number().default(15).description('平均每人游玩时间（分钟，用于计算排队时间）'),
  playersPerMachine: Schema.number().default(2).description('每台机器可同时游玩人数'),
}).description('舞萌DX排卡状态报告插件配置')

export function apply(ctx: Context, config: any) {
  let { arcades: arcadesConfig, defaultMachineCount, defaultPlayTimePerPerson, playersPerMachine } = config

  // 将配置转换为运行时数据结构（添加status字段）
  const arcades: Record<string, ArcadeData> = {}
  for (const [id, data] of Object.entries(arcadesConfig)) {
    const arcadeConfig = data as { config: ArcadeConfig }
    // 从配置中读取status（如果存在），否则创建默认status
    const existingStatus = (data as any).status as ArcadeStatus | undefined
    arcades[id] = {
      config: arcadeConfig.config,
      status: existingStatus || {
        currentCount: 0,
        updateTime: '',
        updaterName: '',
        updaterId: '',
      }
    }
  }

  // 构建别名到机厅ID的映射
  function rebuildAliasMap() {
    const map = new Map<string, string>()
    for (const [id, data] of Object.entries(arcades)) {
      const arcade = data as ArcadeData
      for (const alias of arcade.config.aliases) {
        map.set(alias.toLowerCase(), id)
      }
    }
    return map
  }

  let aliasMap = rebuildAliasMap()

  // 获取数据文件路径
  function getDataFilePath(): string {
    // 使用 Koishi 的数据目录
    const baseDir = ctx.baseDir || process.cwd()
    const dataDir = path.join(baseDir, 'data')
    // 确保数据目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    return path.join(dataDir, 'mai-queue-status.yml')
  }

  // 保存状态数据到 yml 文件
  async function saveStatusToFile() {
    try {
      const dataFilePath = getDataFilePath()
      const statusData: Record<string, ArcadeStatus> = {}
      
      // 收集所有机厅的状态数据
      for (const [id, arcade] of Object.entries(arcades)) {
        statusData[id] = arcade.status
      }
      
      // 转换为 yaml 格式
      const yamlContent = yaml.dump(statusData, {
        indent: 2,
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
      })
      
      // 写入文件
      fs.writeFileSync(dataFilePath, yamlContent, 'utf8')
      ctx.logger('mai-queue').debug('状态数据已保存到文件')
    } catch (error) {
      ctx.logger('mai-queue').error('保存状态数据失败:', error)
    }
  }

  // 从 yml 文件加载状态数据
  function loadStatusFromFile() {
    try {
      const dataFilePath = getDataFilePath()
      if (!fs.existsSync(dataFilePath)) {
        ctx.logger('mai-queue').debug('状态数据文件不存在，使用默认值')
        return
      }
      
      // 读取文件内容
      const fileContent = fs.readFileSync(dataFilePath, 'utf8')
      const statusData = yaml.load(fileContent) as Record<string, ArcadeStatus> | null
      
      if (!statusData || typeof statusData !== 'object') {
        ctx.logger('mai-queue').warn('状态数据文件格式错误，使用默认值')
        return
      }
      
      // 更新内存中的状态数据（优先使用数据文件中的数据）
      for (const [id, status] of Object.entries(statusData)) {
        if (arcades[id] && status) {
          arcades[id].status = {
            currentCount: typeof status.currentCount === 'number' ? status.currentCount : 0,
            updateTime: status.updateTime || '',
            updaterName: status.updaterName || '',
            updaterId: status.updaterId || '',
            lastPlayTime: status.lastPlayTime,
          }
        }
      }
      
      ctx.logger('mai-queue').debug('状态数据已从文件加载')
    } catch (error) {
      ctx.logger('mai-queue').error('加载状态数据失败:', error)
    }
  }

  // 更新状态（内部使用）
  // 注意：机厅配置（名称、别名、机台数量等）需要通过配置文件管理，修改后需重启插件
  // 状态数据（当前人数、更新时间等）会持久化保存到 yml 文件
  async function updateConfig() {
    // 保存状态数据到文件
    await saveStatusToFile()
  }

  // 初始化时加载状态数据
  loadStatusFromFile()

  // 检查群是否在白名单中
  function checkGroupWhitelist(arcadeId: string, groupId: string): boolean {
    const arcade = arcades[arcadeId]
    if (!arcade) return false
    if (arcade.config.groupWhitelist.length === 0) return true // 如果没有设置白名单，则允许所有群
    return arcade.config.groupWhitelist.includes(groupId)
  }

  // 获取机厅ID（通过别名）
  function getArcadeId(alias: string): string | null {
    const normalizedAlias = alias.toLowerCase()
    return aliasMap.get(normalizedAlias) || null
  }

  // 计算出勤时间（分钟）
  function calculateWaitTime(arcade: ArcadeData): number {
    const currentCount = arcade.status.currentCount
    const machineCount = arcade.config.machineCount || defaultMachineCount
    const totalCapacity = machineCount * playersPerMachine
    
    // 如果当前人数小于等于总容量，不需要等待
    if (currentCount <= totalCapacity) return 0
    
    // 计算排队人数（当前人数减去正在玩的人数）
    const queueLength = currentCount - totalCapacity
    
    // 计算需要等待的轮数（向上取整）
    const roundsNeeded = Math.ceil(queueLength / totalCapacity)
    
    // 等待时间 = 轮数 * 每轮时间（平均每人游玩时间）
    return roundsNeeded * defaultPlayTimePerPerson
  }

  // 计算从上次上机到下次的时间（分钟）
  function calculateNextPlayTime(arcade: ArcadeData): number | null {
    if (!arcade.status.lastPlayTime) return null
    const waitTime = calculateWaitTime(arcade)
    return waitTime + defaultPlayTimePerPerson
  }

  // 格式化时间
  function formatDateTime(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  // 生成查询消息（默认模板）
  function generateDefaultQueryMessage(arcadeId: string, arcade: ArcadeData): string {
    const { config, status } = arcade
    const waitTime = calculateWaitTime(arcade)
    const nextPlayTime = calculateNextPlayTime(arcade)
    
    let updateTimeStr = '未知'
    let minutesAgo = 0
    if (status.updateTime) {
      const updateTime = new Date(status.updateTime)
      const now = new Date()
      updateTimeStr = formatDateTime(updateTime)
      minutesAgo = Math.floor((now.getTime() - updateTime.getTime()) / 60000)
    }
    
    const updaterInfo = status.updaterName 
      ? `${status.updaterName}(${status.updaterId})`
      : '未知'

    let message = `→ OK！查到了！\n\n`
    message += `- ${config.name}\n`
    message += `目前人数: ${status.currentCount} 人`
    
    if (status.updateTime) {
      message += ` (${minutesAgo} 分钟前)`
    }
    message += `\n机台数量: ${config.machineCount || defaultMachineCount} 台\n`
    message += `更新时间: ${updateTimeStr}\n`
    message += `更新玩家: ${updaterInfo}\n`
    
    if (config.notice) {
      message += `店铺通知: \n　　${config.notice}\n`
    }
    
    message += `\n现在出勤大约需要 ${waitTime} 分钟才能上机`
    
    if (nextPlayTime !== null) {
      message += `\n\n若是刚刚下机，\n从上次上机到下次大约需要 ${nextPlayTime} 分钟`
    }
    
    return message
  }

  // 生成上报消息（默认模板）
  function generateDefaultReportMessage(arcadeId: string, arcade: ArcadeData): string {
    const { config, status } = arcade
    const waitTime = calculateWaitTime(arcade)
    const nextPlayTime = calculateNextPlayTime(arcade)
    
    let updateTimeStr = '未知'
    let minutesAgo = 0
    if (status.updateTime) {
      const updateTime = new Date(status.updateTime)
      const now = new Date()
      updateTimeStr = formatDateTime(updateTime)
      minutesAgo = Math.floor((now.getTime() - updateTime.getTime()) / 60000)
    }
    
    const updaterInfo = status.updaterName 
      ? `${status.updaterName}(${status.updaterId})`
      : '未知'

    let message = `→ 已更新！\n\n`
    message += `- ${config.name}\n`
    message += `目前人数: ${status.currentCount} 人`
    
    if (status.updateTime) {
      message += ` (${minutesAgo} 分钟前)`
    }
    message += `\n机台数量: ${config.machineCount || defaultMachineCount} 台\n`
    message += `更新时间: ${updateTimeStr}\n`
    message += `更新玩家: ${updaterInfo}\n`
    
    if (config.notice) {
      message += `店铺通知: \n　　${config.notice}\n`
    }
    
    message += `\n现在出勤大约需要 ${waitTime} 分钟才能上机`
    
    if (nextPlayTime !== null) {
      message += `\n\n若是刚刚下机，\n从上次上机到下次大约需要 ${nextPlayTime} 分钟`
    }
    
    return message
  }

  // 替换模板变量
  function replaceTemplateVariables(template: string, arcade: ArcadeData): string {
    const { config, status } = arcade
    const waitTime = calculateWaitTime(arcade)
    const nextPlayTime = calculateNextPlayTime(arcade)
    
    let updateTimeStr = '未知'
    let minutesAgo = 0
    if (status.updateTime) {
      const updateTime = new Date(status.updateTime)
      const now = new Date()
      updateTimeStr = formatDateTime(updateTime)
      minutesAgo = Math.floor((now.getTime() - updateTime.getTime()) / 60000)
    }
    
    const updaterInfo = status.updaterName 
      ? `${status.updaterName}(${status.updaterId})`
      : '未知'
    
    let message = template
    message = message.replace(/\{name\}/g, config.name)
    message = message.replace(/\{currentCount\}/g, status.currentCount.toString())
    message = message.replace(/\{machineCount\}/g, (config.machineCount || defaultMachineCount).toString())
    message = message.replace(/\{updateTime\}/g, updateTimeStr)
    message = message.replace(/\{updaterName\}/g, status.updaterName || '未知')
    message = message.replace(/\{updaterId\}/g, status.updaterId || '未知')
    message = message.replace(/\{updaterInfo\}/g, updaterInfo)
    message = message.replace(/\{notice\}/g, config.notice || '')
    message = message.replace(/\{waitTime\}/g, waitTime.toString())
    message = message.replace(/\{nextPlayTime\}/g, nextPlayTime?.toString() || '未知')
    message = message.replace(/\{minutesAgo\}/g, status.updateTime ? minutesAgo.toString() : '')
    
    // 处理条件显示：如果没有更新时间，移除 ( 分钟前) 部分
    if (!status.updateTime) {
      message = message.replace(/ \(.*分钟前\)/g, '')
      message = message.replace(/ \( 分钟前\)/g, '')
      message = message.replace(/ \(分钟前\)/g, '')
    }
    
    // 处理条件显示：如果nextPlayTime为null，移除包含下机信息的行
    if (nextPlayTime === null) {
      // 匹配包含"若是刚刚下机"的行，可能跨多行
      message = message.replace(/\n\n若是刚刚下机，\n从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，\n从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n\n若是刚刚下机，\n从上次上机到下次大约需要 未知 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，\n从上次上机到下次大约需要 未知 分钟/g, '')
      // 单行匹配
      message = message.replace(/\n若是刚刚下机，从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，从上次上机到下次大约需要 未知 分钟/g, '')
    }
    
    // 处理条件显示：如果没有店铺通知，移除店铺通知相关的行
    if (!config.notice) {
      message = message.replace(/店铺通知: \n　　\n/g, '')
      message = message.replace(/店铺通知: \n\n/g, '')
      message = message.replace(/店铺通知: \n/g, '')
      message = message.replace(/店铺通知: \n　　/g, '')
    }
    
    return message
  }

  // 生成查询消息（支持自定义模板）
  function generateQueryMessage(arcadeId: string, arcade: ArcadeData): string {
    if (arcade.config.queryMessageTemplate) {
      return replaceTemplateVariables(arcade.config.queryMessageTemplate, arcade)
    }
    return generateDefaultQueryMessage(arcadeId, arcade)
  }

  // 生成上报消息（支持自定义模板）
  function generateReportMessage(arcadeId: string, arcade: ArcadeData): string {
    if (arcade.config.reportMessageTemplate) {
      return replaceTemplateVariables(arcade.config.reportMessageTemplate, arcade)
    }
    return generateDefaultReportMessage(arcadeId, arcade)
  }

  // 解析人数上报命令
  function parseReportCommand(text: string): { alias: string, operation: 'set' | 'add' | 'subtract', value: number } | null {
    // 匹配格式：别名数字、别名=数字、别名+数字、别名-数字
    // 先匹配带操作符的格式（别名+数字、别名-数字、别名=数字）
    const withOpMatch = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)([+\-=])(\d+)$/)
    if (withOpMatch) {
      const alias = withOpMatch[1]
      const op = withOpMatch[2]
      const value = parseInt(withOpMatch[3], 10)
      
      let operation: 'set' | 'add' | 'subtract' = 'set'
      if (op === '+') operation = 'add'
      else if (op === '-') operation = 'subtract'
      else if (op === '=') operation = 'set'
      
      return { alias, operation, value }
    }
    
    // 匹配不带操作符的格式（别名数字）
    const withoutOpMatch = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)(\d+)$/)
    if (withoutOpMatch) {
      const alias = withoutOpMatch[1]
      const value = parseInt(withoutOpMatch[2], 10)
      return { alias, operation: 'set', value }
    }
    
    return null
  }

  // 注意：人数上报已通过 middleware 实现，直接输入格式即可（例如：yf1, yf+1, yf-1, yf=5）

  // 解析查询命令（支持 别名几、别名j 格式）
  function parseQueryCommand(text: string): string | null {
    // 匹配 别名几 或 别名j
    const match = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)([几j])$/)
    if (match) {
      return match[1]
    }
    return null
  }

  // 注意：查询已通过 middleware 实现，直接输入格式即可（例如：yf几, yfj）

  // 处理直接输入格式：查询（别名几/别名j）和上报（别名数字、别名+数字、别名-数字、别名=数字）
  ctx.middleware(async (session, next) => {
    const text = session.content?.trim() || ''
    if (!text) {
      return next()
    }

    // 1. 先尝试匹配查询格式（别名几 或 别名j）
    const queryAlias = parseQueryCommand(text)
    if (queryAlias) {
      const arcadeId = getArcadeId(queryAlias)
      if (arcadeId) {
        // 检查群白名单：如果不在白名单，直接忽略消息（不回复）
        const channel = session.event.channel
        if (channel && String(channel.type) === 'group' && !checkGroupWhitelist(arcadeId, channel.id)) {
          // 不在白名单，直接返回，不回复消息
          return
        }

        const arcade = arcades[arcadeId] as ArcadeData | undefined
        if (arcade) {
          // 返回查询结果
          await session.send(generateQueryMessage(arcadeId, arcade))
          return
        }
      }
      // 如果匹配了查询格式但找不到机厅，继续处理
    }

    // 2. 尝试匹配上报格式（别名数字、别名+数字、别名-数字、别名=数字）
    const reportParsed = parseReportCommand(text)
    if (reportParsed) {
      const arcadeId = getArcadeId(reportParsed.alias)
      if (!arcadeId) {
        // 如果找不到机厅，不处理（让其他插件处理）
        return next()
      }

      // 检查群白名单：上报需要检查白名单
      const channel = session.event.channel
      if (channel && String(channel.type) === 'group' && !checkGroupWhitelist(arcadeId, channel.id)) {
        // 不在白名单，直接返回，不回复消息
        return
      }

      const arcade = arcades[arcadeId] as ArcadeData | undefined
      if (!arcade) {
        return next()
      }

      // 更新人数
      const oldCount = arcade.status.currentCount
      let newCount = arcade.status.currentCount
      if (reportParsed.operation === 'set') {
        newCount = reportParsed.value
      } else if (reportParsed.operation === 'add') {
        newCount += reportParsed.value
      } else if (reportParsed.operation === 'subtract') {
        newCount = Math.max(0, newCount - reportParsed.value)
      }

      arcade.status.currentCount = newCount
      arcade.status.updateTime = new Date().toISOString()
      arcade.status.updaterName = session.event.user?.name || session.event.user?.id || ''
      arcade.status.updaterId = session.event.user?.id || ''

      // 如果人数减少，自动设置lastPlayTime（表示刚下机）
      if (newCount < oldCount) {
        arcade.status.lastPlayTime = new Date().toISOString()
      }

      // 状态数据仅保存在内存中
      await updateConfig()

      // 返回更新后的状态
      await session.send(generateReportMessage(arcadeId, arcade))
      return
    }

    // 都不匹配，继续处理
    return next()
  })

  // 注意：机厅配置（名称、别名、机台数量、店铺通知、白名单等）需要通过配置文件管理
  // 修改配置后需要重启插件才能生效
  // 以下命令仅用于运行时状态查询和上报，不用于修改配置
  // 注意：当人数减少时，会自动设置lastPlayTime（表示刚下机），查询和上报时会自动显示下机信息

  // 重置所有机厅人数为0
  async function resetAllArcadesCount() {
    const resetTime = new Date().toISOString()
    for (const [arcadeId, arcade] of Object.entries(arcades)) {
      const arcadeData = arcade as ArcadeData
      arcadeData.status.currentCount = 0
      arcadeData.status.updateTime = resetTime
      arcadeData.status.updaterName = '系统'
      arcadeData.status.updaterId = 'system'
      arcadeData.status.lastPlayTime = undefined // 清除上次上机时间
    }
    await updateConfig()
  }

  // 存储当前定时器ID，以便在插件卸载时清理
  let resetTimerId: NodeJS.Timeout | null = null

  // 设置定时任务：每天凌晨12点重置所有机厅人数
  // 计算到下一个凌晨12点的时间
  function scheduleMidnightReset() {
    const now = new Date()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    
    // 如果已经过了今天的凌晨12点，设置为明天的凌晨12点
    if (now >= midnight) {
      midnight.setDate(midnight.getDate() + 1)
    }
    
    const msUntilMidnight = midnight.getTime() - now.getTime()
    
    // 设置定时器
    resetTimerId = setTimeout(() => {
      resetAllArcadesCount().catch(err => {
        ctx.logger('mai-queue').error('重置机厅人数失败:', err)
      })
      // 递归调用，设置下一个凌晨12点的重置任务
      scheduleMidnightReset()
    }, msUntilMidnight)
  }

  // 启动定时任务
  scheduleMidnightReset()

  // 插件卸载时清理定时器
  ctx.on('dispose', () => {
    if (resetTimerId) {
      clearTimeout(resetTimerId)
      resetTimerId = null
    }
  })
}

