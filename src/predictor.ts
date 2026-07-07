import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import type { ChartPoint } from './chart'
import { forwardFillHistorySeries } from './chart'
import {
  type OperatingHours,
  type PredictorContext,
  formatDateLabel,
  getDefaultOperatingHours,
  getGraceProgress,
  isMidnightResetEvent,
  isOperatingHour,
  isOperatingOrGrace,
  validateQueueEvent,
} from './event-quality'

export type { OperatingHours, PredictorContext }

export interface QueueHistoryEntry {
  timestamp: string
  count: number
  diff: number
  machineCount: number
  source: 'local' | 'nearcade'
}

export type DayType = 'weekday' | 'weekend'

export interface ArcadePredictionModel {
  avgPlayMinutes: number
  avgArrivalRate: number
  avgDepartureRate: number
  sampleCount: number
  hourAvgCount: number[]
  hourAvgCountWeekday: number[]
  hourAvgCountWeekend: number[]
}

interface ArcadeHistoryData {
  model: ArcadePredictionModel
  events: QueueHistoryEntry[]
}

interface HistoryFileData {
  [arcadeId: string]: ArcadeHistoryData
}

const MAX_EVENTS_PER_ARCADE = 1000
const EMA_ALPHA = 0.12
const MIN_SAMPLES_FOR_MODEL = 3
/** 舞萌DX 单轮时长：1P 约 14 分钟，2P 约 17 分钟 */
const ROUND_MINUTES_1P = 14
const ROUND_MINUTES_2P = 17
/** 空闲时平均每台 1P/2P 混合人数下限；拥挤时趋近 2（小情侣/拼机变多） */
const GROUP_SIZE_MIN = 1.3
/** 「打完不报」衰减时间常数（分钟）：上报越陈旧，队列有效人数越低 */
const UNREPORTED_DECAY_MINUTES = 90
/** 单次游玩时长学习上限（防止稀疏上报拉长间隔） */
const PLAY_SAMPLE_MAX_MINUTES = 22
const PLAY_ELAPSED_MAX_MINUTES = 45
export const DEFAULT_FORECAST_HOURS = 8
export const DEFAULT_FORECAST_STEP_MINUTES = 30
export const DEFAULT_HISTORY_HOURS = 24
export const FORECAST_DISCLAIMER = '⚠️ 以上预测仅供参考，实际人数以现场为准'

export interface WaitTimePrediction {
  waitMinutes: number
  nextPlayMinutes: number | null
  fromModel: boolean
  confidence: number
  sampleCount: number
  method: string
  peakHourHint?: string
  dayTypeLabel?: string
}

export interface TrendPrediction {
  predictedCount: number
  trendPerHour: number
  minutesAhead: number
  lowerBound: number
  upperBound: number
}

export interface ForecastPoint {
  minutesAhead: number
  timestamp: number
  predictedCount: number
  lowerBound: number
  upperBound: number
  label: string
  dayType: DayType
}

export interface ForecastRecommendation {
  bestMinutes: number
  bestLabel: string
  bestCount: number
  reason: string
  dayTypeLabel: string
  weekdayWeekendHint?: string
}

export interface NearcadeReportInput {
  count: number
  reportedAt: string
  machineCount: number
}

function emptyHourArray(): number[] {
  return Array.from({ length: 24 }, () => 0)
}

function defaultModel(): ArcadePredictionModel {
  return {
    avgPlayMinutes: 0,
    avgArrivalRate: 0,
    avgDepartureRate: 0,
    sampleCount: 0,
    hourAvgCount: emptyHourArray(),
    hourAvgCountWeekday: emptyHourArray(),
    hourAvgCountWeekend: emptyHourArray(),
  }
}

function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

function getDayType(date: Date): DayType {
  return isWeekend(date) ? 'weekend' : 'weekday'
}

function getDayTypeLabel(date: Date): string {
  return isWeekend(date) ? '周末' : '周中'
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatAheadLabel(minutesAhead: number): string {
  const hours = minutesAhead / 60
  if (minutesAhead < 60) return `${minutesAhead}分钟`
  if (Number.isInteger(hours)) return `${hours}小时`
  const h = Math.floor(hours)
  const m = minutesAhead % 60
  return m > 0 ? `${h}小时${m}分` : `${h}小时`
}

/** 加权最小二乘：越新的样本权重越高 */
function linearRegression(points: Array<{ x: number, y: number, w?: number }>) {
  if (points.length < 2) return { slope: 0, intercept: points[0]?.y ?? 0 }
  let sumW = 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const p of points) {
    const w = p.w ?? 1
    sumW += w
    sumX += w * p.x
    sumY += w * p.y
    sumXY += w * p.x * p.y
    sumXX += w * p.x * p.x
  }
  if (sumW === 0) return { slope: 0, intercept: 0 }
  const denom = sumW * sumXX - sumX * sumX
  if (Math.abs(denom) < 1e-9) return { slope: 0, intercept: sumY / sumW }
  const slope = (sumW * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / sumW
  return { slope, intercept }
}

function smoothSeries(values: number[], window = 3): number[] {
  if (values.length <= 2) return values
  const half = Math.floor(window / 2)
  return values.map((_, i) => {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j]
      count++
    }
    return Math.round(sum / count)
  })
}

export class ArcadePredictor {
  private data: HistoryFileData = {}
  private dataFilePath: string

  constructor(baseDir: string) {
    const dataDir = path.join(baseDir, 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    this.dataFilePath = path.join(dataDir, 'mai-queue-history.yml')
    this.load()
  }

  private normalizeModel(model: ArcadePredictionModel) {
    if (!model.hourAvgCount || model.hourAvgCount.length !== 24) {
      model.hourAvgCount = emptyHourArray()
    }
    if (!model.hourAvgCountWeekday || model.hourAvgCountWeekday.length !== 24) {
      model.hourAvgCountWeekday = [...model.hourAvgCount]
    }
    if (!model.hourAvgCountWeekend || model.hourAvgCountWeekend.length !== 24) {
      model.hourAvgCountWeekend = [...model.hourAvgCount]
    }
    if (typeof model.avgArrivalRate !== 'number') model.avgArrivalRate = 0
    if (typeof model.avgDepartureRate !== 'number') model.avgDepartureRate = 0
  }

  private load() {
    try {
      if (!fs.existsSync(this.dataFilePath)) return
      const parsed = yaml.parse(fs.readFileSync(this.dataFilePath, 'utf8')) as HistoryFileData | null
      if (parsed && typeof parsed === 'object') {
        this.data = parsed
        for (const arcade of Object.values(this.data)) {
          this.normalizeModel(arcade.model)
          for (const event of arcade.events) {
            if (!event.source) event.source = 'local'
          }
        }
      }
    } catch {
      this.data = {}
    }
  }

  private save() {
    try {
      fs.writeFileSync(
        this.dataFilePath,
        yaml.stringify(this.data, { indent: 2, lineWidth: 0 }),
        'utf8',
      )
    } catch {
      // persistence failure should not break the bot
    }
  }

  private getContext(ctx: PredictorContext = {}): Required<Pick<PredictorContext, 'operatingHours'>> & PredictorContext {
    return {
      operatingHours: ctx.operatingHours ?? getDefaultOperatingHours(),
      ...ctx,
    }
  }

  private maxReasonableCount(ctx: PredictorContext): number | undefined {
    const mc = ctx.machineCount
    const ppm = ctx.playersPerMachine ?? 2
    if (!mc) return undefined
    return mc * ppm * 6
  }

  private isTrustedEvent(entry: QueueHistoryEntry, ctx: PredictorContext): boolean {
    return validateQueueEvent(entry.timestamp, entry.count, entry.diff, {
      operatingHours: ctx.operatingHours,
      maxCount: this.maxReasonableCount(ctx),
    }).trusted
  }

  private getTrustedEvents(arcadeId: string, ctx: PredictorContext, sinceMs?: number) {
    const arcade = this.ensureArcade(arcadeId)
    const resolved = this.getContext(ctx)
    return arcade.events.filter(e => {
      if (sinceMs !== undefined && new Date(e.timestamp).getTime() < sinceMs) return false
      return this.isTrustedEvent(e, resolved)
    })
  }

  private applyPlayTimeSample(model: ArcadePredictionModel, perPerson: number) {
    if (model.sampleCount === 0) {
      model.avgPlayMinutes = perPerson
    } else {
      model.avgPlayMinutes = EMA_ALPHA * perPerson + (1 - EMA_ALPHA) * model.avgPlayMinutes
    }
    model.sampleCount++
  }

  private updatePlayTimeModelOnEvents(
    events: QueueHistoryEntry[],
    model: ArcadePredictionModel,
    peopleLeft: number,
    timestamp: string,
  ) {
    if (events.length < 2) return
    const currentIdx = events.length - 1
    const targetCount = events[currentIdx].count + peopleLeft
    for (let i = currentIdx - 1; i >= 0; i--) {
      if (events[i].count >= targetCount) {
        const elapsed = (new Date(timestamp).getTime() - new Date(events[i].timestamp).getTime()) / 60000
        if (elapsed > 1 && elapsed < PLAY_ELAPSED_MAX_MINUTES) {
          const perPerson = Math.min(PLAY_SAMPLE_MAX_MINUTES, elapsed / peopleLeft)
          this.applyPlayTimeSample(model, perPerson)
        }
        break
      }
    }
  }

  private updateArrivalRateOnEvents(
    events: QueueHistoryEntry[],
    model: ArcadePredictionModel,
    peopleJoined: number,
    timestamp: string,
  ) {
    if (events.length < 2) return
    const prev = events[events.length - 2]
    const elapsedHours = (new Date(timestamp).getTime() - new Date(prev.timestamp).getTime()) / 3600000
    if (elapsedHours <= 0 || elapsedHours > 6) return
    const rate = peopleJoined / elapsedHours
    model.avgArrivalRate = model.avgArrivalRate === 0
      ? rate
      : EMA_ALPHA * rate + (1 - EMA_ALPHA) * model.avgArrivalRate
  }

  private updateDepartureRateOnEvents(
    events: QueueHistoryEntry[],
    model: ArcadePredictionModel,
    peopleLeft: number,
    timestamp: string,
  ) {
    if (events.length < 2) return
    const prev = events[events.length - 2]
    const elapsedHours = (new Date(timestamp).getTime() - new Date(prev.timestamp).getTime()) / 3600000
    if (elapsedHours <= 0 || elapsedHours > 6) return
    const rate = peopleLeft / elapsedHours
    model.avgDepartureRate = model.avgDepartureRate === 0
      ? rate
      : EMA_ALPHA * rate + (1 - EMA_ALPHA) * model.avgDepartureRate
  }

  private rebuildModelFromEvents(arcade: ArcadeHistoryData, ctx: PredictorContext) {
    const trusted = [...arcade.events]
    arcade.model = defaultModel()
    const replay: QueueHistoryEntry[] = []
    for (const entry of trusted) {
      replay.push(entry)
      if (isMidnightResetEvent(new Date(entry.timestamp), entry.count, entry.diff)) continue
      this.updateHourProfile(arcade.model, entry.timestamp, entry.count)
      if (entry.diff < 0) {
        this.updatePlayTimeModelOnEvents(replay, arcade.model, Math.abs(entry.diff), entry.timestamp)
        this.updateDepartureRateOnEvents(replay, arcade.model, Math.abs(entry.diff), entry.timestamp)
      } else if (entry.diff > 0) {
        this.updateArrivalRateOnEvents(replay, arcade.model, entry.diff, entry.timestamp)
      }
    }
  }

  private sanitizeArcade(arcadeId: string, ctx: PredictorContext = {}) {
    const arcade = this.ensureArcade(arcadeId)
    const resolved = this.getContext(ctx)
    const before = arcade.events.length
    arcade.events = arcade.events.filter(e => this.isTrustedEvent(e, resolved))
    const removed = before - arcade.events.length
    this.rebuildModelFromEvents(arcade, resolved)
    return removed
  }

  private calculateConfidence(
    arcadeId: string,
    ctx: PredictorContext,
    fromModel: boolean,
  ): number {
    const now = Date.now()
    const resolved = this.getContext(ctx)
    const trusted = this.getTrustedEvents(arcadeId, resolved)
    const recent12h = trusted.filter(e => new Date(e.timestamp).getTime() >= now - 12 * 3600000)
    const recent24h = trusted.filter(e => new Date(e.timestamp).getTime() >= now - 24 * 3600000)
    const nearcadeRecent = recent24h.filter(e => e.source === 'nearcade').length
    const model = this.ensureArcade(arcadeId).model

    let score = 12
    if (fromModel) score += Math.min(20, model.sampleCount * 1.2)
    score += Math.min(18, recent12h.length * 1.5)
    score += Math.min(8, nearcadeRecent * 2)

    const operatingRatio = recent24h.length > 0
      ? recent24h.filter(e => isOperatingHour(new Date(e.timestamp), resolved.operatingHours)).length / recent24h.length
      : 0
    score *= 0.5 + operatingRatio * 0.5

    if (recent12h.length < 4) score = Math.min(score, 35)
    else if (recent12h.length < 8) score = Math.min(score, 55)
    else if (recent12h.length < 15) score = Math.min(score, 72)

    if (!fromModel) score = Math.min(score, 40)

    return Math.max(8, Math.min(85, Math.round(score)))
  }

  private ensureArcade(arcadeId: string): ArcadeHistoryData {
    if (!this.data[arcadeId]) {
      this.data[arcadeId] = {
        model: defaultModel(),
        events: [],
      }
    }
    this.normalizeModel(this.data[arcadeId].model)
    return this.data[arcadeId]
  }

  private updateHourProfile(model: ArcadePredictionModel, timestamp: string, count: number) {
    const date = new Date(timestamp)
    const hour = date.getHours()
    const profile = isWeekend(date) ? model.hourAvgCountWeekend : model.hourAvgCountWeekday
    const prev = profile[hour] || 0
    profile[hour] = prev === 0 ? count : EMA_ALPHA * count + (1 - EMA_ALPHA) * prev
    model.hourAvgCount[hour] = model.hourAvgCount[hour] === 0
      ? count
      : EMA_ALPHA * count + (1 - EMA_ALPHA) * model.hourAvgCount[hour]
  }

  private getHourProfileValue(model: ArcadePredictionModel, date: Date): number {
    const hour = date.getHours()
    const profile = isWeekend(date) ? model.hourAvgCountWeekend : model.hourAvgCountWeekday
    return profile[hour] || 0
  }

  private pushEvent(arcade: ArcadeHistoryData, entry: QueueHistoryEntry) {
    const last = arcade.events[arcade.events.length - 1]
    if (
      last
      && last.count === entry.count
      && last.source === entry.source
      && Math.abs(new Date(last.timestamp).getTime() - new Date(entry.timestamp).getTime()) < 60000
    ) {
      return
    }

    arcade.events.push(entry)
    if (arcade.events.length > MAX_EVENTS_PER_ARCADE) {
      arcade.events = arcade.events.slice(-MAX_EVENTS_PER_ARCADE)
    }

    // 凌晨清零事件不写入时段画像，避免拉低宽容期均值
    if (!isMidnightResetEvent(new Date(entry.timestamp), entry.count, entry.diff)) {
      this.updateHourProfile(arcade.model, entry.timestamp, entry.count)
    }
  }

  recordEvent(
    arcadeId: string,
    count: number,
    diff: number,
    machineCount: number,
    timestamp = new Date().toISOString(),
    source: 'local' | 'nearcade' = 'local',
    ctx: PredictorContext = {},
  ): boolean {
    const resolved = this.getContext({ ...ctx, machineCount: ctx.machineCount ?? machineCount })
    const validation = validateQueueEvent(timestamp, count, diff, {
      operatingHours: resolved.operatingHours,
      maxCount: this.maxReasonableCount(resolved),
    })
    if (!validation.trusted) return false

    const arcade = this.ensureArcade(arcadeId)
    const entry: QueueHistoryEntry = { timestamp, count, diff, machineCount, source }
    this.pushEvent(arcade, entry)

    // 凌晨 0 点系统清零不是真实离场，不参与速率学习
    const isReset = isMidnightResetEvent(new Date(timestamp), count, diff)
    if (!isReset) {
      if (diff < 0) {
        this.updatePlayTimeModelOnEvents(arcade.events, arcade.model, Math.abs(diff), timestamp)
        this.updateDepartureRateOnEvents(arcade.events, arcade.model, Math.abs(diff), timestamp)
      } else if (diff > 0) {
        this.updateArrivalRateOnEvents(arcade.events, arcade.model, diff, timestamp)
      }
    }

    this.save()
    return true
  }

  importNearcadeReports(arcadeId: string, reports: NearcadeReportInput[], ctx: PredictorContext = {}) {
    if (!reports.length) return 0
    const arcade = this.ensureArcade(arcadeId)
    const sorted = [...reports].sort(
      (a, b) => new Date(a.reportedAt).getTime() - new Date(b.reportedAt).getTime(),
    )

    let imported = 0
    let prevCount: number | null = null
    for (const report of sorted) {
      const diff = prevCount === null ? 0 : report.count - prevCount
      const exists = arcade.events.some(
        e => e.source === 'nearcade'
          && e.timestamp === report.reportedAt
          && e.count === report.count,
      )
      if (!exists) {
        const ok = this.recordEvent(
          arcadeId,
          report.count,
          diff,
          report.machineCount,
          report.reportedAt,
          'nearcade',
          ctx,
        )
        if (ok) imported++
      }
      prevCount = report.count
    }

    if (imported > 0) this.save()
    return imported
  }

  sanitizeAll(ctxByArcade: Record<string, PredictorContext> = {}) {
    let totalRemoved = 0
    for (const arcadeId of Object.keys(this.data)) {
      totalRemoved += this.sanitizeArcade(arcadeId, ctxByArcade[arcadeId] ?? {})
    }
    if (totalRemoved > 0) this.save()
    return totalRemoved
  }

  private updatePlayTimeModel(arcade: ArcadeHistoryData, peopleLeft: number, timestamp: string) {
    this.updatePlayTimeModelOnEvents(arcade.events, arcade.model, peopleLeft, timestamp)
  }

  private updateArrivalRate(arcade: ArcadeHistoryData, peopleJoined: number, timestamp: string) {
    this.updateArrivalRateOnEvents(arcade.events, arcade.model, peopleJoined, timestamp)
  }

  private updateDepartureRate(arcade: ArcadeHistoryData, peopleLeft: number, timestamp: string) {
    this.updateDepartureRateOnEvents(arcade.events, arcade.model, peopleLeft, timestamp)
  }

  /**
   * 舞萌DX 单轮周转模型。
   * 拥挤度 crowd ∈ [0,1] 提升时：单轮时长 14→17 分钟（2P 占比升高），
   * 每台每轮平均消化人数 1.3→2.0。
   */
  private maimaiRoundModel(queue: number, capacity: number) {
    const crowd = Math.min(1, Math.max(0, queue / Math.max(1, capacity)))
    const roundMinutes = ROUND_MINUTES_1P + (ROUND_MINUTES_2P - ROUND_MINUTES_1P) * crowd
    const groupSize = GROUP_SIZE_MIN + (2 - GROUP_SIZE_MIN) * crowd
    return { crowd, roundMinutes, groupSize }
  }

  /** 「打完不报」修正：距上次上报越久，排队人数按指数衰减越多 */
  private staleQueueFactor(minutesSinceUpdate: number): number {
    if (minutesSinceUpdate <= 5) return 1
    return Math.exp(-(minutesSinceUpdate - 5) / UNREPORTED_DECAY_MINUTES)
  }

  private formulaWaitTime(
    currentCount: number,
    machineCount: number,
    playersPerMachine: number,
    minutesSinceUpdate = 0,
  ): number {
    const totalCapacity = machineCount * playersPerMachine
    if (currentCount <= totalCapacity) return 0

    // 有效队列 = 报数超额 × 陈旧度衰减（有人打完直接走没报数）
    const rawQueue = currentCount - totalCapacity
    const queue = rawQueue * this.staleQueueFactor(minutesSinceUpdate)
    if (queue < 0.5) return 0

    const { roundMinutes, groupSize } = this.maimaiRoundModel(queue, totalCapacity)

    // 每轮全场吞吐 = 机台数 × 每台混合人数；机台错峰结束，平均再等 0.45 轮
    const throughputPerRound = machineCount * groupSize
    const roundsAhead = queue / throughputPerRound
    return Math.round(roundMinutes * (roundsAhead + 0.45))
  }

  private simulationWaitTime(
    currentCount: number,
    capacity: number,
    model: ArcadePredictionModel,
    formulaWait: number,
    minutesSinceUpdate = 0,
  ): number | null {
    if (currentCount <= capacity) return 0
    if (model.avgDepartureRate <= 0) return null
    const queue = (currentCount - capacity) * this.staleQueueFactor(minutesSinceUpdate)
    const raw = Math.round((queue / model.avgDepartureRate) * 60)
    // 仿真不应显著高于公式（稀疏上报常低估离场速率）
    return Math.min(raw, Math.round(formulaWait * 1.15 + 3))
  }

  getPlayMinutes(arcadeId: string, defaultPlayMinutes: number): number {
    const model = this.ensureArcade(arcadeId).model
    if (model.sampleCount >= MIN_SAMPLES_FOR_MODEL && model.avgPlayMinutes > 0) {
      return Math.round(model.avgPlayMinutes)
    }
    return defaultPlayMinutes
  }

  getWeekdayWeekendHint(arcadeId: string, currentCount: number, ctx: PredictorContext = {}): string | undefined {
    const model = this.ensureArcade(arcadeId).model
    const now = new Date()
    const hour = now.getHours()
    const weekdayAvg = model.hourAvgCountWeekday[hour] || 0
    const weekendAvg = model.hourAvgCountWeekend[hour] || 0
    if (weekdayAvg <= 0 && weekendAvg <= 0) return undefined

    const resolved = this.getContext(ctx)
    if (!isOperatingHour(now, resolved.operatingHours)) return undefined

    const currentType = getDayTypeLabel(now)
    const otherType = isWeekend(now) ? '周中' : '周末'
    const otherAvg = isWeekend(now) ? weekdayAvg : weekendAvg
    const currentAvg = isWeekend(now) ? weekendAvg : weekdayAvg

    if (currentAvg > 0 && otherAvg > 0) {
      const diff = Math.round(otherAvg - currentAvg)
      if (Math.abs(diff) >= 2) {
        if (diff > 0) {
          return `同时段${otherType}通常多约 ${diff} 人（${otherType}均值 ~${Math.round(otherAvg)}）`
        }
        return `同时段${otherType}通常少约 ${Math.abs(diff)} 人（${otherType}均值 ~${Math.round(otherAvg)}）`
      }
    }

    if (currentAvg > 0) {
      const rel = currentCount > currentAvg * 1.25 ? '偏高' : currentCount < currentAvg * 0.75 ? '偏低' : '正常'
      if (rel !== '正常') {
        return `当前为${currentType}，同时段${currentType}均值约 ${Math.round(currentAvg)} 人（${rel}）`
      }
    }
    return undefined
  }

  predictWaitTime(
    arcadeId: string,
    currentCount: number,
    machineCount: number,
    playersPerMachine: number,
    defaultPlayMinutes: number,
    hasLastPlayTime: boolean,
    ctx: PredictorContext = {},
    minutesSinceUpdate = 0,
  ): WaitTimePrediction {
    const arcade = this.ensureArcade(arcadeId)
    const model = arcade.model
    const resolved = this.getContext({ ...ctx, machineCount, playersPerMachine })
    const capacity = machineCount * playersPerMachine
    const fromModel = model.sampleCount >= MIN_SAMPLES_FOR_MODEL && model.avgPlayMinutes > 0
    const now = new Date()

    const formulaWait = this.formulaWaitTime(currentCount, machineCount, playersPerMachine, minutesSinceUpdate)
    const simWait = this.simulationWaitTime(currentCount, capacity, model, formulaWait, minutesSinceUpdate)

    let waitMinutes = formulaWait
    let method = '舞萌周转模型'
    if (simWait !== null && model.avgDepartureRate > 0) {
      // 周转公式更贴近舞萌体感，离场速率仿真仅作辅助
      waitMinutes = Math.round(formulaWait * 0.75 + simWait * 0.25)
      method = '舞萌周转 + 队列仿真'
    } else if (fromModel) {
      method = '舞萌周转 + 时段模型'
    }

    // 软上限：常态排队约一轮多（≤22 分钟），深度排队缓慢递增
    const excessRounds = Math.max(0, Math.ceil((currentCount - capacity) / capacity) - 1)
    const softCap = 22 + excessRounds * 5
    waitMinutes = Math.min(waitMinutes, softCap)

    const profileValue = this.getHourProfileValue(model, now)
    let peakHourHint: string | undefined
    if (profileValue > 0 && isOperatingHour(now, resolved.operatingHours)) {
      if (currentCount > profileValue * 1.25) {
        peakHourHint = `当前高于${getDayTypeLabel(now)}同时段均值（约 ${Math.round(profileValue)} 人）`
      } else if (currentCount < profileValue * 0.75) {
        peakHourHint = `当前低于${getDayTypeLabel(now)}同时段均值（约 ${Math.round(profileValue)} 人）`
      }
    }

    // 下次上机 = 排队等待 + 一轮游玩（按当前拥挤度取 14–17 分钟）
    const { roundMinutes } = this.maimaiRoundModel(
      Math.max(0, currentCount - capacity),
      capacity,
    )
    const nextPlayMinutes = hasLastPlayTime
      ? waitMinutes + Math.round(roundMinutes)
      : null

    const confidence = this.calculateConfidence(arcadeId, resolved, fromModel)
    const trustedCount = this.getTrustedEvents(arcadeId, resolved).length

    return {
      waitMinutes: Math.round(waitMinutes),
      nextPlayMinutes: nextPlayMinutes !== null ? Math.round(nextPlayMinutes) : null,
      fromModel,
      confidence,
      sampleCount: trustedCount > 0 ? model.sampleCount : 0,
      method,
      peakHourHint,
      dayTypeLabel: getDayTypeLabel(now),
    }
  }

  predictTrend(
    arcadeId: string,
    currentCount: number,
    minutesAhead = DEFAULT_FORECAST_HOURS * 60,
    ctx: PredictorContext = {},
  ): TrendPrediction {
    const point = this.predictAtMinutes(arcadeId, currentCount, minutesAhead, minutesAhead, ctx)
    return {
      predictedCount: point.predictedCount,
      trendPerHour: point.trendPerHour,
      minutesAhead,
      lowerBound: point.lowerBound,
      upperBound: point.upperBound,
    }
  }

  private getRegressionModel(arcadeId: string, currentCount: number, ctx: PredictorContext, now = Date.now()) {
    const cutoff = now - 12 * 60 * 60 * 1000
    const nowDate = new Date(now)
    const currentDayType = getDayType(nowDate)
    const resolved = this.getContext(ctx)

    const recent = this.getTrustedEvents(arcadeId, resolved, cutoff)
    const sameDayType = recent.filter(e => getDayType(new Date(e.timestamp)) === currentDayType)
    const pool = sameDayType.length >= 4 ? sameDayType : recent

    if (pool.length < 3) {
      return { slope: 0, intercept: currentCount, margin: 1, cutoff, now }
    }

    // 指数时间加权：6 小时半衰期，近期样本主导趋势
    const points = pool.map(e => {
      const ts = new Date(e.timestamp).getTime()
      const ageHours = (now - ts) / 3600000
      return {
        x: (ts - cutoff) / 3600000,
        y: e.count,
        w: Math.exp(-ageHours / 6),
      }
    })
    points.push({ x: (now - cutoff) / 3600000, y: currentCount, w: 1.2 })

    const { slope, intercept } = linearRegression(points)
    const residuals = points.map(p => Math.abs(p.y - (intercept + slope * p.x)))
    const avgResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length
    const margin = Math.max(1, Math.round(avgResidual * 1.6))

    return { slope, intercept, margin, cutoff, now }
  }

  predictAtMinutes(
    arcadeId: string,
    currentCount: number,
    minutesAhead: number,
    forecastHorizonMinutes = DEFAULT_FORECAST_HOURS * 60,
    ctx: PredictorContext = {},
    referenceTime = Date.now(),
  ) {
    const arcade = this.ensureArcade(arcadeId)
    const model = arcade.model
    const resolved = this.getContext(ctx)
    const regression = this.getRegressionModel(arcadeId, currentCount, resolved, referenceTime)
    const futureDate = new Date(regression.now + minutesAhead * 60000)

    if (!isOperatingOrGrace(futureDate, resolved.operatingHours)) {
      return {
        predictedCount: 0,
        lowerBound: 0,
        upperBound: 1,
        trendPerHour: 0,
      }
    }

    const futureX = (regression.now - regression.cutoff) / 3600000 + minutesAhead / 60
    const regressionPred = regression.intercept + regression.slope * futureX
    const profilePred = this.getHourProfileValue(model, futureDate)
    const horizon = Math.max(forecastHorizonMinutes, 60)
    const progress = Math.min(1, minutesAhead / horizon)

    // 近期更信趋势，远期更信周中/周末时段画像
    const profileWeight = profilePred > 0 ? 0.15 + progress * 0.65 : 0
    const regressionWeight = 1 - profileWeight
    let blended = regressionWeight * regressionPred + profileWeight * profilePred

    // 闭店宽容期内人数随时间线性衰减至 0（延迟打烊，人越来越少）
    const graceProgress = getGraceProgress(futureDate, resolved.operatingHours)
    if (graceProgress !== null) {
      blended *= 1 - graceProgress
    }

    // 钳制到合理人数上限，防止外推爆表
    const cap = this.maxReasonableCount(resolved)
    if (cap !== undefined) {
      blended = Math.min(blended, cap)
    }

    const predicted = Math.max(0, Math.round(blended))

    return {
      predictedCount: predicted,
      lowerBound: Math.max(0, predicted - regression.margin),
      upperBound: predicted + regression.margin,
      trendPerHour: Math.round(regression.slope * 10) / 10,
    }
  }

  predictForecast(
    arcadeId: string,
    currentCount: number,
    hoursAhead = DEFAULT_FORECAST_HOURS,
    stepMinutes = DEFAULT_FORECAST_STEP_MINUTES,
    ctx: PredictorContext = {},
    referenceTime = Date.now(),
  ): ForecastPoint[] {
    const steps = Math.round((hoursAhead * 60) / stepMinutes)
    const result: ForecastPoint[] = []
    const now = referenceTime
    const horizonMinutes = hoursAhead * 60
    const rawCounts: number[] = []
    const nowDate = new Date(now)

    for (let i = 1; i <= steps; i++) {
      const minutesAhead = i * stepMinutes
      const point = this.predictAtMinutes(arcadeId, currentCount, minutesAhead, horizonMinutes, ctx, referenceTime)
      rawCounts.push(point.predictedCount)
    }

    const smoothed = smoothSeries(rawCounts, 3)

    for (let i = 1; i <= steps; i++) {
      const minutesAhead = i * stepMinutes
      const point = this.predictAtMinutes(arcadeId, currentCount, minutesAhead, horizonMinutes, ctx, referenceTime)
      const futureDate = new Date(now + minutesAhead * 60000)
      const resolved = this.getContext(ctx)
      let predictedCount = smoothed[i - 1]
      if (!isOperatingOrGrace(futureDate, resolved.operatingHours)) {
        predictedCount = 0
      } else if (getGraceProgress(futureDate, resolved.operatingHours) !== null) {
        // 宽容期内取平滑值与衰减值中较小者，保证向 0 收敛
        predictedCount = Math.min(predictedCount, point.predictedCount)
      }
      const margin = Math.max(1, point.upperBound - point.predictedCount)
      const showDate = futureDate.getDate() !== nowDate.getDate()
        || futureDate.getMonth() !== nowDate.getMonth()
      result.push({
        minutesAhead,
        timestamp: futureDate.getTime(),
        predictedCount,
        lowerBound: Math.max(0, predictedCount - margin),
        upperBound: predictedCount + margin,
        label: showDate ? formatDateLabel(futureDate) : formatClock(futureDate),
        dayType: getDayType(futureDate),
      })
    }
    return result
  }

  recommendVisitTime(
    forecast: ForecastPoint[],
    capacity: number,
    currentCount: number,
    arcadeId: string,
    ctx: PredictorContext = {},
    referenceTime = Date.now(),
  ): ForecastRecommendation {
    const now = new Date(referenceTime)
    const dayTypeLabel = getDayTypeLabel(now)
    const weekdayWeekendHint = this.getWeekdayWeekendHint(arcadeId, currentCount, ctx)
    const resolved = this.getContext(ctx)
    // 优先推荐正式营业时段；宽容期（快打烊）仅作兜底
    const strictOperating = forecast.filter(p =>
      p.predictedCount > 0
      && isOperatingHour(new Date(p.timestamp), resolved.operatingHours),
    )
    const withGrace = forecast.filter(p =>
      p.predictedCount > 0
      && isOperatingOrGrace(new Date(p.timestamp), resolved.operatingHours),
    )
    const pool = strictOperating.length ? strictOperating : (withGrace.length ? withGrace : forecast)

    if (!pool.length) {
      return {
        bestMinutes: 0,
        bestLabel: '现在',
        bestCount: currentCount,
        reason: '数据不足，建议参考当前人数',
        dayTypeLabel,
        weekdayWeekendHint,
      }
    }

    let best = pool[0]
    for (const point of pool) {
      const bestScore = best.predictedCount + (best.predictedCount > capacity ? 2 : 0)
      const pointScore = point.predictedCount + (point.predictedCount > capacity ? 2 : 0)
      if (pointScore < bestScore) best = point
    }

    const bestTime = new Date(now.getTime() + best.minutesAhead * 60000)
    const bestLabel = `${formatAheadLabel(best.minutesAhead)}后（${formatClock(bestTime)}，${getDayTypeLabel(bestTime)}）`

    let reason = `建议 ${bestLabel} 出勤，预计约 ${best.predictedCount} 人`
    if (best.predictedCount <= capacity) {
      reason += '，低于机台容量'
    } else if (best.predictedCount < currentCount) {
      reason += `，比当前少 ${currentCount - best.predictedCount} 人`
    }

    return {
      bestMinutes: best.minutesAhead,
      bestLabel,
      bestCount: best.predictedCount,
      reason,
      dayTypeLabel,
      weekdayWeekendHint,
    }
  }

  formatForecastSchedule(forecast: ForecastPoint[], bestMinutes: number): string {
    return forecast
      .filter(p => p.predictedCount > 0)
      .map(p => {
        const mark = p.minutesAhead === bestMinutes ? ' ★' : ''
        const typeTag = p.dayType === 'weekend' ? '末' : '中'
        return `· ${p.label}(${typeTag}) ~${p.predictedCount}人${mark}`
      }).join('\n')
  }

  getChartPoints(
    arcadeId: string,
    hours = DEFAULT_HISTORY_HOURS,
    ctx: PredictorContext = {},
    referenceTime = Date.now(),
  ): ChartPoint[] {
    const resolved = this.getContext(ctx)
    const cutoff = referenceTime - hours * 3600000
    const raw = this.getTrustedEvents(arcadeId, resolved, cutoff)
      .filter(e => new Date(e.timestamp).getTime() <= referenceTime)
      .map(e => ({
        timestamp: new Date(e.timestamp).getTime(),
        count: e.count,
        source: e.source,
      }))
    // 仅在营业+宽容时段内前向保持，夜间闭店曲线自然断开
    return forwardFillHistorySeries(
      raw,
      cutoff,
      referenceTime,
      30,
      ts => isOperatingOrGrace(new Date(ts), resolved.operatingHours),
    )
  }

  getArcadeIds(): string[] {
    return Object.keys(this.data)
  }

  getTrustedEventCount(arcadeId: string, ctx: PredictorContext = {}): number {
    return this.getTrustedEvents(arcadeId, ctx).length
  }

  getModel(arcadeId: string): ArcadePredictionModel {
    return { ...this.ensureArcade(arcadeId).model }
  }

  getNearcadeEventCount(arcadeId: string, ctx: PredictorContext = {}): number {
    return this.getTrustedEvents(arcadeId, ctx).filter(e => e.source === 'nearcade').length
  }
}
