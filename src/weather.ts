/**
 * 天气服务：Open-Meteo 预报（免 Key）+ 可选和风官方预警。
 * Open-Meteo: https://open-meteo.com
 * 和风预警: https://dev.qweather.com/docs/api/warning/
 */

export interface WeatherCoords {
  latitude: number
  longitude: number
  resolvedName?: string
}

export interface WeatherAlert {
  id: string
  title: string
  type: string
  level: string
  text: string
  startTime?: string
  endTime?: string
  source: 'qweather'
}

export type WeatherSeverity = 'ok' | 'mild' | 'bad' | 'severe'

export interface UpcomingCondition {
  hoursAhead: number
  weatherCode: number
  label: string
  emoji: string
  precipitationMm: number
  precipProbability: number
  temperature: number
}

export interface WeatherSnapshot {
  coords: WeatherCoords
  fetchedAt: number
  timezone: string
  current: {
    temperature: number
    weatherCode: number
    label: string
    emoji: string
    precipitationMm: number
  }
  upcoming: UpcomingCondition[]
  daily: {
    weatherCode: number
    label: string
    emoji: string
    tempMax: number
    tempMin: number
    precipitationSum: number
  } | null
  alerts: WeatherAlert[]
  severity: WeatherSeverity
  queryHint: string | null
  digestText: string
  alertPushText: string | null
}

interface OpenMeteoForecast {
  timezone?: string
  current?: {
    temperature_2m?: number
    weather_code?: number
    precipitation?: number
  }
  hourly?: {
    time: string[]
    precipitation_probability?: (number | null)[]
    precipitation?: (number | null)[]
    weather_code?: (number | null)[]
    temperature_2m?: (number | null)[]
  }
  daily?: {
    time: string[]
    weather_code?: (number | null)[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_sum?: (number | null)[]
  }
}

interface CacheEntry {
  expiresAt: number
  snapshot: WeatherSnapshot
}

const WMO_LABELS: Record<number, { label: string, emoji: string, severity: WeatherSeverity }> = {
  0: { label: '晴', emoji: '☀️', severity: 'ok' },
  1: { label: '大部晴朗', emoji: '🌤', severity: 'ok' },
  2: { label: '多云', emoji: '⛅️', severity: 'ok' },
  3: { label: '阴', emoji: '☁️', severity: 'ok' },
  45: { label: '雾', emoji: '🌫', severity: 'mild' },
  48: { label: '雾凇', emoji: '🌫', severity: 'mild' },
  51: { label: '小毛毛雨', emoji: '🌦', severity: 'mild' },
  53: { label: '毛毛雨', emoji: '🌦', severity: 'mild' },
  55: { label: '强毛毛雨', emoji: '🌧', severity: 'mild' },
  56: { label: '冻毛毛雨', emoji: '🌧', severity: 'bad' },
  57: { label: '强冻毛毛雨', emoji: '🌧', severity: 'bad' },
  61: { label: '小雨', emoji: '🌧', severity: 'mild' },
  63: { label: '中雨', emoji: '🌧', severity: 'mild' },
  65: { label: '大雨', emoji: '🌧', severity: 'bad' },
  66: { label: '冻雨', emoji: '🌧', severity: 'severe' },
  67: { label: '强冻雨', emoji: '🌧', severity: 'severe' },
  71: { label: '小雪', emoji: '🌨', severity: 'mild' },
  73: { label: '中雪', emoji: '🌨', severity: 'mild' },
  75: { label: '大雪', emoji: '❄️', severity: 'bad' },
  77: { label: '雪粒', emoji: '🌨', severity: 'mild' },
  80: { label: '小阵雨', emoji: '🌦', severity: 'mild' },
  81: { label: '阵雨', emoji: '🌧', severity: 'mild' },
  82: { label: '强阵雨', emoji: '🌧', severity: 'bad' },
  85: { label: '小阵雪', emoji: '🌨', severity: 'mild' },
  86: { label: '强阵雪', emoji: '❄️', severity: 'bad' },
  95: { label: '雷暴', emoji: '⚡️', severity: 'bad' },
  96: { label: '雷暴伴冰雹', emoji: '⛈', severity: 'severe' },
  99: { label: '强雷暴伴冰雹', emoji: '⛈', severity: 'severe' },
}

const SEVERITY_RANK: Record<WeatherSeverity, number> = {
  ok: 0,
  mild: 1,
  bad: 2,
  severe: 3,
}

function describeWmo(code: number): { label: string, emoji: string, severity: WeatherSeverity } {
  return WMO_LABELS[code] || { label: `天气码 ${code}`, emoji: '🌡', severity: 'ok' }
}

function maxSeverity(a: WeatherSeverity, b: WeatherSeverity): WeatherSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

function parseIsoLocal(iso: string): Date {
  // Open-Meteo with timezone returns local wall time without offset, e.g. 2026-07-08T21:00
  return new Date(iso.includes('T') && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? `${iso}+08:00` : iso)
}

export class WeatherService {
  private cache = new Map<string, CacheEntry>()
  private geoCache = new Map<string, WeatherCoords>()

  constructor(
    private options: {
      cacheMinutes?: number
      lookAheadHours?: number
      qweatherApiKey?: string
      qweatherApiHost?: string
      debug?: boolean
      log?: (msg: string) => void
    } = {},
  ) {}

  private log(msg: string) {
    if (this.options.debug && this.options.log) this.options.log(msg)
  }

  get lookAheadHours(): number {
    return this.options.lookAheadHours ?? 4
  }

  get cacheMinutes(): number {
    return this.options.cacheMinutes ?? 15
  }

  clearCache() {
    this.cache.clear()
  }

  async resolveCoords(input: {
    latitude?: number
    longitude?: number
    city?: string
    district?: string
    location?: string
  }): Promise<WeatherCoords | null> {
    if (
      typeof input.latitude === 'number' && Number.isFinite(input.latitude)
      && typeof input.longitude === 'number' && Number.isFinite(input.longitude)
    ) {
      const label = [input.city?.trim(), this.normalizeDistrict(input.district), input.location?.trim()]
        .filter(Boolean)
        .join(' · ')
      return {
        latitude: input.latitude,
        longitude: input.longitude,
        resolvedName: label || undefined,
      }
    }

    const city = this.normalizeCity(input.city)
    const district = this.normalizeDistrict(input.district)
    if (city) {
      return this.resolveCityDistrict(city, district)
    }

    const name = input.location?.trim()
    if (!name) return null
    const parsed = this.parseLocationString(name)
    if (parsed.city) {
      return this.resolveCityDistrict(parsed.city, parsed.district)
    }
    return this.geocodeCity(name)
  }

  /** 「上海市」→「上海」；去掉多余空白 */
  normalizeCity(city?: string): string {
    const raw = (city || '').trim()
    if (!raw) return ''
    return raw.replace(/(?:市|地区|盟|自治州)$/, '') || raw
  }

  /** 「静安」→「静安区」；已带区/县/旗/市则保留 */
  normalizeDistrict(district?: string): string {
    const raw = (district || '').trim()
    if (!raw) return ''
    if (/(?:区|县|旗|市|新城|园区)$/.test(raw)) return raw
    if (raw.endsWith('新区') || raw.endsWith('自治县')) return raw
    // 常见「新区」简称
    const special: Record<string, string> = {
      浦东: '浦东新区',
      滨海: '滨海新区',
      两江: '两江新区',
      西咸: '西咸新区',
      雄安: '雄安新区',
    }
    if (special[raw]) return special[raw]
    return `${raw}区`
  }

  /** 从「上海市静安区…」拆出城市与区 */
  parseLocationString(name: string): { city: string, district: string } {
    const raw = name.trim()
    // 上海静安区 / 上海市静安区 / 深圳市南山区
    let m = raw.match(/^([\u4e00-\u9fa5]{2,3})(?:市)?([\u4e00-\u9fa5]{2,6}(?:区|县|旗|市|新区))$/)
    if (m) return { city: m[1], district: m[2] }
    // 仅城市
    m = raw.match(/^([\u4e00-\u9fa5]{2,3})市?$/)
    if (m) return { city: m[1], district: '' }
    return { city: '', district: '' }
  }

  async resolveCityDistrict(city: string, district?: string): Promise<WeatherCoords | null> {
    const cityNorm = this.normalizeCity(city)
    const districtNorm = this.normalizeDistrict(district)
    const cacheKey = `${cityNorm}|${districtNorm || ''}`.toLowerCase()
    const hit = this.geoCache.get(cacheKey)
    if (hit) return hit

    // 有区：优先 Photon 区级解析，失败再退回市中心
    if (districtNorm) {
      const districtCoords = await this.geocodeDistrictPhoton(cityNorm, districtNorm)
      if (districtCoords) {
        this.geoCache.set(cacheKey, districtCoords)
        return districtCoords
      }
      this.log(`区级解析失败，回退到城市：${cityNorm} / ${districtNorm}`)
    }

    const cityCoords = await this.geocodeCity(cityNorm)
    if (!cityCoords) return null
    if (districtNorm) {
      cityCoords.resolvedName = `${cityNorm}市 · ${districtNorm}（区级未命中，已用市中心）`
    }
    this.geoCache.set(cacheKey, cityCoords)
    return cityCoords
  }

  private cityEnglishAlias(city: string): string | undefined {
    const map: Record<string, string> = {
      上海: 'Shanghai',
      北京: 'Beijing',
      广州: 'Guangzhou',
      深圳: 'Shenzhen',
      杭州: 'Hangzhou',
      成都: 'Chengdu',
      南京: 'Nanjing',
      武汉: 'Wuhan',
      西安: "Xi'an",
      重庆: 'Chongqing',
      天津: 'Tianjin',
      苏州: 'Suzhou',
      宁波: 'Ningbo',
      长沙: 'Changsha',
      青岛: 'Qingdao',
      厦门: 'Xiamen',
      福州: 'Fuzhou',
      郑州: 'Zhengzhou',
      合肥: 'Hefei',
      济南: 'Jinan',
      沈阳: 'Shenyang',
      大连: 'Dalian',
      昆明: 'Kunming',
      无锡: 'Wuxi',
    }
    return map[city]
  }

  /** Photon（OSM）解析「区, 市」，优先选取行政区要素 */
  private async geocodeDistrictPhoton(city: string, district: string): Promise<WeatherCoords | null> {
    const queries: Array<{ q: string, osmTag?: string }> = [
      // 行政区要素（最准；嘉定区/静安区等在 OSM 常记为 place=city）
      { q: district, osmTag: 'place:city' },
      { q: `${district},${city}`, osmTag: 'place:city' },
      { q: `${city}${district}`, osmTag: 'place:city' },
      // 无 tag 兜底
      { q: `${district},${city}` },
      { q: `${city}市${district}` },
      { q: `${city}${district}` },
    ]
    for (const { q, osmTag } of queries) {
      const params = new URLSearchParams({ q, limit: '8' })
      if (osmTag) params.set('osm_tag', osmTag)
      const url = `https://photon.komoot.io/api/?${params}`
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'mai-queue-weather/1.0' },
        })
        if (!res.ok) {
          this.log(`Photon HTTP ${res.status}: ${q}`)
          continue
        }
        const data = await res.json() as {
          features?: Array<{
            geometry?: { coordinates?: number[] }
            properties?: {
              name?: string
              city?: string
              district?: string
              state?: string
              country?: string
              countrycode?: string
              type?: string
              osm_value?: string
              osm_key?: string
            }
          }>
        }
        const picked = this.pickPhotonDistrict(city, district, data.features || [])
        if (picked) {
          this.log(`Photon 区级命中「${q}」${osmTag ? `(${osmTag})` : ''} → ${picked.resolvedName}`)
          return picked
        }
      } catch (err) {
        this.log(`Photon 异常: ${err}`)
      }
    }

    // Open-Meteo 对部分区县拼音也可用（如 Jiading / Minhang）
    const om = await this.geocodeDistrictOpenMeteo(city, district)
    if (om) return om
    return null
  }

  private async geocodeDistrictOpenMeteo(city: string, district: string): Promise<WeatherCoords | null> {
    const bare = district.replace(/(?:区|县|旗|市|新区)$/, '')
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(bare)}&count=8&language=zh&format=json&countryCode=CN`
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      const data = await res.json() as {
        results?: Array<{ name: string, latitude: number, longitude: number, admin1?: string, country?: string, country_code?: string, population?: number }>
      }
      const results = data.results || []
      const cityHint = city
      let best: typeof results[0] | null = null
      let bestScore = -Infinity
      for (const r of results) {
        let score = this.scoreGeocodeResult(bare, r)
        const admin = `${r.admin1 || ''}${r.name || ''}`
        if (admin.includes(cityHint) || admin.includes(`${cityHint}市`) || admin.includes('Shanghai') && cityHint === '上海') {
          score += 50
        } else {
          score -= 30
        }
        if (score > bestScore) {
          bestScore = score
          best = r
        }
      }
      if (!best || bestScore < 40) return null
      return {
        latitude: best.latitude,
        longitude: best.longitude,
        resolvedName: `${city}市 · ${district}`,
      }
    } catch {
      return null
    }
  }

  private pickPhotonDistrict(
    city: string,
    district: string,
    features: Array<{
      geometry?: { coordinates?: number[] }
      properties?: {
        name?: string
        city?: string
        district?: string
        state?: string
        country?: string
        countrycode?: string
        type?: string
        osm_value?: string
        osm_key?: string
      }
    }>,
  ): WeatherCoords | null {
    const districtBare = district.replace(/(?:区|县|旗|市|新区)$/, '')
    let best: WeatherCoords | null = null
    let bestScore = -Infinity

    for (const f of features) {
      const p = f.properties || {}
      const coords = f.geometry?.coordinates
      if (!coords || coords.length < 2) continue
      const lon = coords[0]
      const lat = coords[1]
      // 大致中国境内
      if (lon < 73 || lon > 135 || lat < 18 || lat > 54) continue
      const cc = (p.countrycode || '').toLowerCase()
      if (cc && cc !== 'cn') continue

      const hay = [p.name, p.city, p.district, p.state].filter(Boolean).join(' ')
      if (!hay.includes(districtBare) && !hay.includes(district)) continue
      // 城市需沾边（直辖市光子常把 city 填成区名、state=上海市）
      const cityOk = hay.includes(city) || hay.includes(`${city}市`)
        || (p.state || '').includes(city)
        || (p.city || '').includes(districtBare)
      if (!cityOk) continue

      let score = 10
      const osm = p.osm_value || ''
      const osmKey = p.osm_key || ''
      if (osmKey === 'place' && ['city', 'county', 'district', 'suburb', 'borough', 'town'].includes(osm)) score += 100
      else if (['city', 'county', 'district', 'suburb', 'borough', 'town'].includes(osm)) score += 80
      if (p.name === district || p.name === districtBare || p.name === `${districtBare}区`) score += 60
      if ((p.city || '') === district || (p.city || '').includes(districtBare)) score += 40
      if ((p.district || '').includes(districtBare)) score += 20
      if ((p.state || '').includes(city)) score += 25
      // 公司/地铁站/幼儿园等降权
      if (['company', 'industrial', 'station', 'restaurant', 'hotel', 'kindergarten', 'school', 'hospital'].includes(osm)) score -= 80
      if (['amenity', 'landuse', 'office', 'railway', 'leisure'].includes(osmKey)) score -= 40

      if (score > bestScore) {
        bestScore = score
        best = {
          latitude: lat,
          longitude: lon,
          resolvedName: `${city}市 · ${district}`,
        }
      }
    }
    return bestScore >= 40 ? best : null
  }

  private scoreGeocodeResult(
    query: string,
    r: { name: string, latitude: number, longitude: number, admin1?: string, country?: string, country_code?: string, population?: number },
  ): number {
    let score = 0
    const isCn = r.country_code === 'CN' || r.country === '中国' || r.country === 'China'
    if (!isCn) return -1000
    score += 50
    if (r.name === query) score += 100
    else if (query.includes(r.name) || r.name.startsWith(query)) score += 40
    if (r.name.includes(query) && r.name.length > query.length + 1) score -= 80
    if (r.admin1 && (r.admin1.includes(query) || query.includes(r.admin1.replace(/市$/, '')))) score += 20
    if (typeof r.population === 'number') score += Math.min(30, Math.log10(r.population + 1) * 5)
    if (r.longitude >= 73 && r.longitude <= 135 && r.latitude >= 18 && r.latitude <= 54) score += 20
    return score
  }

  private pickCnResult(
    query: string,
    results: Array<{ name: string, latitude: number, longitude: number, admin1?: string, country?: string, country_code?: string, population?: number }>,
  ) {
    if (!results.length) return null
    let best = results[0]
    let bestScore = this.scoreGeocodeResult(query, best)
    for (const r of results.slice(1)) {
      const s = this.scoreGeocodeResult(query, r)
      if (s > bestScore) {
        best = r
        bestScore = s
      }
    }
    if (bestScore < 0) return null
    return best
  }

  /** 城市级地理编码（Open-Meteo） */
  async geocodeCity(name: string): Promise<WeatherCoords | null> {
    const city = this.normalizeCity(name) || name.trim()
    const key = `city:${city}`.toLowerCase()
    const hit = this.geoCache.get(key)
    if (hit) return hit

    const candidates = [this.cityEnglishAlias(city), city].filter(Boolean) as string[]
    for (const candidate of candidates) {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=5&language=zh&format=json&countryCode=CN`
      try {
        const res = await fetch(url)
        if (!res.ok) {
          this.log(`城市编码失败 HTTP ${res.status}: ${candidate}`)
          continue
        }
        const data = await res.json() as {
          results?: Array<{ name: string, latitude: number, longitude: number, admin1?: string, country?: string, country_code?: string, population?: number }>
        }
        const first = this.pickCnResult(candidate, data.results || [])
        if (!first) continue
        const coords: WeatherCoords = {
          latitude: first.latitude,
          longitude: first.longitude,
          resolvedName: `${city}市`,
        }
        this.geoCache.set(key, coords)
        return coords
      } catch (err) {
        this.log(`城市编码异常: ${err}`)
      }
    }
    this.log(`城市编码失败: ${name}（建议改用 weatherLatitude/weatherLongitude）`)
    return null
  }

  /** @deprecated 兼容旧 location 字符串；内部走城市解析 */
  async geocode(name: string): Promise<WeatherCoords | null> {
    const parsed = this.parseLocationString(name)
    if (parsed.city) return this.resolveCityDistrict(parsed.city, parsed.district)
    return this.geocodeCity(name)
  }

  async getSnapshot(coords: WeatherCoords, arcadeName?: string): Promise<WeatherSnapshot | null> {
    const cacheKey = `${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot
    }

    const forecast = await this.fetchOpenMeteo(coords)
    if (!forecast) return null

    const alerts = await this.fetchQWeatherAlerts(coords)
    const snapshot = this.buildSnapshot(coords, forecast, alerts, arcadeName)
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + this.cacheMinutes * 60_000,
      snapshot,
    })
    return snapshot
  }

  private async fetchOpenMeteo(coords: WeatherCoords): Promise<OpenMeteoForecast | null> {
    const params = new URLSearchParams({
      latitude: String(coords.latitude),
      longitude: String(coords.longitude),
      timezone: 'Asia/Shanghai',
      forecast_days: '1',
      current: 'temperature_2m,weather_code,precipitation',
      hourly: 'precipitation_probability,precipitation,weather_code,temperature_2m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    })
    const url = `https://api.open-meteo.com/v1/forecast?${params}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        this.log(`Open-Meteo HTTP ${res.status}`)
        return null
      }
      return await res.json() as OpenMeteoForecast
    } catch (err) {
      this.log(`Open-Meteo 异常: ${err}`)
      return null
    }
  }

  private async fetchQWeatherAlerts(coords: WeatherCoords): Promise<WeatherAlert[]> {
    const key = this.options.qweatherApiKey?.trim()
    if (!key) return []
    const host = (this.options.qweatherApiHost || 'devapi.qweather.com').replace(/^https?:\/\//, '')
    // location=经度,纬度
    const url = `https://${host}/v7/warning/now?location=${coords.longitude.toFixed(2)},${coords.latitude.toFixed(2)}&key=${encodeURIComponent(key)}&lang=zh`
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } })
      if (!res.ok) {
        this.log(`和风预警 HTTP ${res.status}`)
        return []
      }
      const data = await res.json() as {
        code?: string
        warning?: Array<{
          id?: string
          sender?: string
          pubTime?: string
          title?: string
          startTime?: string
          endTime?: string
          status?: string
          level?: string
          typeName?: string
          type?: string
          text?: string
        }>
      }
      if (data.code !== '200' || !Array.isArray(data.warning)) {
        this.log(`和风预警无数据 code=${data.code}`)
        return []
      }
      return data.warning
        .filter(w => w.status !== 'cancel')
        .map(w => ({
          id: w.id || `${w.type || ''}-${w.pubTime || ''}-${w.title || ''}`,
          title: w.title || `${w.typeName || '天气'}${w.level || ''}预警`,
          type: w.typeName || w.type || '预警',
          level: w.level || '',
          text: (w.text || '').trim(),
          startTime: w.startTime,
          endTime: w.endTime,
          source: 'qweather' as const,
        }))
    } catch (err) {
      this.log(`和风预警异常: ${err}`)
      return []
    }
  }

  private buildSnapshot(
    coords: WeatherCoords,
    forecast: OpenMeteoForecast,
    alerts: WeatherAlert[],
    arcadeName?: string,
  ): WeatherSnapshot {
    const now = Date.now()
    const lookAhead = this.lookAheadHours
    const currentCode = forecast.current?.weather_code ?? 0
    const currentDesc = describeWmo(currentCode)
    const upcoming: UpcomingCondition[] = []

    const times = forecast.hourly?.time || []
    for (let i = 0; i < times.length; i++) {
      const t = parseIsoLocal(times[i]).getTime()
      const hoursAhead = (t - now) / 3_600_000
      if (hoursAhead < -0.25) continue
      if (hoursAhead > lookAhead + 0.01) break
      const code = forecast.hourly?.weather_code?.[i] ?? 0
      const desc = describeWmo(code)
      upcoming.push({
        hoursAhead: Math.max(0, Math.round(hoursAhead * 10) / 10),
        weatherCode: code,
        label: desc.label,
        emoji: desc.emoji,
        precipitationMm: forecast.hourly?.precipitation?.[i] ?? 0,
        precipProbability: forecast.hourly?.precipitation_probability?.[i] ?? 0,
        temperature: forecast.hourly?.temperature_2m?.[i] ?? forecast.current?.temperature_2m ?? 0,
      })
    }

    let severity: WeatherSeverity = currentDesc.severity
    for (const u of upcoming) {
      severity = maxSeverity(severity, describeWmo(u.weatherCode).severity)
    }
    if (alerts.length > 0) severity = maxSeverity(severity, 'severe')

    const dailyCode = forecast.daily?.weather_code?.[0] ?? currentCode
    const dailyDesc = describeWmo(dailyCode)
    const daily = forecast.daily ? {
      weatherCode: dailyCode,
      label: dailyDesc.label,
      emoji: dailyDesc.emoji,
      tempMax: forecast.daily.temperature_2m_max?.[0] ?? 0,
      tempMin: forecast.daily.temperature_2m_min?.[0] ?? 0,
      precipitationSum: forecast.daily.precipitation_sum?.[0] ?? 0,
    } : null

    const queryHint = this.formatQueryHint(upcoming, alerts, severity)
    const place = arcadeName || coords.resolvedName || '机厅附近'
    const digestText = this.formatDigest(place, currentDesc, forecast, daily, alerts)
    const alertPushText = this.formatAlertPush(place, upcoming, alerts, severity)

    return {
      coords,
      fetchedAt: now,
      timezone: forecast.timezone || 'Asia/Shanghai',
      current: {
        temperature: forecast.current?.temperature_2m ?? 0,
        weatherCode: currentCode,
        label: currentDesc.label,
        emoji: currentDesc.emoji,
        precipitationMm: forecast.current?.precipitation ?? 0,
      },
      upcoming,
      daily,
      alerts,
      severity,
      queryHint,
      digestText,
      alertPushText,
    }
  }

  private collectBadConditions(upcoming: UpcomingCondition[]): UpcomingCondition[] {
    return upcoming.filter(u => {
      const sev = describeWmo(u.weatherCode).severity
      return sev !== 'ok' || u.precipitationMm >= 0.2 || u.precipProbability >= 50
    })
  }

  private formatQueryHint(
    upcoming: UpcomingCondition[],
    alerts: WeatherAlert[],
    severity: WeatherSeverity,
  ): string | null {
    if (severity === 'ok' && alerts.length === 0) return null

    const hours = this.lookAheadHours
    const bad = this.collectBadConditions(upcoming)
    const labels = [...new Set(bad.map(b => b.label))]
    const emojis = [...new Set(bad.map(b => b.emoji))].join('')
    const alertPart = alerts.length
      ? `预警：${alerts.map(a => a.title).join('、')}`
      : ''

    if (alerts.length || severity === 'severe' || severity === 'bad') {
      const weatherPart = labels.length ? labels.join('、') : (alerts[0]?.type || '恶劣天气')
      const icons = emojis || (alerts.length ? '⚠️' : '🌧')
      const tip = severity === 'severe' || alerts.length
        ? '不建议出勤...'
        : '出门小心，建议改时间或做好防护！'
      const base = `${icons} ${hours}小时内可能有 ${weatherPart}！${tip}`
      return alertPart ? `${base}\n⚠️ ${alertPart}` : base
    }

    // mild: 小雨等
    if (labels.length) {
      const icon = emojis || '🌧'
      return `${icon} ${hours}小时内可能有 ${labels.join('、')} 哦，出勤记得带伞！`
    }
    return null
  }

  private formatDigest(
    place: string,
    currentDesc: { label: string, emoji: string },
    forecast: OpenMeteoForecast,
    daily: WeatherSnapshot['daily'],
    alerts: WeatherAlert[],
  ): string {
    const temp = forecast.current?.temperature_2m
    const lines = [
      `☀️ 今日天气 · ${place}`,
      '',
      `${currentDesc.emoji} 现在：${currentDesc.label}${typeof temp === 'number' ? ` ${Math.round(temp)}℃` : ''}`,
    ]
    if (daily) {
      lines.push(`${daily.emoji} 今日：${daily.label}，${Math.round(daily.tempMin)}~${Math.round(daily.tempMax)}℃`)
      if (daily.precipitationSum > 0) {
        lines.push(`💧 预计降水：${daily.precipitationSum.toFixed(1)} mm`)
      }
    }
    if (alerts.length) {
      lines.push('')
      lines.push('⚠️ 生效预警：')
      for (const a of alerts.slice(0, 3)) {
        lines.push(`· ${a.title}`)
      }
    }
    lines.push('')
    lines.push('数据：Open-Meteo' + (alerts.length ? ' + 和风预警' : '') + '（仅供参考）')
    return lines.join('\n')
  }

  private formatAlertPush(
    place: string,
    upcoming: UpcomingCondition[],
    alerts: WeatherAlert[],
    severity: WeatherSeverity,
  ): string | null {
    if (severity !== 'bad' && severity !== 'severe' && alerts.length === 0) return null

    const hours = this.lookAheadHours
    const bad = this.collectBadConditions(upcoming)
    const labels = [...new Set(bad.map(b => b.label))]
    const emojis = [...new Set(bad.map(b => b.emoji))].join('') || '⚠️'
    const lines = [`⚠️ 天气提醒 · ${place}`, '']

    if (alerts.length) {
      for (const a of alerts.slice(0, 3)) {
        lines.push(`${a.title}`)
        if (a.text) {
          const short = a.text.length > 80 ? `${a.text.slice(0, 80)}…` : a.text
          lines.push(short)
        }
      }
      lines.push('')
    }

    if (labels.length) {
      lines.push(`${emojis} 未来 ${hours} 小时可能有 ${labels.join('、')}`)
      lines.push(severity === 'severe' || alerts.length ? '不建议出勤，注意安全。' : '出门请做好防护，注意安全。')
    } else if (alerts.length) {
      lines.push('请关注预警，谨慎做出勤计划。')
    }

    lines.push('')
    lines.push('数据仅供参考，以官方发布为准。')
    return lines.join('\n')
  }

  /** 用于推送去重的指纹 */
  fingerprint(snapshot: WeatherSnapshot): string {
    const alertIds = snapshot.alerts.map(a => a.id).sort().join(',')
    const worst = snapshot.upcoming
      .filter(u => describeWmo(u.weatherCode).severity !== 'ok')
      .map(u => `${u.weatherCode}@${Math.floor(u.hoursAhead)}`)
      .join('|')
    return `${snapshot.severity}|${alertIds}|${worst}`
  }
}
