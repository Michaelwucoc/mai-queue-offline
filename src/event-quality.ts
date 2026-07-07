export interface OperatingHours {
  openHour: number
  closeHour: number
  /** 闭店后宽容分钟数（延迟打烊仍可上报/预测，默认 90） */
  closeGraceMinutes?: number
}

export interface PredictorContext {
  operatingHours?: OperatingHours
  machineCount?: number
  playersPerMachine?: number
}

export interface EventValidationOptions {
  operatingHours?: OperatingHours
  maxCount?: number
  maxDiffPerEvent?: number
}

export interface EventValidationResult {
  trusted: boolean
  reason?: string
}

const DEFAULT_OPEN_HOUR = 10
const DEFAULT_CLOSE_HOUR = 23
export const DEFAULT_CLOSE_GRACE_MINUTES = 90

export function getDefaultOperatingHours(): OperatingHours {
  return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR, closeGraceMinutes: DEFAULT_CLOSE_GRACE_MINUTES }
}

export function resolveOperatingHours(
  global: OperatingHours,
  override?: { openHour?: number; closeHour?: number; closeGraceMinutes?: number },
): OperatingHours {
  return {
    openHour: override?.openHour ?? global.openHour,
    closeHour: override?.closeHour ?? global.closeHour,
    closeGraceMinutes: override?.closeGraceMinutes ?? global.closeGraceMinutes,
  }
}

/** 营业时段：openHour、closeHour 均含（默认 10–23 点） */
export function isOperatingHour(date: Date, hours: OperatingHours = getDefaultOperatingHours()): boolean {
  const h = date.getHours()
  const { openHour, closeHour } = hours
  if (openHour === closeHour) return true
  if (openHour < closeHour) return h >= openHour && h <= closeHour
  return h >= openHour || h <= closeHour
}

/** 含闭店宽容：正式营业结束后仍算有效时段（延迟打烊） */
export function isOperatingOrGrace(
  date: Date,
  hours: OperatingHours = getDefaultOperatingHours(),
): boolean {
  if (isOperatingHour(date, hours)) return true
  const grace = hours.closeGraceMinutes ?? 0
  if (grace <= 0) return false

  const mins = date.getHours() * 60 + date.getMinutes()
  const { openHour, closeHour } = hours

  if (openHour < closeHour) {
    const afterClose = (closeHour + 1) * 60
    const graceEnd = afterClose + grace
    if (mins >= afterClose && mins < Math.min(graceEnd, 24 * 60)) return true
    if (graceEnd > 24 * 60) {
      const nextDayGraceEnd = graceEnd - 24 * 60
      if (mins < nextDayGraceEnd) return true
    }
    return false
  }

  // 跨午夜营业（如 18–2）
  const afterClose = ((closeHour + 1) % 24) * 60
  if (closeHour >= openHour) return false
  if (mins >= afterClose && mins < afterClose + grace) return true
  return false
}

/** 处于闭店宽容期时返回 0–1 进度（1 = 宽容期结束），非宽容期返回 null */
export function getGraceProgress(
  date: Date,
  hours: OperatingHours = getDefaultOperatingHours(),
): number | null {
  if (isOperatingHour(date, hours)) return null
  if (!isOperatingOrGrace(date, hours)) return null
  const grace = hours.closeGraceMinutes ?? 0
  if (grace <= 0) return null
  const mins = date.getHours() * 60 + date.getMinutes()
  const afterClose = ((hours.closeHour + 1) % 24) * 60
  let past = mins - afterClose
  if (past < 0) past += 24 * 60
  return Math.min(1, Math.max(0, past / grace))
}

/** 凌晨 0 点附近的人数清零（平台/系统重置），不应视为真实离场 */
export function isMidnightResetEvent(date: Date, count: number, diff: number): boolean {
  return count === 0 && diff < 0 && date.getHours() === 0 && date.getMinutes() <= 30
}

export function parseEventDate(timestamp: string): Date | null {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export function validateQueueEvent(
  timestamp: string,
  count: number,
  diff: number,
  options: EventValidationOptions = {},
): EventValidationResult {
  const date = parseEventDate(timestamp)
  if (!date) {
    return { trusted: false, reason: '时间戳无效' }
  }

  const now = Date.now()
  if (date.getTime() > now + 5 * 60 * 1000) {
    return { trusted: false, reason: '未来时间' }
  }
  if (date.getTime() < now - 90 * 24 * 60 * 60 * 1000) {
    return { trusted: false, reason: '数据过旧' }
  }

  if (!Number.isFinite(count) || count < 0) {
    return { trusted: false, reason: '人数无效' }
  }

  const maxCount = options.maxCount
  if (maxCount !== undefined && count > maxCount) {
    return { trusted: false, reason: `人数超出合理上限（>${maxCount}）` }
  }

  const hours = options.operatingHours ?? getDefaultOperatingHours()
  if (!isOperatingOrGrace(date, hours) && count > 0) {
    return { trusted: false, reason: '非营业时段有人数上报' }
  }

  const maxDiff = options.maxDiffPerEvent ?? 20
  if (Math.abs(diff) > maxDiff) {
    return { trusted: false, reason: `单次变化过大（${diff}）` }
  }

  return { trusted: true }
}

export function formatDateLabel(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hours}:${minutes}`
}
