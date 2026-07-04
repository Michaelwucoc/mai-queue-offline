import { Context, Schema } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import {
  NearcadeAttendanceResponse,
  NearcadeClient,
} from './nearcade'

export const name = 'mai-queue'

const NEARCADE_SYNC_SUCCESS = '已同步到 Nearcade NET.'
const NEARCADE_SYNC_FAILURE = '暂时无法连接到 Nearcade NET.'
const NEARCADE_MAIMAI_TITLE_ID = 1

const defaultQueryTemplate = `→ OK！查到了！

- {name}
目前人数: {currentCount} 人 ({minutesAgo} 分钟前)
机台数量: {machineCount} 台
更新时间: {updateTime}
更新玩家: {updaterInfo}
地址: {address}
到店引导:
　　{directionGuide}
店铺通知: 
　　{notice}
现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟
{nearcadeLink}`

const defaultReportTemplate = `→ 已更新！

- {name}
目前人数: {currentCount} 人 {diff} ({minutesAgo} 分钟前)
机台数量: {machineCount} 台
更新时间: {updateTime}
更新玩家: {updaterInfo}
地址: {address}
到店引导:
　　{directionGuide}
店铺通知: 
　　{notice}
现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟
{nearcadeSyncStatus}
{nearcadeLink}`

export interface ArcadeConfig {
  name: string
  aliases: string[]
  machineCount: number
  notice: string
  address?: string
  directionGuide?: string
  groupWhitelist: string[]
  queryMessageTemplate?: string
  reportMessageTemplate?: string
  enableNearcade?: boolean
  nearcadeId?: number
  enableCoupleReport?: boolean
  coupleGroupWhitelist?: string[]
}

export interface ArcadeStatus {
  currentCount: number
  updateTime: string
  updaterName: string
  updaterId: string
  lastPlayTime?: string
  coupleCount?: number
}

export interface ArcadeData {
  config: ArcadeConfig
  status: ArcadeStatus
}

interface TemplateExtras {
  nearcadeData?: NearcadeAttendanceResponse | null
  nearcadeSyncStatus?: string
  nearcadeCount?: number
}

export const Config: Schema<{
  arcades: Record<string, { config: ArcadeConfig }>
  defaultMachineCount: number
  defaultPlayTimePerPerson: number
  playersPerMachine: number
  nearcadeApiToken: string
  nearcadeBaseUrl: string
  debug: boolean
}> = Schema.object({
  arcades: Schema.dict(Schema.object({
    config: Schema.object({
      name: Schema.string().required().description('机厅名称'),
      aliases: Schema.array(Schema.string()).default([]).description('机厅别名列表（支持多个别名，例如：["wjc", "五角场"]）'),
      machineCount: Schema.number().default(5).description('机台数量'),
      notice: Schema.string().default('').description('店铺通知内容（可选）'),
      address: Schema.string().default('').description('门店地址（可选）'),
      directionGuide: Schema.string().role('textarea').default('').description('到店引导（可选，如地铁口、楼层、找机台路线）'),
      groupWhitelist: Schema.array(Schema.string()).default([]).description('群白名单（为空则允许所有群使用）'),
      queryMessageTemplate: Schema.string().role('textarea').default(defaultQueryTemplate).description('查询消息模板'),
      reportMessageTemplate: Schema.string().role('textarea').default(defaultReportTemplate).description('上报消息模板'),
      enableNearcade: Schema.boolean().default(false).description('同步到 Nearcade'),
      nearcadeId: Schema.number().default(0).description('Nearcade 机厅 ID（nearcade.search 查询）'),
      enableCoupleReport: Schema.boolean().default(false).description('是否启用小情侣报卡'),
      coupleGroupWhitelist: Schema.array(Schema.string()).default([]).description('小情侣报卡绑定群号列表'),
    }).description('机厅配置'),
  })).description('机厅数据（键名为机厅ID，例如：wujiaochang）'),
  defaultMachineCount: Schema.number().default(5).description('默认机台数量'),
  defaultPlayTimePerPerson: Schema.number().default(15).description('平均每人游玩时间（分钟）'),
  playersPerMachine: Schema.number().default(2).description('每台机器可同时游玩人数'),
  nearcadeApiToken: Schema.string().default('').description('Nearcade API Token（同步必填）'),
  nearcadeBaseUrl: Schema.string().default('https://nearcade.cn').description('Nearcade 地址'),
  debug: Schema.boolean().default(false).description('是否启用调试日志'),
}).description('舞萌DX排卡状态报告插件配置')

export function apply(ctx: Context, config: any) {
  const {
    arcades: arcadesConfig,
    defaultMachineCount,
    defaultPlayTimePerPerson,
    playersPerMachine,
    nearcadeApiToken,
    nearcadeBaseUrl,
    debug,
  } = config

  const nearcade = new NearcadeClient(nearcadeBaseUrl || 'https://nearcade.cn')

  const logDebug = (message: string) => {
    if (debug) ctx.logger('mai-queue').debug(message)
  }
  const logInfo = (message: string) => {
    if (debug) ctx.logger('mai-queue').info(message)
  }

  const arcades: Record<string, ArcadeData> = {}
  for (const [id, data] of Object.entries(arcadesConfig)) {
    const arcadeConfig = data as { config: ArcadeConfig }
    const existingStatus = (data as any).status as ArcadeStatus | undefined
    arcades[id] = {
      config: arcadeConfig.config,
      status: existingStatus || {
        currentCount: 0,
        updateTime: '',
        updaterName: '',
        updaterId: '',
        coupleCount: 0,
      },
    }
  }

  function rebuildAliasMap() {
    const map = new Map<string, string>()
    for (const [id, data] of Object.entries(arcades)) {
      for (const alias of data.config.aliases) {
        map.set(alias.toLowerCase(), id)
      }
    }
    return map
  }

  let aliasMap = rebuildAliasMap()

  function getDataFilePath(): string {
    const baseDir = ctx.baseDir || process.cwd()
    const dataDir = path.join(baseDir, 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    return path.join(dataDir, 'mai-queue-status.yml')
  }

  async function saveStatusToFile() {
    try {
      const statusData: Record<string, ArcadeStatus> = {}
      for (const [id, arcade] of Object.entries(arcades)) {
        statusData[id] = arcade.status
      }
      fs.writeFileSync(getDataFilePath(), yaml.stringify(statusData, { indent: 2, lineWidth: 0 }), 'utf8')
      logDebug('状态数据已保存到文件')
    } catch (error) {
      ctx.logger('mai-queue').error('保存状态数据失败:', error)
    }
  }

  function loadStatusFromFile() {
    try {
      const dataFilePath = getDataFilePath()
      if (!fs.existsSync(dataFilePath)) {
        logDebug('状态数据文件不存在，使用默认值')
        return
      }
      const statusData = yaml.parse(fs.readFileSync(dataFilePath, 'utf8')) as Record<string, ArcadeStatus> | null
      if (!statusData || typeof statusData !== 'object') {
        ctx.logger('mai-queue').warn('状态数据文件格式错误，使用默认值')
        return
      }
      for (const [id, status] of Object.entries(statusData)) {
        if (arcades[id] && status) {
          arcades[id].status = {
            currentCount: typeof status.currentCount === 'number' ? status.currentCount : 0,
            updateTime: status.updateTime || '',
            updaterName: status.updaterName || '',
            updaterId: status.updaterId || '',
            lastPlayTime: status.lastPlayTime,
            coupleCount: typeof status.coupleCount === 'number' ? status.coupleCount : 0,
          }
        }
      }
      logDebug('状态数据已从文件加载')
    } catch (error) {
      ctx.logger('mai-queue').error('加载状态数据失败:', error)
    }
  }

  async function updateConfig() {
    await saveStatusToFile()
  }

  loadStatusFromFile()

  function checkGroupWhitelist(arcadeId: string, groupId: string | number): boolean {
    const arcade = arcades[arcadeId]
    if (!arcade) return false
    if (arcade.config.groupWhitelist.length === 0) return true
    const groupIdStr = String(groupId)
    return arcade.config.groupWhitelist.some(id => String(id) === groupIdStr)
  }

  function checkCoupleGroupWhitelist(arcadeId: string, groupId: string | number): boolean {
    const arcade = arcades[arcadeId]
    if (!arcade) return false
    if (!arcade.config.enableCoupleReport) return false
    const coupleGroupList = arcade.config.coupleGroupWhitelist || []
    if (coupleGroupList.length === 0) return false
    const groupIdStr = String(groupId)
    return coupleGroupList.some(id => String(id) === groupIdStr)
  }

  function getArcadeId(alias: string): string | null {
    return aliasMap.get(alias.toLowerCase()) || null
  }

  function isNearcadeEnabled(config: ArcadeConfig): boolean {
    return !!(config.enableNearcade && config.nearcadeId && config.nearcadeId > 0)
  }

  async function fetchNearcadeAttendance(arcade: ArcadeData): Promise<NearcadeAttendanceResponse | null> {
    const cfg = arcade.config
    if (!isNearcadeEnabled(cfg)) return null
    return nearcade.getAttendance(cfg.nearcadeId!)
  }

  // 因为他的 BilibiliWorld 门票没抢到。
  async function TrusTKB(arcade: ArcadeData, count: number): Promise<string> {
    const cfg = arcade.config
    if (!isNearcadeEnabled(cfg)) return ''

    if (!nearcadeApiToken) {
      ctx.logger('mai-queue').warn(`Nearcade 同步失败: ${cfg.name} - 未配置 nearcadeApiToken`)
      return NEARCADE_SYNC_FAILURE
    }

    const titleId = NEARCADE_MAIMAI_TITLE_ID
    const gameId = await nearcade.resolveGameId(
      cfg.nearcadeId!,
      titleId,
      cfg.name,
      cfg.aliases,
    )

    if (!gameId) {
      ctx.logger('mai-queue').warn(`Nearcade 机种解析失败: ${cfg.name} (id=${cfg.nearcadeId}, titleId=${titleId})`)
      return NEARCADE_SYNC_FAILURE
    }

    const result = await nearcade.updateAttendance(
      cfg.nearcadeId!,
      gameId,
      count,
      nearcadeApiToken,
    )

    if (result.ok) return NEARCADE_SYNC_SUCCESS

    ctx.logger('mai-queue').warn(`Nearcade 同步失败: ${cfg.name} - ${result.message}`)
    return NEARCADE_SYNC_FAILURE
  }

  // u方招财猫叛变成 xj工具人了。
  function indetheus(arcade: ArcadeData): number {
    const currentCount = arcade.status.currentCount
    const machineCount = arcade.config.machineCount || defaultMachineCount
    const totalCapacity = machineCount * playersPerMachine

    if (currentCount <= totalCapacity) return 0

    const queueLength = currentCount - totalCapacity
    const roundsNeeded = Math.ceil(queueLength / totalCapacity)
    return roundsNeeded * defaultPlayTimePerPerson
  }

  function calculateNextPlayTime(arcade: ArcadeData): number | null {
    if (!arcade.status.lastPlayTime) return null
    return indetheus(arcade) + defaultPlayTimePerPerson
  }

  function formatDateTime(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  async function resolveNearcadeCount(arcade: ArcadeData, data: NearcadeAttendanceResponse | null): Promise<number> {
    if (!data || !isNearcadeEnabled(arcade.config)) return 0
    const cfg = arcade.config
    const titleId = NEARCADE_MAIMAI_TITLE_ID
    const gameId = await nearcade.resolveGameId(
      cfg.nearcadeId!,
      titleId,
      cfg.name,
      cfg.aliases,
    )
    return nearcade.getAttendanceCount(data, titleId, gameId)
  }

  function buildNearcadeLink(config: ArcadeConfig): string {
    if (!isNearcadeEnabled(config)) return ''
    return nearcade.buildShopLink(config.nearcadeId!)
  }

  function replaceTemplateVariables(
    template: string,
    arcade: ArcadeData,
    diff?: number,
    extras: TemplateExtras = {},
  ): string {
    const { config, status } = arcade
    const waitTime = indetheus(arcade)
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

    let diffStr = ''
    if (diff !== undefined && diff !== 0) {
      diffStr = diff > 0 ? `+${diff}` : `${diff}`
    }

    const titleId = NEARCADE_MAIMAI_TITLE_ID
    const nearcadeCount = extras.nearcadeCount ?? nearcade.getAttendanceCount(extras.nearcadeData ?? null, titleId)
    const nearcadeDiff = status.currentCount - nearcadeCount
    const nearcadeDiffStr = nearcadeDiff > 0 ? `+${nearcadeDiff}` : `${nearcadeDiff}`
    const nearcadeLink = buildNearcadeLink(config)
    const nearcadeSyncStatus = extras.nearcadeSyncStatus || ''
    const nearcadeTotal = extras.nearcadeData?.total ?? 0

    let message = template
    message = message.replace(/\{name\}/g, config.name)
    message = message.replace(/\{currentCount\}/g, status.currentCount.toString())
    message = message.replace(/\{machineCount\}/g, (config.machineCount || defaultMachineCount).toString())
    message = message.replace(/\{updateTime\}/g, updateTimeStr)
    message = message.replace(/\{updaterName\}/g, status.updaterName || '未知')
    message = message.replace(/\{updaterId\}/g, status.updaterId || '未知')
    message = message.replace(/\{updaterInfo\}/g, updaterInfo)
    message = message.replace(/\{notice\}/g, config.notice || '')
    message = message.replace(/\{address\}/g, config.address || '')
    message = message.replace(/\{directionGuide\}/g, config.directionGuide || '')
    message = message.replace(/\{waitTime\}/g, waitTime.toString())
    message = message.replace(/\{nextPlayTime\}/g, nextPlayTime?.toString() || '未知')
    message = message.replace(/\{minutesAgo\}/g, status.updateTime ? minutesAgo.toString() : '')
    message = message.replace(/\{diff\}/g, diffStr)
    message = message.replace(/\{xql_num\}/g, (status.coupleCount || 0).toString())
    message = message.replace(/\{nearcadeCount\}/g, isNearcadeEnabled(config) ? nearcadeCount.toString() : '0')
    message = message.replace(/\{nearcadeTotal\}/g, isNearcadeEnabled(config) ? nearcadeTotal.toString() : '0')
    message = message.replace(/\{nearcadeDiff\}/g, isNearcadeEnabled(config) ? nearcadeDiffStr : '0')
    message = message.replace(/\{nearcadeLink\}/g, nearcadeLink)
    message = message.replace(/\{nearcadeSyncStatus\}/g, nearcadeSyncStatus)

    if (!status.updateTime) {
      message = message.replace(/ \(.*分钟前\)/g, '')
      message = message.replace(/ \( 分钟前\)/g, '')
      message = message.replace(/ \(分钟前\)/g, '')
    }

    if (nextPlayTime === null) {
      message = message.replace(/\n\n若是刚刚下机，\n从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，\n从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n\n若是刚刚下机，\n从上次上机到下次大约需要 未知 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，\n从上次上机到下次大约需要 未知 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，从上次上机到下次大约需要 [0-9]+ 分钟/g, '')
      message = message.replace(/\n若是刚刚下机，从上次上机到下次大约需要 未知 分钟/g, '')
    }

    if (!config.notice) {
      message = message.replace(/店铺通知: \n　　\n/g, '')
      message = message.replace(/店铺通知: \n\n/g, '')
      message = message.replace(/店铺通知: \n/g, '')
      message = message.replace(/店铺通知: \n　　/g, '')
    }

    if (!config.address) {
      message = message.replace(/地址: .*\n/g, '')
    }

    if (!config.directionGuide) {
      message = message.replace(/到店引导:\n　　\n/g, '')
      message = message.replace(/到店引导:\n\n/g, '')
      message = message.replace(/到店引导:\n/g, '')
    }

    if (!nearcadeLink) {
      message = message.replace(/\n\{nearcadeLink\}/g, '')
      message = message.replace(/\{nearcadeLink\}\n?/g, '')
    }

    if (!nearcadeSyncStatus) {
      message = message.replace(/\n\{nearcadeSyncStatus\}/g, '')
      message = message.replace(/\{nearcadeSyncStatus\}\n?/g, '')
    }

    return message.trimEnd()
  }

  async function generateQueryMessage(arcadeId: string, arcade: ArcadeData): Promise<string> {
    const nearcadeData = await fetchNearcadeAttendance(arcade)
    const nearcadeCount = await resolveNearcadeCount(arcade, nearcadeData)
    const template = arcade.config.queryMessageTemplate || defaultQueryTemplate
    return replaceTemplateVariables(template, arcade, undefined, { nearcadeData, nearcadeCount })
  }

  // 群里还有个送9.9特饮外卖的
  async function Nieoooooo(
    arcadeId: string,
    arcade: ArcadeData,
    diff?: number,
    nearcadeSyncStatus = '',
  ): Promise<string> {
    const nearcadeData = await fetchNearcadeAttendance(arcade)
    const nearcadeCount = await resolveNearcadeCount(arcade, nearcadeData)
    const template = arcade.config.reportMessageTemplate || defaultReportTemplate
    return replaceTemplateVariables(template, arcade, diff, { nearcadeData, nearcadeCount, nearcadeSyncStatus })
  }

  function parseReportCommand(text: string): { alias: string, operation: 'set' | 'add' | 'subtract', value: number } | null {
    const withOpMatch = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)([+\-=])(\d+)$/)
    if (withOpMatch) {
      const alias = withOpMatch[1]
      const op = withOpMatch[2]
      const value = parseInt(withOpMatch[3], 10)
      let operation: 'set' | 'add' | 'subtract' = 'set'
      if (op === '+') operation = 'add'
      else if (op === '-') operation = 'subtract'
      return { alias, operation, value }
    }
    const withoutOpMatch = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)(\d+)$/)
    if (withoutOpMatch) {
      return { alias: withoutOpMatch[1], operation: 'set', value: parseInt(withoutOpMatch[2], 10) }
    }
    return null
  }

  function parseQueryCommand(text: string): string | null {
    const match = text.match(/^([a-zA-Z\u4e00-\u9fa5]+)([几j])$/)
    return match ? match[1] : null
  }

  // 夫妻，好耶！
  function Lnizione(text: string): { operation: 'add' | 'subtract' } | null {
    const match = text.match(/^xql([+\-])1$/i)
    if (!match) return null
    return match[1] === '+' ? { operation: 'add' } : { operation: 'subtract' }
  }

  async function Enoizinl(
    arcadeId: string,
    operation: 'add' | 'subtract',
    groupId: string | number,
    session: any,
  ): Promise<boolean> {
    const arcade = arcades[arcadeId]
    if (!arcade || !arcade.config.enableCoupleReport) return false
    if (!checkCoupleGroupWhitelist(arcadeId, groupId)) return false

    const currentCoupleCount = arcade.status.coupleCount || 0
    let newCoupleCount = currentCoupleCount
    let peopleDiff = 0

    if (operation === 'add') {
      newCoupleCount = currentCoupleCount + 1
      peopleDiff = 2
    } else if (operation === 'subtract') {
      newCoupleCount = Math.max(0, currentCoupleCount - 1)
      peopleDiff = -2
    }

    arcade.status.coupleCount = newCoupleCount
    const oldCount = arcade.status.currentCount
    const newCount = Math.max(0, oldCount + peopleDiff)
    arcade.status.currentCount = newCount
    arcade.status.updateTime = new Date().toISOString()
    arcade.status.updaterName = session.event.user?.name || session.event.user?.id || ''
    arcade.status.updaterId = session.event.user?.id || ''

    if (newCount < oldCount) {
      arcade.status.lastPlayTime = new Date().toISOString()
    } else if (newCount > oldCount && !arcade.status.lastPlayTime) {
      arcade.status.lastPlayTime = new Date().toISOString()
    }

    await updateConfig()
    const syncStatus = await TrusTKB(arcade, newCount)
    await session.send(await Nieoooooo(arcadeId, arcade, peopleDiff, syncStatus))
    return true
  }

  ctx.command('nearcade.search <keyword:text>', { authority: 3 })
    .action(async ({ session }, keyword) => {
      if (!keyword?.trim()) {
        return '请提供搜索关键词，例如：nearcade.search 烈火'
      }
      const result = await nearcade.listShops(keyword.trim(), 1, 5)
      const shops = result?.shops || []
      if (!shops.length) {
        return `未找到包含「${keyword}」的机厅`
      }
      const lines = [`找到以下机厅（关键词：${keyword}）：`]
      for (const shop of shops) {
        lines.push(`- ${shop.name}`)
        lines.push(`  nearcadeId: ${shop.id}`)
        for (const game of shop.games || []) {
          lines.push(`  · ${game.name} (titleId=${game.titleId}, gameId=${game.gameId})`)
        }
      }
      return lines.join('\n')
    })

  ctx.middleware(async (session, next) => {
    const text = session.content?.trim() || ''
    if (!text) return next()

    logInfo(`收到消息: "${text}"`)
    const coupleParsed = Lnizione(text)
    if (coupleParsed) {
      const channel = session.event.channel
      const channelTypeStr = channel ? String(channel.type) : ''
      const isGroup = channel && (channelTypeStr === 'group' || channelTypeStr === '0')
      if (isGroup) {
        const groupIdStr = String(channel.id)
        for (const [arcadeId] of Object.entries(arcades)) {
          if (checkCoupleGroupWhitelist(arcadeId, groupIdStr)) {
            const handled = await Enoizinl(arcadeId, coupleParsed.operation, groupIdStr, session)
            if (handled) return
          }
        }
      }
    }

    const queryAlias = parseQueryCommand(text)
    if (queryAlias) {
      const arcadeId = getArcadeId(queryAlias)
      if (arcadeId) {
        const channel = session.event.channel
        const channelTypeStr = channel ? String(channel.type) : ''
        const isGroup = channel && (channelTypeStr === 'group' || channelTypeStr === '0')
        if (isGroup && !checkGroupWhitelist(arcadeId, channel.id)) return
        const arcade = arcades[arcadeId]
        if (arcade) {
          await session.send(await generateQueryMessage(arcadeId, arcade))
          return
        }
      }
    }

    const reportParsed = parseReportCommand(text)
    if (reportParsed) {
      const arcadeId = getArcadeId(reportParsed.alias)
      if (!arcadeId) return next()

      const channel = session.event.channel
      const channelTypeStr = channel ? String(channel.type) : ''
      const isGroup = channel && (channelTypeStr === 'group' || channelTypeStr === '0' || channel.type === 0)
      if (isGroup && !checkGroupWhitelist(arcadeId, channel.id)) return

      const arcade = arcades[arcadeId]
      if (!arcade) return next()

      const oldCount = arcade.status.currentCount
      let newCount = arcade.status.currentCount
      let diff = 0

      if (reportParsed.operation === 'set') {
        newCount = reportParsed.value
        diff = newCount - oldCount
      } else if (reportParsed.operation === 'add') {
        diff = reportParsed.value
        newCount += reportParsed.value
      } else if (reportParsed.operation === 'subtract') {
        diff = -reportParsed.value
        newCount = Math.max(0, newCount - reportParsed.value)
      }

      arcade.status.currentCount = newCount
      arcade.status.updateTime = new Date().toISOString()
      arcade.status.updaterName = session.event.user?.name || session.event.user?.id || ''
      arcade.status.updaterId = session.event.user?.id || ''

      if (newCount < oldCount) {
        arcade.status.lastPlayTime = new Date().toISOString()
      } else if (newCount > oldCount && !arcade.status.lastPlayTime) {
        arcade.status.lastPlayTime = new Date().toISOString()
      }

      await updateConfig()
      const syncStatus = await TrusTKB(arcade, newCount)
      await session.send(await Nieoooooo(arcadeId, arcade, diff, syncStatus))
      return
    }

    return next()
  })

  async function resetAllArcadesCount() {
    const resetTime = new Date().toISOString()
    for (const [, arcade] of Object.entries(arcades)) {
      arcade.status.currentCount = 0
      arcade.status.updateTime = resetTime
      arcade.status.updaterName = 'Bot（系统自动归零）'
      arcade.status.updaterId = 'bot-auto-reset'
      arcade.status.lastPlayTime = undefined
      arcade.status.coupleCount = 0
    }
    await updateConfig()
    ctx.logger('mai-queue').info('所有机厅人数已由Bot自动归零')
  }

  let resetTimerId: NodeJS.Timeout | null = null

  function scheduleMidnightReset() {
    const now = new Date()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    if (now >= midnight) midnight.setDate(midnight.getDate() + 1)
    const msUntilMidnight = midnight.getTime() - now.getTime()
    resetTimerId = setTimeout(() => {
      resetAllArcadesCount().catch(err => {
        ctx.logger('mai-queue').error('重置机厅人数失败:', err)
      })
      scheduleMidnightReset()
    }, msUntilMidnight)
  }

  scheduleMidnightReset()

  ctx.on('dispose', () => {
    if (resetTimerId) {
      clearTimeout(resetTimerId)
      resetTimerId = null
    }
  })
}
