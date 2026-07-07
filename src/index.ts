import { Context, h, Schema } from 'koishi'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import {
  NearcadeAttendanceResponse,
  NearcadeClient,
} from './nearcade'
import {
  NEARCADE_DEFAULT_TITLE_ID,
  NEARCADE_GAME_TITLES,
  NearcadeTitleId,
  getNearcadeTitleName,
  isKnownNearcadeTitleId,
} from './nearcade-titles'
import { ArcadePredictor, DEFAULT_FORECAST_HOURS, DEFAULT_FORECAST_STEP_MINUTES, DEFAULT_HISTORY_HOURS, FORECAST_DISCLAIMER, type PredictorContext } from './predictor'
import { DEFAULT_CHART_HISTORY_HOURS, generateQueueChartSvg, renderChartToPng } from './chart'
import { DEFAULT_CLOSE_GRACE_MINUTES, resolveOperatingHours } from './event-quality'

export const name = 'mai-queue'

const PLUGIN_VERSION = '2.1.0'
const NEARCADE_SYNC_SUCCESS = '🛜 已同步到 Nearcade NET.'
const NEARCADE_SYNC_FAILURE = '暂时无法连接到 Nearcade NET.'

const defaultQueryTemplate = `→ OK！查到了！

🎮 {displayName}

🎉 目前人数: {currentCount} 人 ({minutesAgo} 分钟前)

💏小情侣数量：{xql_num}

机台数量: {machineCount} 台
更新时间: {updateTime}
更新玩家: {updaterInfo}
🪧 店铺通知: 

{notice}

⌛️ 现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟

{nearcadeLink}`

const defaultReportTemplate = `→ 喵！已更新！

🎮 {displayName}

🎉 目前人数: {currentCount} 人 {diff}

更新时间: {updateTime}
更新玩家: {updaterInfo}

⌛️ 现在出勤大约需要 {waitTime} 分钟才能上机

若是刚刚下机，
从上次上机到下次大约需要 {nextPlayTime} 分钟

{nearcadeSyncStatus}
{nearcadeLink}`

const defaultPredictTemplate = `→ 🔮 预测报告！

🎮 {displayName}

🎉 目前人数: {currentCount} 人（{dayTypeLabel}）

⌛️ 预测等待: {waitTime} 分钟
{modelInfo}
{weekdayWeekendHint}

📈 未来 {forecastHours} 小时预测（每30分钟 · 中=周中 末=周末）:
{forecastSchedule}

💡 推荐: {forecastRecommendation}

趋势: {trendDesc}

📉 趋势图见下图

{forecastDisclaimer}

更新时间: {updateTime}
{nearcadeLink}`

export interface ArcadeConfig {
  name: string
  aliases: string[]
  machineCount: number
  notice: string
  address?: string
  directionGuide?: string
  groupWhitelist: string[]
  gameTitle?: string
  queryMessageTemplate?: string
  reportMessageTemplate?: string
  predictMessageTemplate?: string
  enableNearcade?: boolean
  nearcadeId?: number
  nearcadeTitleId?: NearcadeTitleId
  enableCoupleReport?: boolean
  coupleGroupWhitelist?: string[]
  operatingOpenHour?: number
  operatingCloseHour?: number
  operatingCloseGraceMinutes?: number
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
  nearcadeCount?: number | null
  effectiveCount?: number
  countFromNearcade?: boolean
  arcadeId?: string
  isPredict?: boolean
}

interface EffectiveCountResult {
  count: number
  fromNearcade: boolean
  nearcadeData: NearcadeAttendanceResponse | null
  nearcadeCount: number | null
}

export const Config = Schema.object({
  arcades: Schema.dict(Schema.object({
    config: Schema.object({
      name: Schema.string().required().description('机厅名称'),
      aliases: Schema.array(Schema.string()).default([]).description('机厅别名列表（支持多个别名，例如：["wjc", "五角场"]）'),
      machineCount: Schema.number().default(5).description('机台数量'),
      notice: Schema.string().default('').description('店铺通知内容（可选）'),
      address: Schema.string().default('').description('门店地址（可选）'),
      directionGuide: Schema.string().role('textarea').default('').description('到店引导（可选，如地铁口、楼层、找机台路线）'),
      groupWhitelist: Schema.array(Schema.string()).default([]).description('群白名单（为空则允许所有群使用）'),
      gameTitle: Schema.string().default('舞萌DX').description('游戏名称（显示在机厅名后）'),
      queryMessageTemplate: Schema.string().role('textarea').default(defaultQueryTemplate).description('查询消息模板'),
      reportMessageTemplate: Schema.string().role('textarea').default(defaultReportTemplate).description('上报消息模板'),
      predictMessageTemplate: Schema.string().role('textarea').default(defaultPredictTemplate).description('预测消息模板'),
      enableNearcade: Schema.boolean().default(false).description('同步到 Nearcade'),
      nearcadeId: Schema.number().default(0).description('Nearcade 机厅 ID（nearcade.search 查询）'),
      nearcadeTitleId: Schema.union(
        NEARCADE_GAME_TITLES.map(({ id, name }) => Schema.const(id).description(name)),
      ).default(NEARCADE_DEFAULT_TITLE_ID).description('Nearcade 机种'),
      enableCoupleReport: Schema.boolean().default(false).description('是否启用小情侣报卡'),
      coupleGroupWhitelist: Schema.array(Schema.string()).default([]).description('小情侣报卡绑定群号列表'),
      operatingOpenHour: Schema.number().description('营业开始小时（0-23，留空则继承全局 operatingOpenHour）'),
      operatingCloseHour: Schema.number().description('营业结束小时（含，留空则继承全局 operatingCloseHour）'),
      operatingCloseGraceMinutes: Schema.number().description('闭店宽容分钟（延迟打烊，留空则继承全局）'),
    }).description('机厅配置'),
  })).description('机厅数据（键名为机厅ID，例如：wujiaochang）'),
  operatingOpenHour: Schema.number().default(10).description('全局营业开始小时（0-23，机厅未单独配置时使用）'),
  operatingCloseHour: Schema.number().default(23).description('全局营业结束小时（含该小时，机厅未单独配置时使用）'),
  operatingCloseGraceMinutes: Schema.number().default(DEFAULT_CLOSE_GRACE_MINUTES).description('全局闭店宽容分钟（正式打烊后仍可上报/预测，默认 90）'),
  defaultMachineCount: Schema.number().default(5).description('默认机台数量'),
  defaultPlayTimePerPerson: Schema.number().default(15).description('平均每人游玩时间（分钟）'),
  playersPerMachine: Schema.number().default(2).description('每台机器可同时游玩人数'),
  nearcadeApiToken: Schema.string().default('').description('Nearcade API Token（同步必填）'),
  nearcadeBaseUrl: Schema.string().default('https://nearcade.cn').description('Nearcade 地址'),
  nearcadeBotName: Schema.string().default('mai-queue').description('Bot 名称（写入 Nearcade 同步备注）'),
  forecastHours: Schema.number().default(DEFAULT_FORECAST_HOURS).description('预测未来小时数（默认 8）'),
  forecastStepMinutes: Schema.number().default(DEFAULT_FORECAST_STEP_MINUTES).description('预测时间步长（分钟，默认 30）'),
  enableMessageFooter: Schema.boolean().default(false).description('是否在消息末尾附加页脚'),
  messageFooter: Schema.string().default(`Made By Milk with ❤️ | awmc.cc | v${PLUGIN_VERSION} [InslideAlpha]`).description('消息页脚（enableMessageFooter 为 true 时生效）'),
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
    nearcadeBotName,
    forecastHours: configForecastHours,
    forecastStepMinutes: configForecastStepMinutes,
    operatingOpenHour: globalOperatingOpenHour,
    operatingCloseHour: globalOperatingCloseHour,
    operatingCloseGraceMinutes: globalOperatingCloseGraceMinutes,
    enableMessageFooter,
    messageFooter,
    debug,
  } = config

  const forecastHours = configForecastHours || DEFAULT_FORECAST_HOURS
  const forecastStepMinutes = configForecastStepMinutes || DEFAULT_FORECAST_STEP_MINUTES
  const globalOperatingHours = resolveOperatingHours(
    {
      openHour: globalOperatingOpenHour ?? 10,
      closeHour: globalOperatingCloseHour ?? 23,
      closeGraceMinutes: globalOperatingCloseGraceMinutes ?? DEFAULT_CLOSE_GRACE_MINUTES,
    },
  )

  const nearcade = new NearcadeClient(nearcadeBaseUrl || 'https://nearcade.cn')
  const predictor = new ArcadePredictor(ctx.baseDir || process.cwd())

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

  function buildPredictorContext(arcade: ArcadeData): PredictorContext {
    const cfg = arcade.config
    return {
      operatingHours: resolveOperatingHours(globalOperatingHours, {
        openHour: cfg.operatingOpenHour,
        closeHour: cfg.operatingCloseHour,
        closeGraceMinutes: cfg.operatingCloseGraceMinutes,
      }),
      machineCount: cfg.machineCount || defaultMachineCount,
      playersPerMachine,
    }
  }

  function buildSanitizeContexts(): Record<string, PredictorContext> {
    const map = buildAllPredictorContexts()
    const fallback: PredictorContext = {
      operatingHours: globalOperatingHours,
      playersPerMachine,
    }
    for (const id of predictor.getArcadeIds()) {
      if (!map[id]) map[id] = fallback
    }
    return map
  }

  function buildAllPredictorContexts(): Record<string, PredictorContext> {
    const map: Record<string, PredictorContext> = {}
    for (const [id, arcade] of Object.entries(arcades)) {
      map[id] = buildPredictorContext(arcade)
    }
    return map
  }

  const removedBadEvents = predictor.sanitizeAll(buildSanitizeContexts())
  if (removedBadEvents > 0) {
    logDebug(`已剔除 ${removedBadEvents} 条不可靠历史数据`)
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

  function getArcadeTitleId(config: ArcadeConfig): number {
    const id = config.nearcadeTitleId
    if (id && id > 0 && isKnownNearcadeTitleId(id)) return id
    return NEARCADE_DEFAULT_TITLE_ID
  }

  async function resolveArcadeGameId(config: ArcadeConfig): Promise<number | null> {
    return nearcade.resolveGameId(
      config.nearcadeId!,
      getArcadeTitleId(config),
      config.name,
      config.aliases,
    )
  }

  async function fetchNearcadeAttendance(arcade: ArcadeData): Promise<NearcadeAttendanceResponse | null> {
    const cfg = arcade.config
    if (!isNearcadeEnabled(cfg)) return null
    return nearcade.getAttendance(cfg.nearcadeId!)
  }

  function buildNearcadeReportComment(reporterName: string, reporterId: string): string {
    const name = reporterName || '未知'
    const id = reporterId || '未知'
    return `由 ${name} (${id}) 通过 ${nearcadeBotName || 'mai-queue'} 上报`
  }

  function getReporterFromSession(session: any): { name: string, id: string } {
    return {
      name: session.event.user?.name || session.username || '未知',
      id: String(session.event.user?.id || session.userId || '未知'),
    }
  }

  // 因为他的 BilibiliWorld 门票没抢到。
  async function TrusTKB(
    arcade: ArcadeData,
    count: number,
    reporterName: string,
    reporterId: string,
  ): Promise<string> {
    const cfg = arcade.config
    if (!isNearcadeEnabled(cfg)) return ''

    if (!nearcadeApiToken) {
      ctx.logger('mai-queue').warn(`Nearcade 同步失败: ${cfg.name} - 未配置 nearcadeApiToken`)
      return NEARCADE_SYNC_FAILURE
    }

    const gameId = await resolveArcadeGameId(cfg)

    if (!gameId) {
      ctx.logger('mai-queue').warn(`Nearcade 机种解析失败: ${cfg.name} (id=${cfg.nearcadeId}, ${getNearcadeTitleName(getArcadeTitleId(cfg))})`)
      return NEARCADE_SYNC_FAILURE
    }

    const result = await nearcade.updateAttendance(
      cfg.nearcadeId!,
      gameId,
      count,
      nearcadeApiToken,
      buildNearcadeReportComment(reporterName, reporterId),
    )

    if (result.ok) return NEARCADE_SYNC_SUCCESS

    ctx.logger('mai-queue').warn(`Nearcade 同步失败: ${cfg.name} - ${result.message}`)
    return NEARCADE_SYNC_FAILURE
  }

  function getDisplayName(config: ArcadeConfig): string {
    const title = config.gameTitle || '舞萌DX'
    return `${config.name} - ${title}`
  }

  function getChartFilePath(arcadeId: string): string {
    const baseDir = ctx.baseDir || process.cwd()
    const chartDir = path.join(baseDir, 'data', 'charts')
    if (!fs.existsSync(chartDir)) {
      fs.mkdirSync(chartDir, { recursive: true })
    }
    return path.join(chartDir, `${arcadeId}-queue.png`)
  }

  async function syncNearcadeHistory(arcadeId: string, arcade: ArcadeData, data: NearcadeAttendanceResponse | null) {
    if (!data || !isNearcadeEnabled(arcade.config)) return 0
    const pctx = buildPredictorContext(arcade)
    const titleId = getArcadeTitleId(arcade.config)
    const gameId = await resolveArcadeGameId(arcade.config)
    const reports = nearcade.extractReportHistory(data, titleId, gameId)
    const machineCount = arcade.config.machineCount || defaultMachineCount
    let imported = 0
    if (reports.length) {
      imported = predictor.importNearcadeReports(
        arcadeId,
        reports.map(r => ({
          count: r.currentAttendances,
          reportedAt: r.reportedAt,
          machineCount,
        })),
        pctx,
      )
    }

    const currentCount = await resolveNearcadeCount(arcade, data)
    if (currentCount !== null) {
      predictor.recordEvent(arcadeId, currentCount, 0, machineCount, new Date().toISOString(), 'nearcade', pctx)
    }

    if (imported > 0) {
      logDebug(`Nearcade 历史导入 ${imported} 条: ${arcade.config.name}`)
    }
    return imported
  }

  function recordQueueEvent(arcadeId: string, arcade: ArcadeData, diff: number) {
    predictor.recordEvent(
      arcadeId,
      arcade.status.currentCount,
      diff,
      arcade.config.machineCount || defaultMachineCount,
      arcade.status.updateTime || new Date().toISOString(),
      'local',
      buildPredictorContext(arcade),
    )
  }

  function getWaitTimePrediction(arcadeId: string, arcade: ArcadeData, count: number) {
    return predictor.predictWaitTime(
      arcadeId,
      count,
      arcade.config.machineCount || defaultMachineCount,
      playersPerMachine,
      defaultPlayTimePerPerson,
      !!arcade.status.lastPlayTime,
      buildPredictorContext(arcade),
    )
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

  async function resolveNearcadeCount(arcade: ArcadeData, data: NearcadeAttendanceResponse | null): Promise<number | null> {
    if (!data || !isNearcadeEnabled(arcade.config)) return null
    const cfg = arcade.config
    const titleId = getArcadeTitleId(cfg)
    const fromAttendance = nearcade.resolveAttendanceCount(data, titleId)
    if (fromAttendance !== null) return fromAttendance

    const gameId = await resolveArcadeGameId(cfg)
    return nearcade.resolveAttendanceCount(data, titleId, gameId)
  }

  async function resolveEffectiveCount(arcadeId: string, arcade: ArcadeData): Promise<EffectiveCountResult> {
    const localCount = arcade.status.currentCount
    if (!isNearcadeEnabled(arcade.config)) {
      return { count: localCount, fromNearcade: false, nearcadeData: null, nearcadeCount: null }
    }

    const nearcadeData = await fetchNearcadeAttendance(arcade)
    if (!nearcadeData) {
      logDebug(`Nearcade 拉取失败，使用本地人数: ${arcade.config.name}`)
      return { count: localCount, fromNearcade: false, nearcadeData: null, nearcadeCount: null }
    }

    await syncNearcadeHistory(arcadeId, arcade, nearcadeData)

    const nearcadeCount = await resolveNearcadeCount(arcade, nearcadeData)
    if (nearcadeCount === null) {
      logDebug(`Nearcade 无出勤数据，使用本地人数: ${arcade.config.name}`)
      return { count: localCount, fromNearcade: false, nearcadeData, nearcadeCount: null }
    }

    logDebug(`Nearcade 人数 ${nearcadeCount}，本地 ${localCount}: ${arcade.config.name}`)
    return { count: nearcadeCount, fromNearcade: true, nearcadeData, nearcadeCount }
  }

  function buildNearcadeLink(config: ArcadeConfig): string {
    if (!isNearcadeEnabled(config)) return ''
    return nearcade.buildShopLink(config.nearcadeId!)
  }

  function replaceTemplateVariables(
    template: string,
    arcadeId: string,
    arcade: ArcadeData,
    diff?: number,
    extras: TemplateExtras = {},
  ): string {
    const { config, status } = arcade
    const displayCount = extras.effectiveCount ?? status.currentCount
    const prediction = getWaitTimePrediction(arcadeId, arcade, displayCount)
    const waitTime = prediction.waitMinutes
    const nextPlayTime = prediction.nextPlayMinutes
    const capacity = (config.machineCount || defaultMachineCount) * playersPerMachine
    const pctx = buildPredictorContext(arcade)
    const forecast = predictor.predictForecast(arcadeId, displayCount, forecastHours, forecastStepMinutes, pctx)
    const recommendation = predictor.recommendVisitTime(forecast, capacity, displayCount, arcadeId, pctx)
    const forecastSchedule = predictor.formatForecastSchedule(forecast, recommendation.bestMinutes)
    const weekdayWeekendHint = recommendation.weekdayWeekendHint
      ? `📅 ${recommendation.weekdayWeekendHint}`
      : ''
    const trend = predictor.predictTrend(arcadeId, displayCount, forecastHours * 60, pctx)

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
      diffStr = diff > 0 ? `(+${diff})` : `(${diff})`
    }

    const titleId = getArcadeTitleId(config)
    const nearcadeCount = extras.nearcadeCount ?? (
      extras.nearcadeData
        ? nearcade.getAttendanceCount(extras.nearcadeData, titleId)
        : null
    )
    const nearcadeCountDisplay = nearcadeCount ?? 0
    const nearcadeDiff = status.currentCount - nearcadeCountDisplay
    const nearcadeDiffStr = nearcadeDiff > 0 ? `+${nearcadeDiff}` : `${nearcadeDiff}`
    const nearcadeLink = buildNearcadeLink(config)
    const nearcadeSyncStatus = extras.nearcadeSyncStatus || ''
    const nearcadeTotal = extras.nearcadeData?.total ?? 0
    const nearcadeDataPoints = predictor.getNearcadeEventCount(arcadeId, pctx)
    const trustedCount = predictor.getTrustedEventCount(arcadeId, pctx)

    const modelInfo = prediction.fromModel
      ? `📊 模型: ${prediction.method} | 置信度 ${prediction.confidence}%\n📚 有效样本 ${trustedCount} 条（Nearcade ${nearcadeDataPoints} 条）${prediction.peakHourHint ? `\n⏰ ${prediction.peakHourHint}` : ''}`
      : `📊 模型: ${prediction.method} | 置信度 ${prediction.confidence}%\n📚 有效数据 ${trustedCount} 条（积累中，已过滤非营业时段异常）`

    let trendDesc = '平稳'
    if (trend.trendPerHour > 1) trendDesc = `上升（约 +${trend.trendPerHour}/小时）`
    else if (trend.trendPerHour < -1) trendDesc = `下降（约 ${trend.trendPerHour}/小时）`
    const predictedRange = `${trend.lowerBound}~${trend.upperBound}`

    let message = template
    message = message.replace(/\{name\}/g, config.name)
    message = message.replace(/\{displayName\}/g, getDisplayName(config))
    message = message.replace(/\{gameTitle\}/g, config.gameTitle || '舞萌DX')
    message = message.replace(/\{currentCount\}/g, displayCount.toString())
    message = message.replace(/\{machineCount\}/g, (config.machineCount || defaultMachineCount).toString())
    message = message.replace(/\{updateTime\}/g, updateTimeStr)
    message = message.replace(/\{updaterName\}/g, status.updaterName || '未知')
    message = message.replace(/\{updaterId\}/g, status.updaterId || '未知')
    message = message.replace(/\{updaterInfo\}/g, updaterInfo)
    message = message.replace(/\{notice\}/g, config.notice || '')
    message = message.replace(/\{address\}/g, config.address || '')
    message = message.replace(/\{directionGuide\}/g, config.directionGuide || '')
    message = message.replace(/\{waitTime\}/g, waitTime.toString())
    message = message.replace(/\{nextPlayTime\}/g, nextPlayTime?.toString() ?? '0')
    message = message.replace(/\{minutesAgo\}/g, status.updateTime ? minutesAgo.toString() : '')
    message = message.replace(/\{diff\}/g, diffStr)
    message = message.replace(/\{xql_num\}/g, (status.coupleCount || 0).toString())
    message = message.replace(/\{nearcadeCount\}/g, isNearcadeEnabled(config) && nearcadeCount !== null ? nearcadeCountDisplay.toString() : '0')
    message = message.replace(/\{nearcadeTotal\}/g, isNearcadeEnabled(config) ? nearcadeTotal.toString() : '0')
    message = message.replace(/\{nearcadeDiff\}/g, isNearcadeEnabled(config) ? nearcadeDiffStr : '0')
    message = message.replace(/\{nearcadeLink\}/g, nearcadeLink)
    message = message.replace(/\{nearcadeSyncStatus\}/g, nearcadeSyncStatus)
    message = message.replace(/\{footer\}/g, enableMessageFooter ? (messageFooter || '') : '')
    message = message.replace(/\{confidence\}/g, prediction.confidence.toString())
    message = message.replace(/\{sampleCount\}/g, prediction.sampleCount.toString())
    message = message.replace(/\{modelInfo\}/g, modelInfo)
    message = message.replace(/\{predictedCount\}/g, trend.predictedCount.toString())
    message = message.replace(/\{predictedRange\}/g, predictedRange)
    message = message.replace(/\{minutesAhead\}/g, trend.minutesAhead.toString())
    message = message.replace(/\{trendDesc\}/g, trendDesc)
    message = message.replace(/\{dayTypeLabel\}/g, recommendation.dayTypeLabel)
    message = message.replace(/\{weekdayWeekendHint\}/g, weekdayWeekendHint)
    message = message.replace(/\{forecastDisclaimer\}/g, FORECAST_DISCLAIMER)
    if (!weekdayWeekendHint) {
      message = message.replace(/\n\{weekdayWeekendHint\}/g, '')
      message = message.replace(/\{weekdayWeekendHint\}\n?/g, '')
    }

    message = message.replace(/\{forecastHours\}/g, forecastHours.toString())
    message = message.replace(/\{forecastSchedule\}/g, forecastSchedule)
    message = message.replace(/\{forecastRecommendation\}/g, recommendation.reason)
    message = message.replace(/\{predictionMethod\}/g, prediction.method)
    message = message.replace(/\{nearcadeDataPoints\}/g, nearcadeDataPoints.toString())
    message = message.replace(/\{avgPlayMinutes\}/g, predictor.getPlayMinutes(arcadeId, defaultPlayTimePerPerson).toString())

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
      message = message.replace(/🪧 店铺通知: \n\n\n/g, '')
      message = message.replace(/🪧 店铺通知: \n\n/g, '')
      message = message.replace(/🪧 店铺通知: \n/g, '')
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

    if (!enableMessageFooter || !messageFooter) {
      message = message.replace(/\n\{footer\}/g, '')
      message = message.replace(/\{footer\}\n?/g, '')
    }

    return message.trimEnd()
  }

  async function buildPredictChart(arcadeId: string, arcade: ArcadeData, currentCount: number): Promise<string | null> {
    const machineCount = arcade.config.machineCount || defaultMachineCount
    const capacity = machineCount * playersPerMachine
    const pctx = buildPredictorContext(arcade)
    const forecast = predictor.predictForecast(arcadeId, currentCount, forecastHours, forecastStepMinutes, pctx)
    const points = predictor.getChartPoints(arcadeId, DEFAULT_HISTORY_HOURS, pctx)

    if (points.length === 0) return null

    const svg = generateQueueChartSvg({
      title: arcade.config.name,
      capacity,
      points,
      predictedPoints: forecast.map(p => ({
        timestamp: p.timestamp,
        count: p.predictedCount,
        source: 'forecast' as const,
        label: p.label,
      })),
      historyHours: DEFAULT_CHART_HISTORY_HOURS,
      forecastHours,
    })

    return renderChartToPng(svg, getChartFilePath(arcadeId))
  }

  async function generateQueryMessage(arcadeId: string, arcade: ArcadeData): Promise<string> {
    const effective = await resolveEffectiveCount(arcadeId, arcade)
    const template = arcade.config.queryMessageTemplate || defaultQueryTemplate
    return replaceTemplateVariables(template, arcadeId, arcade, undefined, {
      nearcadeData: effective.nearcadeData,
      nearcadeCount: effective.nearcadeCount,
      effectiveCount: effective.count,
      countFromNearcade: effective.fromNearcade,
      arcadeId,
    })
  }

  async function generatePredictMessage(arcadeId: string, arcade: ArcadeData): Promise<{ text: string, chartPath: string | null }> {
    const effective = await resolveEffectiveCount(arcadeId, arcade)
    const template = arcade.config.predictMessageTemplate || defaultPredictTemplate
    const text = replaceTemplateVariables(template, arcadeId, arcade, undefined, {
      nearcadeData: effective.nearcadeData,
      nearcadeCount: effective.nearcadeCount,
      effectiveCount: effective.count,
      countFromNearcade: effective.fromNearcade,
      arcadeId,
      isPredict: true,
    })
    const chartPath = await buildPredictChart(arcadeId, arcade, effective.count)
    return { text, chartPath }
  }

  // 群里还有个送9.9特饮外卖的
  async function Nieoooooo(
    arcadeId: string,
    arcade: ArcadeData,
    diff?: number,
    nearcadeSyncStatus = '',
  ): Promise<string> {
    const effective = await resolveEffectiveCount(arcadeId, arcade)
    const template = arcade.config.reportMessageTemplate || defaultReportTemplate
    return replaceTemplateVariables(template, arcadeId, arcade, diff, {
      nearcadeData: effective.nearcadeData,
      nearcadeCount: effective.nearcadeCount,
      nearcadeSyncStatus,
      effectiveCount: effective.count,
      countFromNearcade: effective.fromNearcade,
      arcadeId,
    })
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

  function parsePredictCommand(text: string): string | null {
    const match = text.match(/^predict\s+([a-zA-Z\u4e00-\u9fa5]+)$/i)
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
    recordQueueEvent(arcadeId, arcade, peopleDiff)
    const reporter = getReporterFromSession(session)
    const syncStatus = await TrusTKB(arcade, newCount, reporter.name, reporter.id)
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
          const titleName = getNearcadeTitleName(game.titleId)
          lines.push(`  · ${game.name} — ${titleName} (titleId=${game.titleId}, gameId=${game.gameId})`)
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

    const predictAlias = parsePredictCommand(text)
    if (predictAlias) {
      const arcadeId = getArcadeId(predictAlias)
      if (arcadeId) {
        const channel = session.event.channel
        const channelTypeStr = channel ? String(channel.type) : ''
        const isGroup = channel && (channelTypeStr === 'group' || channelTypeStr === '0')
        if (isGroup && !checkGroupWhitelist(arcadeId, channel.id)) return
        const arcade = arcades[arcadeId]
        if (arcade) {
          const { text, chartPath } = await generatePredictMessage(arcadeId, arcade)
          const elements = [h.text(text)]
          if (chartPath && fs.existsSync(chartPath)) {
            const imageData = fs.readFileSync(chartPath)
            const mime = chartPath.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
            elements.push(h.image(imageData, mime))
          }
          await session.send(elements)
          return
        }
      }
      await session.send(`未找到机厅别名「${predictAlias}」，请检查配置中的 aliases`)
      return
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
      recordQueueEvent(arcadeId, arcade, diff)
      const reporter = getReporterFromSession(session)
      const syncStatus = await TrusTKB(arcade, newCount, reporter.name, reporter.id)
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
