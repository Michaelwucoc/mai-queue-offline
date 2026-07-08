/**
 * 和风天气 API 客户端
 * 文档: https://dev.qweather.com/docs/
 * 认证: JWT (Ed25519, 推荐) 或 API KEY (X-QW-Api-Key / key 参数)
 */
import * as crypto from 'crypto'

export type QWeatherAuthMode = 'auto' | 'jwt' | 'apikey'

export interface QWeatherClientOptions {
  apiHost: string
  apiKey?: string
  projectId?: string
  credentialId?: string
  privateKeyPem?: string
  authMode?: QWeatherAuthMode
  requestTimeoutMs?: number
  debug?: boolean
  log?: (msg: string) => void
}

export interface QWeatherWarning {
  id?: string
  sender?: string
  pubTime?: string
  title?: string
  startTime?: string
  endTime?: string
  status?: string
  level?: string
  severity?: string
  severityColor?: string
  typeName?: string
  type?: string
  text?: string
}

export interface QWeatherWarningResponse {
  code?: string
  updateTime?: string
  warning?: QWeatherWarning[]
  refer?: { sources?: string[] }
}

/** 新版实时天气预警 /weatheralert/v1/current/{lat}/{lon} */
export interface QWeatherAlertV1Item {
  id?: string
  senderName?: string
  issuedTime?: string
  messageType?: { code?: string, supersedes?: string[] }
  eventType?: { name?: string, code?: string }
  severity?: string
  color?: { code?: string }
  effectiveTime?: string
  onsetTime?: string
  expireTime?: string
  headline?: string
  description?: string
  instruction?: string
}

export interface QWeatherAlertV1Response {
  metadata?: {
    tag?: string
    zeroResult?: boolean
    attributions?: string[]
  }
  alerts?: QWeatherAlertV1Item[]
}

export interface MappedQWeatherAlert {
  id: string
  title: string
  type: string
  level: string
  text: string
  startTime?: string
  endTime?: string
}

export interface QWeatherNowResponse {
  code?: string
  updateTime?: string
  now?: {
    obsTime?: string
    temp?: string
    feelsLike?: string
    text?: string
    icon?: string
    windDir?: string
    windScale?: string
    humidity?: string
    precip?: string
  }
  refer?: { sources?: string[] }
}

export interface QWeatherHourlyItem {
  fxTime?: string
  temp?: string
  icon?: string
  text?: string
  windDir?: string
  windScale?: string
  humidity?: string
  pop?: string
  precip?: string
}

export interface QWeatherHourlyResponse {
  code?: string
  updateTime?: string
  hourly?: QWeatherHourlyItem[]
  refer?: { sources?: string[] }
}

export interface QWeatherDailyItem {
  fxDate?: string
  tempMax?: string
  tempMin?: string
  iconDay?: string
  textDay?: string
  iconNight?: string
  textNight?: string
  precip?: string
  uvIndex?: string
}

export interface QWeatherDailyResponse {
  code?: string
  updateTime?: string
  daily?: QWeatherDailyItem[]
  refer?: { sources?: string[] }
}

export interface QWeatherBundle {
  now: QWeatherNowResponse | null
  hourly: QWeatherHourlyResponse | null
  daily: QWeatherDailyResponse | null
  warning: QWeatherWarningResponse | null
}

interface JwtCache {
  token: string
  expiresAt: number
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function normalizePrivateKey(pem: string): string {
  return pem.replace(/\\n/g, '\n').trim()
}

export class QWeatherClient {
  private readonly apiHost: string
  private readonly apiKey: string
  private readonly projectId: string
  private readonly credentialId: string
  private readonly privateKeyPem: string
  private readonly authMode: QWeatherAuthMode
  private readonly requestTimeoutMs: number
  private readonly debug: boolean
  private readonly log?: (msg: string) => void
  private jwtCache: JwtCache | null = null

  constructor(options: QWeatherClientOptions) {
    this.apiHost = normalizeHost(options.apiHost || 'devapi.qweather.com')
    this.apiKey = (options.apiKey || '').trim()
    this.projectId = (options.projectId || '').trim()
    this.credentialId = (options.credentialId || '').trim()
    this.privateKeyPem = normalizePrivateKey(options.privateKeyPem || '')
    this.authMode = options.authMode || 'auto'
    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs || 5000)
    this.debug = !!options.debug
    this.log = options.log
  }

  isConfigured(): boolean {
    return this.canUseJwt() || !!this.apiKey
  }

  canUseJwt(): boolean {
    return !!(this.privateKeyPem && this.projectId && this.credentialId)
  }

  private debugLog(msg: string) {
    if (this.debug && this.log) this.log(msg)
  }

  private resolveAuthMode(): 'jwt' | 'apikey' | null {
    if (this.authMode === 'jwt') return this.canUseJwt() ? 'jwt' : null
    if (this.authMode === 'apikey') return this.apiKey ? 'apikey' : null
    if (this.canUseJwt()) return 'jwt'
    if (this.apiKey) return 'apikey'
    return null
  }

  /** 生成 JWT（EdDSA / Ed25519），默认有效期 5 分钟 */
  generateJwt(ttlSeconds = 300): string {
    if (!this.canUseJwt()) {
      throw new Error('QWeather JWT 未配置：需要 qweatherPrivateKey + qweatherProjectId + qweatherCredentialId')
    }
    const header = { alg: 'EdDSA', kid: this.credentialId }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      sub: this.projectId,
      iat: now - 30,
      exp: now + ttlSeconds,
    }
    const encodedHeader = base64Url(JSON.stringify(header))
    const encodedPayload = base64Url(JSON.stringify(payload))
    const message = `${encodedHeader}.${encodedPayload}`
    const key = crypto.createPrivateKey(this.privateKeyPem)
    const signature = crypto.sign(null, Buffer.from(message), key)
    return `${message}.${base64Url(signature)}`
  }

  private getJwtToken(): string {
    const now = Date.now()
    if (this.jwtCache && this.jwtCache.expiresAt > now + 30_000) {
      return this.jwtCache.token
    }
    const token = this.generateJwt()
    this.jwtCache = { token, expiresAt: now + 270_000 }
    return token
  }

  private buildAuthHeaders(mode: 'jwt' | 'apikey'): Record<string, string> {
    if (mode === 'jwt') {
      return { Authorization: `Bearer ${this.getJwtToken()}` }
    }
    return { 'X-QW-Api-Key': this.apiKey }
  }

  private appendApiKeyParam(params: URLSearchParams, mode: 'jwt' | 'apikey') {
    if (mode === 'apikey') {
      params.set('key', this.apiKey)
    }
  }

  private async fetchJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
    const mode = this.resolveAuthMode()
    if (!mode) {
      this.debugLog('和风未配置认证信息')
      return null
    }

    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') search.set(k, String(v))
    }
    this.appendApiKeyParam(search, mode)

    const url = `https://${this.apiHost}${path}?${search}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          ...this.buildAuthHeaders(mode),
        },
      })
      if (!res.ok) {
        this.debugLog(`和风 HTTP ${res.status}: ${path}`)
        return null
      }
      const data = await res.json() as T & { code?: string }
      if (data.code && data.code !== '200') {
        this.debugLog(`和风 API code=${data.code}: ${path}`)
        return null
      }
      return data
    } catch (err) {
      this.debugLog(`和风请求异常 ${path}: ${err}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** location: 经度,纬度 或 LocationID */
  formatLocation(longitude: number, latitude: number): string {
    return `${longitude.toFixed(2)},${latitude.toFixed(2)}`
  }

  /** @deprecated 旧版预警，2026-10 停用；请用 getWeatherAlertCurrent */
  async getWarningNow(location: string, lang = 'zh'): Promise<QWeatherWarningResponse | null> {
    return this.fetchJson<QWeatherWarningResponse>('/v7/warning/now', { location, lang })
  }

  /** 新版实时天气预警（推荐）：路径为 纬度/经度 */
  async getWeatherAlertCurrent(
    latitude: number,
    longitude: number,
    lang = 'zh',
  ): Promise<QWeatherAlertV1Response | null> {
    const lat = latitude.toFixed(2)
    const lon = longitude.toFixed(2)
    return this.fetchJson<QWeatherAlertV1Response>(`/weatheralert/v1/current/${lat}/${lon}`, {
      localTime: 'true',
      lang,
    })
  }

  async getWeatherNow(location: string, lang = 'zh'): Promise<QWeatherNowResponse | null> {
    return this.fetchJson<QWeatherNowResponse>('/v7/weather/now', { location, lang })
  }

  async getWeather24h(location: string, lang = 'zh'): Promise<QWeatherHourlyResponse | null> {
    return this.fetchJson<QWeatherHourlyResponse>('/v7/weather/24h', { location, lang })
  }

  async getWeather3d(location: string, lang = 'zh'): Promise<QWeatherDailyResponse | null> {
    return this.fetchJson<QWeatherDailyResponse>('/v7/weather/3d', { location, lang })
  }

  /** 并行拉取实况 + 逐小时 + 逐日 + 预警（优先 v1 预警接口） */
  async fetchBundle(longitude: number, latitude: number, lang = 'zh'): Promise<QWeatherBundle> {
    const location = this.formatLocation(longitude, latitude)
    const [now, hourly, daily, alertV1] = await Promise.all([
      this.getWeatherNow(location, lang),
      this.getWeather24h(location, lang),
      this.getWeather3d(location, lang),
      this.getWeatherAlertCurrent(latitude, longitude, lang),
    ])
    let warning: QWeatherWarningResponse | null = null
    if (alertV1 !== null) {
      const count = alertV1.alerts?.length ?? 0
      this.debugLog(`预警 v1 /weatheralert/v1/current：${count} 条 (zeroResult=${!!alertV1.metadata?.zeroResult})`)
      warning = this.adaptAlertV1ToWarningResponse(alertV1)
    } else {
      this.debugLog('预警 v1 失败，回退 /v7/warning/now')
      warning = await this.getWarningNow(location, lang)
    }
    return { now, hourly, daily, warning }
  }

  /** 拉取生效预警：优先 v1，失败回退 v7 */
  async getActiveAlerts(latitude: number, longitude: number, lang = 'zh'): Promise<MappedQWeatherAlert[]> {
    const alertV1 = await this.getWeatherAlertCurrent(latitude, longitude, lang)
    if (alertV1 !== null) {
      return this.mapAlertsV1(alertV1)
    }
    this.debugLog('预警 v1 失败，回退 /v7/warning/now')
    const location = this.formatLocation(longitude, latitude)
    const v7 = await this.getWarningNow(location, lang)
    return this.mapWarnings(v7)
  }

  private adaptAlertV1ToWarningResponse(data: QWeatherAlertV1Response): QWeatherWarningResponse {
    const mapped = this.mapAlertsV1(data)
    return {
      code: '200',
      warning: mapped.map(a => ({
        id: a.id,
        title: a.title,
        typeName: a.type,
        level: a.level,
        text: a.text,
        startTime: a.startTime,
        endTime: a.endTime,
        status: 'active',
      })),
    }
  }

  mapAlertsV1(data: QWeatherAlertV1Response | null): MappedQWeatherAlert[] {
    if (!data?.alerts?.length) return []
    const now = Date.now()
    return data.alerts
      .filter(a => {
        const msgCode = (a.messageType?.code || '').toLowerCase()
        if (msgCode === 'cancel') return false
        if (a.expireTime) {
          const exp = Date.parse(a.expireTime)
          if (Number.isFinite(exp) && exp < now) return false
        }
        return true
      })
      .map(a => {
        const level = this.formatAlertColorLevel(a.color?.code) || a.severity || ''
        const eventName = a.eventType?.name || '天气'
        return {
          id: a.id || `${a.eventType?.code || eventName}-${a.issuedTime || ''}`,
          title: a.headline || `${eventName}${level}预警`,
          type: eventName,
          level,
          text: (a.description || a.instruction || '').trim(),
          startTime: a.effectiveTime || a.onsetTime || a.issuedTime,
          endTime: a.expireTime,
        }
      })
  }

  mapWarnings(data: QWeatherWarningResponse | null): MappedQWeatherAlert[] {
    if (!data?.warning?.length) return []
    return data.warning
      .filter(w => {
        const st = (w.status || '').toLowerCase()
        return st !== 'cancel' && st !== 'cancelled'
      })
      .map(w => ({
        id: w.id || `${w.type || ''}-${w.pubTime || ''}-${w.title || ''}`,
        title: w.title || `${w.typeName || '天气'}${w.level || w.severityColor || w.severity || ''}预警`,
        type: w.typeName || w.type || '预警',
        level: w.level || w.severityColor || w.severity || '',
        text: (w.text || '').trim(),
        startTime: w.startTime,
        endTime: w.endTime,
      }))
  }

  private formatAlertColorLevel(code?: string): string {
    if (!code) return ''
    const map: Record<string, string> = {
      blue: '蓝色',
      yellow: '黄色',
      orange: '橙色',
      red: '红色',
      white: '白色',
      black: '黑色',
    }
    return map[code.toLowerCase()] || code
  }
}
