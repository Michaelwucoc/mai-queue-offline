/** Nearcade GAME_TITLES — 见 https://github.com/Naptie/nearcade/blob/main/src/lib/constants.ts */
export const NEARCADE_DEFAULT_TITLE_ID = 1

export const NEARCADE_GAME_TITLES = [
  { id: 1, name: '舞萌 DX' },
  { id: 2, name: '舞萌' },
  { id: 3, name: '中二节奏' },
  { id: 4, name: '音律炫动' },
  { id: 5, name: 'beatmania IIDX' },
  { id: 6, name: 'jubeat' },
  { id: 7, name: 'Nostalgia' },
  { id: 8, name: 'GuitarFreaks' },
  { id: 9, name: 'DrumMania' },
  { id: 10, name: 'DANCERUSH STARDOM' },
  { id: 11, name: 'Dance Dance Revolution' },
  { id: 12, name: "pop'n music" },
  { id: 13, name: 'DanceEvolution' },
  { id: 14, name: 'REFLEC BEAT' },
  { id: 15, name: '太鼓之达人 (旧代)' },
  { id: 16, name: '音炫轨道' },
  { id: 17, name: '华卡音舞' },
  { id: 19, name: '泵动巅峰' },
  { id: 20, name: '星光' },
  { id: 21, name: 'DJMAX Technika' },
  { id: 22, name: '鼓王' },
  { id: 23, name: '舞力特区' },
  { id: 24, name: '初音未来 歌姬计划 Arcade' },
  { id: 27, name: '音击' },
  { id: 29, name: 'DANCE aROUND' },
  { id: 31, name: '太鼓之达人' },
  { id: 33, name: '舞立方EVO' },
  { id: 34, name: 'jubeat音乐魔方' },
] as const

export type NearcadeTitleId = typeof NEARCADE_GAME_TITLES[number]['id']

const titleNameMap = new Map<number, string>(
  NEARCADE_GAME_TITLES.map(t => [t.id, t.name]),
)

export function getNearcadeTitleName(titleId: number): string {
  return titleNameMap.get(titleId) ?? `未知机种 (${titleId})`
}

export function isKnownNearcadeTitleId(titleId: number): boolean {
  return titleNameMap.has(titleId)
}
