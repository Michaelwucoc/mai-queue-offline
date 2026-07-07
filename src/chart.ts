import * as fs from 'fs'
import * as path from 'path'

export const DEFAULT_CHART_HISTORY_HOURS = 24

export interface ChartPoint {
  timestamp: number
  count: number
  source?: 'local' | 'nearcade' | 'forecast'
  label?: string
}

export interface ChartOptions {
  title: string
  capacity: number
  points: ChartPoint[]
  predictedPoints?: ChartPoint[]
  historyHours?: number
  forecastHours?: number
  width?: number
  height?: number
  /** 图表「现在」锚点（默认当前时间，测试可指定） */
  referenceTime?: number
}

export interface ChartValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const now = new Date()
  if (d.getDate() !== now.getDate() || d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) {
    return `${month}-${day} ${hm}`
  }
  return hm
}

function smoothPath(coords: Array<{ x: number, y: number }>): string {
  if (coords.length === 0) return ''
  if (coords.length === 1) return `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`
  if (coords.length === 2) {
    return `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)} L ${coords[1].x.toFixed(1)} ${coords[1].y.toFixed(1)}`
  }

  let d = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)]
    const p1 = coords[i]
    const p2 = coords[i + 1]
    const p3 = coords[Math.min(coords.length - 1, i + 2)]

    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}

/**
 * 长时间无更新时保持上一值，直到下一采样点 / 现在。
 * 传入 isValidTime 时，仅在有效时段内填充（如营业+宽容期），
 * 其余时间留空，绘图时曲线自然断开。
 */
export function forwardFillHistorySeries(
  events: ChartPoint[],
  windowStart: number,
  windowEnd: number,
  stepMinutes = 30,
  isValidTime?: (ts: number) => boolean,
): ChartPoint[] {
  if (!events.length) return []
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  const stepMs = stepMinutes * 60000
  const result: ChartPoint[] = []

  let eventIdx = 0
  let lastValue = sorted[0].count
  let lastSource = sorted[0].source

  for (let t = windowStart; t <= windowEnd; t += stepMs) {
    while (eventIdx < sorted.length && sorted[eventIdx].timestamp <= t) {
      lastValue = sorted[eventIdx].count
      lastSource = sorted[eventIdx].source
      eventIdx++
    }
    if (t < sorted[0].timestamp) continue
    if (lastValue <= 0) continue
    if (isValidTime && !isValidTime(t)) continue
    result.push({
      timestamp: t,
      count: lastValue,
      source: lastSource,
    })
  }

  const lastEvent = sorted[sorted.length - 1]
  if (
    lastEvent.timestamp < windowEnd
    && lastEvent.count > 0
    && (!isValidTime || isValidTime(windowEnd))
  ) {
    const tail = result[result.length - 1]
    if (!tail || tail.timestamp < windowEnd - stepMs / 2) {
      result.push({
        timestamp: windowEnd,
        count: lastEvent.count,
        source: lastEvent.source,
      })
    } else if (tail.timestamp !== windowEnd) {
      tail.timestamp = windowEnd
      tail.count = lastEvent.count
    }
  }

  return result
}

/** 按时间空档切分为多段（空档 > maxGapMinutes 则断线） */
function splitIntoSegments(points: ChartPoint[], maxGapMinutes = 45): ChartPoint[][] {
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  for (const p of points) {
    const prev = current[current.length - 1]
    if (prev && p.timestamp - prev.timestamp > maxGapMinutes * 60000) {
      if (current.length) segments.push(current)
      current = []
    }
    current.push(p)
  }
  if (current.length) segments.push(current)
  return segments
}

/** 预测序列：省略 count=0 的点 */
export function filterForecastForDisplay(points: ChartPoint[]): ChartPoint[] {
  return points.filter(p => p.count > 0)
}

export function validateChartData(
  history: ChartPoint[],
  forecast: ChartPoint[],
  options: { historyHours: number; forecastHours: number; referenceTime: number },
): ChartValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { historyHours, forecastHours, referenceTime } = options
  const windowStart = referenceTime - historyHours * 3600000
  const windowEnd = referenceTime + forecastHours * 3600000

  const zeroForecast = forecast.filter(p => p.count === 0)
  if (zeroForecast.length > 0) {
    warnings.push(`预测含 ${zeroForecast.length} 个 0 值点（展示时应已省略）`)
  }

  for (const p of history) {
    if (p.timestamp < windowStart - 60000 || p.timestamp > referenceTime + 60000) {
      errors.push(`历史点越界: ${new Date(p.timestamp).toISOString()}`)
    }
    if (p.count <= 0) {
      warnings.push(`历史含 0 值点: ${new Date(p.timestamp).toISOString()}`)
    }
  }

  for (const p of forecast) {
    if (p.timestamp < referenceTime - 60000 || p.timestamp > windowEnd + 60000) {
      errors.push(`预测点越界: ${new Date(p.timestamp).toISOString()}`)
    }
  }

  if (history.length >= 2) {
    for (let i = 1; i < history.length; i++) {
      const gap = history[i].timestamp - history[i - 1].timestamp
      if (gap > 3 * 3600000 && history[i].count === history[i - 1].count) {
        // 大间隔且值相同 → 前向保持生效
        break
      }
    }
  }

  if (history.length < 3) {
    warnings.push(`历史点较少（${history.length}），曲线可能不完整`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

interface AxisSegment {
  start: number
  end: number
}

/** 按数据分布切出时间轴段落，段间空档将被压缩为断轴 */
function buildAxisSegments(
  timestamps: number[],
  minTime: number,
  maxTime: number,
  gapThresholdMs: number,
  padMs: number,
): AxisSegment[] {
  const ts = timestamps
    .filter(t => t >= minTime && t <= maxTime)
    .sort((a, b) => a - b)
  if (!ts.length) return [{ start: minTime, end: maxTime }]

  const raw: AxisSegment[] = []
  let start = ts[0]
  let prev = ts[0]
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - prev > gapThresholdMs) {
      raw.push({ start, end: prev })
      start = ts[i]
    }
    prev = ts[i]
  }
  raw.push({ start, end: prev })

  const merged: AxisSegment[] = []
  for (const seg of raw) {
    const padded: AxisSegment = {
      start: Math.max(minTime, seg.start - padMs),
      end: Math.min(maxTime, seg.end + padMs),
    }
    const last = merged[merged.length - 1]
    if (last && padded.start - last.end <= gapThresholdMs / 2) {
      last.end = Math.max(last.end, padded.end)
    } else {
      merged.push(padded)
    }
  }
  return merged
}

/** 分段线性时间→x 映射：数据段按时长分配像素，空档压缩为固定宽度 */
function makeCompressedTimeScale(
  segments: AxisSegment[],
  plotLeft: number,
  plotW: number,
  gapPx: number,
) {
  const totalMs = segments.reduce((sum, s) => sum + Math.max(1, s.end - s.start), 0)
  const dataPx = Math.max(1, plotW - gapPx * (segments.length - 1))
  const pxPerMs = dataPx / totalMs

  const placed = segments.map((seg, i) => ({ seg, x0: 0, index: i }))
  let cursor = plotLeft
  for (const p of placed) {
    p.x0 = cursor
    cursor += Math.max(1, p.seg.end - p.seg.start) * pxPerMs + gapPx
  }

  const toX = (ts: number): number => {
    if (ts <= segments[0].start) return plotLeft
    for (let i = 0; i < placed.length; i++) {
      const { seg, x0 } = placed[i]
      if (ts <= seg.end) {
        if (ts >= seg.start) return x0 + (ts - seg.start) * pxPerMs
        // 落在空档内：在压缩带内按比例放置
        const prev = placed[i - 1]
        const prevEndX = prev ? prev.x0 + Math.max(1, prev.seg.end - prev.seg.start) * pxPerMs : plotLeft
        const gapStart = prev ? prev.seg.end : segments[0].start
        const gapLen = Math.max(1, seg.start - gapStart)
        return prevEndX + ((ts - gapStart) / gapLen) * gapPx
      }
    }
    const last = placed[placed.length - 1]
    return last.x0 + Math.max(1, last.seg.end - last.seg.start) * pxPerMs
  }

  const gaps = placed.slice(1).map((p, i) => ({
    fromTs: placed[i].seg.end,
    toTs: p.seg.start,
    x: p.x0 - gapPx / 2,
  }))

  return { toX, gaps, placed, pxPerMs }
}

function formatSkippedDuration(ms: number): string {
  const hours = ms / 3600000
  if (hours >= 1) {
    const rounded = Math.round(hours * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`
  }
  return `${Math.round(ms / 60000)}m`
}

export function generateQueueChartSvg(options: ChartOptions): string {
  const width = options.width ?? 720
  const height = options.height ?? 320
  const historyHours = options.historyHours ?? DEFAULT_CHART_HISTORY_HOURS
  const forecastHours = options.forecastHours ?? 8
  const padding = { top: 48, right: 24, bottom: 44, left: 40 }
  const plotW = width - padding.left - padding.right
  const plotH = height - padding.top - padding.bottom

  const now = options.referenceTime ?? Date.now()
  const minTime = now - historyHours * 3600000
  const maxTime = now + forecastHours * 3600000

  // 调用方（predictor.getChartPoints）已完成前向保持与营业时段过滤，这里不再重复填充
  const sorted = [...options.points]
    .filter(p => p.count > 0 && p.timestamp >= minTime && p.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp)
  const predicted = filterForecastForDisplay(options.predictedPoints ?? [])

  if (sorted.length === 0 && predicted.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#f8fafc"/>
      <text x="${width / 2}" y="${height / 2}" fill="#94a3b8" text-anchor="middle" font-size="14" font-family="sans-serif">暂无数据</text>
    </svg>`
  }

  const allCounts = [
    options.capacity,
    ...sorted.map(p => p.count),
    ...predicted.map(p => p.count),
    1,
  ]
  const yMax = Math.ceil(Math.max(...allCounts) * 1.1)
  const toY = (count: number) => padding.top + plotH - (count / yMax) * plotH

  // 压缩时间轴：仅给有数据的时段分配空间，空档折叠为断轴
  const GAP_PX = 28
  const allTimestamps = [
    ...sorted.map(p => p.timestamp),
    ...predicted.map(p => p.timestamp),
    now,
  ]
  const segments = buildAxisSegments(allTimestamps, minTime, maxTime, 75 * 60000, 10 * 60000)
  const scale = makeCompressedTimeScale(segments, padding.left, plotW, GAP_PX)
  const toX = scale.toX

  const grid: string[] = []
  const ySteps = Math.min(5, yMax)
  for (let i = 0; i <= ySteps; i++) {
    const val = Math.round((yMax / ySteps) * i)
    const y = toY(val)
    grid.push(`<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#eef2f7" stroke-width="1"/>`)
    if (i > 0) {
      grid.push(`<text x="${padding.left - 8}" y="${y + 4}" fill="#94a3b8" font-size="10" text-anchor="end" font-family="sans-serif">${val}</text>`)
    }
  }

  // 每个数据段内自适应刻度密度（保证相邻刻度 >= 56px）
  const MIN_TICK_PX = 56
  const tickIntervals = [30, 60, 120, 240, 480].map(m => m * 60000)
  let lastTickLabelX = -Infinity
  let lastTickDay = -1
  const tzOffsetMs = new Date(now).getTimezoneOffset() * 60000

  for (const { seg } of scale.placed) {
    const segDuration = Math.max(1, seg.end - seg.start)
    const segWidth = segDuration * scale.pxPerMs
    let stepMs = tickIntervals[tickIntervals.length - 1]
    for (const candidate of tickIntervals) {
      if (segWidth / (segDuration / candidate) >= MIN_TICK_PX) {
        stepMs = candidate
        break
      }
    }

    const firstTick = Math.ceil((seg.start - tzOffsetMs) / stepMs) * stepMs + tzOffsetMs
    for (let ts = firstTick; ts <= seg.end; ts += stepMs) {
      const x = toX(ts)
      grid.push(`<line x1="${x.toFixed(1)}" y1="${padding.top}" x2="${x.toFixed(1)}" y2="${padding.top + plotH}" stroke="#f4f6f8" stroke-width="1"/>`)
      if (x - lastTickLabelX >= MIN_TICK_PX - 8) {
        const d = new Date(ts)
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        const label = d.getDate() !== lastTickDay ? `${d.getMonth() + 1}-${d.getDate()} ${hm}` : hm
        lastTickDay = d.getDate()
        grid.push(`<text x="${x.toFixed(1)}" y="${height - 12}" fill="#94a3b8" font-size="10" text-anchor="middle" font-family="sans-serif">${label}</text>`)
        lastTickLabelX = x
      }
    }
  }

  // 断轴省略标记：压缩带 + 双斜线 + 省略时长
  const axisY = padding.top + plotH
  const breakMarks = scale.gaps.map(g => {
    const skipped = formatSkippedDuration(g.toTs - g.fromTs)
    return `<!--axis-break-->
    <rect x="${(g.x - GAP_PX / 2).toFixed(1)}" y="${padding.top}" width="${GAP_PX}" height="${plotH}" fill="#eef2f7" opacity="0.55"/>
    <line x1="${(g.x - 5).toFixed(1)}" y1="${axisY + 5}" x2="${(g.x - 1).toFixed(1)}" y2="${axisY - 5}" stroke="#94a3b8" stroke-width="1.5"/>
    <line x1="${(g.x + 1).toFixed(1)}" y1="${axisY + 5}" x2="${(g.x + 5).toFixed(1)}" y2="${axisY - 5}" stroke="#94a3b8" stroke-width="1.5"/>
    <text x="${g.x.toFixed(1)}" y="${(padding.top + 12).toFixed(1)}" fill="#94a3b8" font-size="9" text-anchor="middle" font-family="sans-serif">…${skipped}</text>`
  }).join('\n')

  const nowX = toX(now)
  const plotRight = width - padding.right
  const forecastZone = `<rect x="${nowX.toFixed(1)}" y="${padding.top}" width="${Math.max(0, plotRight - nowX).toFixed(1)}" height="${plotH}" fill="#22c55e" opacity="0.05"/>
    <line x1="${nowX.toFixed(1)}" y1="${padding.top}" x2="${nowX.toFixed(1)}" y2="${padding.top + plotH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="${(nowX + 4).toFixed(1)}" y="${padding.top + 14}" fill="#64748b" font-size="10" font-family="sans-serif">现在</text>`

  let historySvg = ''
  if (sorted.length) {
    historySvg = splitIntoSegments(sorted)
      .map(segment => {
        const coords = segment.map(p => ({ x: toX(p.timestamp), y: toY(p.count) }))
        if (coords.length === 1) {
          return `<circle cx="${coords[0].x.toFixed(1)}" cy="${coords[0].y.toFixed(1)}" r="2.5" fill="#3b82f6"/>`
        }
        return `<path d="${smoothPath(coords)}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/>`
      })
      .join('\n')
  }

  let forecastSvg = ''
  if (predicted.length) {
    const anchor = sorted.length
      ? sorted[sorted.length - 1]
      : { timestamp: now, count: predicted[0].count }
    const forecastCoords = [
      { x: toX(anchor.timestamp), y: toY(anchor.count) },
      ...predicted.map(p => ({ x: toX(p.timestamp), y: toY(p.count) })),
    ]
    const forecastPath = smoothPath(forecastCoords)

    // 标签按最小像素间距挑选，避免互相重叠
    const MIN_LABEL_SPACING = 56
    let lastLabelX = -Infinity
    const labelled: ChartPoint[] = []
    for (let i = 0; i < predicted.length; i++) {
      const p = predicted[i]
      const x = toX(p.timestamp)
      const isLast = i === predicted.length - 1
      if (x - lastLabelX >= MIN_LABEL_SPACING || (isLast && x - lastLabelX >= MIN_LABEL_SPACING / 2)) {
        labelled.push(p)
        lastLabelX = x
      }
    }
    const forecastLabels = labelled
      .map(p => {
        const x = toX(p.timestamp)
        const y = toY(p.count)
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#22c55e" opacity="0.9"/>
          <text x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}" fill="#16a34a" font-size="9" text-anchor="middle" font-family="sans-serif">${escapeXml(p.label || formatTime(p.timestamp))}</text>`
      }).join('')

    forecastSvg = `<path d="${forecastPath}" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-dasharray="7 5" stroke-linecap="round"/>
      ${forecastLabels}`
  }

  const capacityY = toY(options.capacity)
  const capacityLine = `<line x1="${padding.left}" y1="${capacityY}" x2="${width - padding.right}" y2="${capacityY}" stroke="#f59e0b" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.85"/>
    <text x="${width - padding.right}" y="${capacityY - 5}" fill="#d97706" font-size="10" text-anchor="end" font-family="sans-serif">容量 ${options.capacity}</text>`

  const legend = `<g transform="translate(${padding.left}, 16)">
    <path d="M0 0 L16 0" stroke="#3b82f6" stroke-width="2.5" fill="none"/><text x="22" y="4" fill="#64748b" font-size="10" font-family="sans-serif">历史</text>
    <path d="M68 0 L84 0" stroke="#22c55e" stroke-width="2" stroke-dasharray="5 3" fill="none"/><text x="90" y="4" fill="#64748b" font-size="10" font-family="sans-serif">预测 ${forecastHours}h</text>
  </g>
  <text x="${width - padding.right}" y="20" fill="#94a3b8" font-size="10" text-anchor="end" font-family="sans-serif">30分钟采样 · 断轴为省略时段</text>`

  const subtitle = `近${historyHours}h → 未来${forecastHours}h`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="${padding.left}" y="36" fill="#1e293b" font-size="14" font-weight="600" font-family="sans-serif">${escapeXml(options.title)}</text>
  <text x="${width - padding.right}" y="36" fill="#94a3b8" font-size="10" text-anchor="end" font-family="sans-serif">${subtitle}</text>
  ${legend}
  ${grid.join('\n')}
  ${breakMarks}
  ${forecastZone}
  ${capacityLine}
  <line x1="${padding.left}" y1="${padding.top + plotH}" x2="${width - padding.right}" y2="${padding.top + plotH}" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotH}" stroke="#cbd5e1" stroke-width="1"/>
  ${historySvg}
  ${forecastSvg}
  <text x="${width / 2}" y="${height - 2}" fill="#cbd5e1" font-size="9" text-anchor="middle" font-family="sans-serif">仅供参考</text>
</svg>`
}

export async function renderChartToPng(svg: string, outputPath: string): Promise<string> {
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  try {
    const { Resvg } = await import('@resvg/resvg-js')
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 720 },
    })
    const pngData = resvg.render()
    fs.writeFileSync(outputPath, pngData.asPng())
    return outputPath
  } catch {
    const svgPath = outputPath.replace(/\.png$/, '.svg')
    fs.writeFileSync(svgPath, svg, 'utf8')
    return svgPath
  }
}
