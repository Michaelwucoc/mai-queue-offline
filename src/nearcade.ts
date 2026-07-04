export type NearcadeSource = 'bemanicn' | 'ziv'

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

export class NearcadeClient {
  private readonly baseUrl: string
  private readonly gameIdCache = new Map<string, number>()

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
  }

  buildShopLink(shopId: number, linkOverride?: string): string {
    if (linkOverride) return linkOverride
    return `${this.baseUrl}/shops/${shopId}`
  }

  private cacheKey(source: NearcadeSource, shopId: number, titleId: number): string {
    return `${source}:${shopId}:${titleId}`
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

  async getAttendance(
    source: NearcadeSource,
    shopId: number,
    reported?: boolean,
  ): Promise<NearcadeAttendanceResponse | null> {
    try {
      const params = new URLSearchParams()
      if (reported !== undefined) {
        params.set('reported', reported ? 'true' : 'false')
      }
      const query = params.toString()
      const url = `${this.baseUrl}/api/shops/${source}/${shopId}/attendance${query ? `?${query}` : ''}`
      const response = await fetch(url)
      if (!response.ok) return null
      return await response.json() as NearcadeAttendanceResponse
    } catch {
      return null
    }
  }

  async updateAttendance(
    source: NearcadeSource,
    shopId: number,
    gameId: number,
    count: number,
    token: string,
    comment = 'Update from mai-queue bot',
  ): Promise<NearcadeUpdateResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/shops/${source}/${shopId}/attendance`, {
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
    source: NearcadeSource,
    shopId: number,
    titleId: number,
    shopName?: string,
    gameIdOverride?: number,
  ): Promise<number | null> {
    if (gameIdOverride && gameIdOverride > 0) {
      return gameIdOverride
    }

    const key = this.cacheKey(source, shopId, titleId)
    const cached = this.gameIdCache.get(key)
    if (cached) return cached

    const attendance = await this.getAttendance(source, shopId)
    if (attendance?.games?.length) {
      const fromAttendance = attendance.games.find(
        g => g.titleId === titleId || g.gameId === titleId,
      ) ?? attendance.games.find(g => {
        const idStr = String(g.gameId)
        return idStr.endsWith(String(titleId).padStart(3, '0'))
      })
      if (fromAttendance) {
        this.gameIdCache.set(key, fromAttendance.gameId)
        return fromAttendance.gameId
      }
    }

    const keywords = [shopName, String(shopId)].filter(Boolean) as string[]
    for (const keyword of keywords) {
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

  getAttendanceCount(data: NearcadeAttendanceResponse | null, titleId: number): number {
    if (!data?.games?.length) return 0
    const game = data.games.find(g => g.titleId === titleId)
    if (game) return game.total ?? 0
    return data.total ?? 0
  }
}
