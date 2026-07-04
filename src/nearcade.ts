export interface NearcadeShopGame {
  gameId: number
  titleId: number
  name: string
  version?: string
  quantity?: number
}

export interface NearcadeShop {
  id: number
  name: string
  games: NearcadeShopGame[]
}

export interface NearcadeListShopsResponse {
  shops: NearcadeShop[]
  totalCount?: number
  currentPage?: number
}

export interface NearcadeAttendanceGame {
  gameId: number
  titleId?: number
  total: number
}

export interface NearcadeAttendanceResponse {
  success: boolean
  total: number
  games: NearcadeAttendanceGame[]
  registered: unknown[]
  reported: unknown[]
}

export interface NearcadeUpdateResult {
  ok: boolean
  message: string
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function buildSearchKeywords(shopName?: string, aliases: string[] = []): string[] {
  const keywords = new Set<string>()
  for (const value of [shopName, ...aliases]) {
    if (!value) continue
    keywords.add(value)
    for (const part of value.split(/[·（）()\-—\s]+/)) {
      const trimmed = part.trim()
      if (trimmed.length >= 2) keywords.add(trimmed)
    }
  }
  return [...keywords]
}

export class NearcadeClient {
  private readonly baseUrl: string
  private readonly gameIdCache = new Map<string, number>()

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  buildShopLink(shopId: number): string {
    return `${this.baseUrl}/shops/${shopId}`
  }

  private cacheKey(shopId: number, titleId: number): string {
    return `${shopId}:${titleId}`
  }

  async listShops(keyword?: string, page = 1, limit = 5): Promise<NearcadeListShopsResponse | null> {
    try {
      const params = new URLSearchParams()
      if (keyword) params.set('q', keyword)
      params.set('page', String(page))
      params.set('limit', String(limit))

      const response = await fetch(`${this.baseUrl}/api/shops?${params.toString()}`)
      if (!response.ok) return null
      return await response.json() as NearcadeListShopsResponse
    } catch {
      return null
    }
  }

  /** GET /api/shops/{id}/attendance — 见 https://nearcade.apifox.cn */
  async getAttendance(
    shopId: number,
    reported?: boolean,
  ): Promise<NearcadeAttendanceResponse | null> {
    try {
      const params = new URLSearchParams()
      if (reported !== undefined) {
        params.set('reported', reported ? 'true' : 'false')
      }
      const query = params.toString()
      const url = `${this.baseUrl}/api/shops/${shopId}/attendance${query ? `?${query}` : ''}`
      const response = await fetch(url)
      if (!response.ok) return null
      return await response.json() as NearcadeAttendanceResponse
    } catch {
      return null
    }
  }

  /** POST /api/shops/{id}/attendance — Bearer API 令牌 */
  async updateAttendance(
    shopId: number,
    gameId: number,
    count: number,
    token: string,
    comment = 'Update from mai-queue bot',
  ): Promise<NearcadeUpdateResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/shops/${shopId}/attendance`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          games: [{ id: gameId, currentAttendances: count }],
          comment,
        }),
      })

      if (response.ok) {
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) return { ok: true, message: data.message }
        } catch {
          // ignore json parse error
        }
        return { ok: true, message: 'ok' }
      }

      let message = response.statusText
      try {
        const data = await response.json() as { message?: string }
        if (data?.message) message = data.message
      } catch {
        const text = await response.text()
        if (text) message = text
      }
      return { ok: false, message }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }

  async resolveGameId(
    shopId: number,
    titleId: number,
    shopName?: string,
    aliases: string[] = [],
  ): Promise<number | null> {
    const key = this.cacheKey(shopId, titleId)
    const cached = this.gameIdCache.get(key)
    if (cached) return cached

    const attendance = await this.getAttendance(shopId)
    if (attendance?.games?.length) {
      const fromAttendance = attendance.games.find(g => g.titleId === titleId)
      if (fromAttendance) {
        this.gameIdCache.set(key, fromAttendance.gameId)
        return fromAttendance.gameId
      }
    }

    for (const keyword of buildSearchKeywords(shopName, aliases)) {
      const result = await this.listShops(keyword, 1, 20)
      const shop = result?.shops?.find(s => s.id === shopId)
      if (shop?.games?.length) {
        const game = shop.games.find(g => g.titleId === titleId)
        if (game) {
          this.gameIdCache.set(key, game.gameId)
          return game.gameId
        }
      }
    }

    return null
  }

  getAttendanceCount(data: NearcadeAttendanceResponse | null, titleId: number, gameId?: number | null): number {
    if (!data?.games?.length) return 0
    if (gameId) {
      const byGameId = data.games.find(g => g.gameId === gameId)
      if (byGameId) return byGameId.total ?? 0
    }
    const byTitleId = data.games.find(g => g.titleId === titleId)
    if (byTitleId) return byTitleId.total ?? 0
    return data.total ?? 0
  }
}
