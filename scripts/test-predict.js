const fs = require('fs')
const path = require('path')
const {
  ArcadePredictor,
  DEFAULT_FORECAST_HOURS,
  DEFAULT_FORECAST_STEP_MINUTES,
  DEFAULT_HISTORY_HOURS,
  FORECAST_DISCLAIMER,
} = require('../lib/predictor')
const {
  DEFAULT_CHART_HISTORY_HOURS,
  generateQueueChartSvg,
  renderChartToPng,
  filterForecastForDisplay,
  validateChartData,
} = require('../lib/chart')
const {
  isOperatingHour,
  isOperatingOrGrace,
  resolveOperatingHours,
  DEFAULT_CLOSE_GRACE_MINUTES,
} = require('../lib/event-quality')

const root = path.join(__dirname, '..')
const sandbox = path.join(root, 'data', 'test-sandbox')
const arcadeId = 'sandbox'
const arcadeName = '测试机厅（24h 预览）'
const machineCount = 6
const playersPerMachine = 2
const capacity = machineCount * playersPerMachine

const globalHours = {
  openHour: 10,
  closeHour: 23,
  closeGraceMinutes: DEFAULT_CLOSE_GRACE_MINUTES,
}
const pctx = {
  operatingHours: resolveOperatingHours(globalHours),
  machineCount,
  playersPerMachine,
}

fs.rmSync(sandbox, { recursive: true, force: true })
fs.mkdirSync(path.join(sandbox, 'charts'), { recursive: true })

const predictor = new ArcadePredictor(sandbox)

function pickReferenceTime() {
  const ref = new Date()
  ref.setHours(20, 30, 0, 0)
  if (ref.getTime() > Date.now()) ref.setDate(ref.getDate() - 1)
  return ref.getTime()
}

const refTime = pickReferenceTime()
const windowStart = refTime - DEFAULT_HISTORY_HOURS * 3600000

function at(ts) {
  return new Date(ts).toISOString()
}

function synthCount(date) {
  const h = date.getHours() + date.getMinutes() / 60
  if (h >= 10 && h < 12) return Math.round(3 + (h - 10) * 2)
  if (h >= 12 && h < 14) return Math.round(8 + Math.sin(((h - 12) / 2) * Math.PI) * 4)
  if (h >= 14 && h < 17) return Math.round(9 + (h - 14) * 0.5)
  if (h >= 17 && h < 20) return Math.round(11 + Math.sin(((h - 17) / 3) * Math.PI) * 5)
  if (h >= 20) return Math.round(Math.max(4, 14 - (h - 20) * 2.5))
  if (h < 1.5) return Math.round(Math.max(2, 8 - h * 4))
  return 0
}

// 24h 窗口内稀疏采样，含前一晚 + 今天白天，留 3h 空档（测前向保持）
const samples = []
for (let t = windowStart; t < refTime - 3 * 3600000; t += 90 * 60_000) {
  const d = new Date(t)
  if (!isOperatingOrGrace(d, pctx.operatingHours)) continue
  const c = synthCount(d)
  if (c <= 0) continue
  samples.push([at(t), c])
}
// 3 小时无更新后一条
samples.push([at(refTime - 30 * 60_000), 6])

let prev = samples[0][1]
for (const [ts, count] of samples) {
  predictor.recordEvent(arcadeId, count, count - prev, machineCount, ts, 'local', pctx)
  prev = count
}

// 凌晨清零事件（模拟平台每天 00:00 重置），不应污染模型
const resetTime = new Date(refTime)
resetTime.setHours(0, 5, 0, 0)
const departureBefore = predictor.getModel(arcadeId).avgDepartureRate
predictor.recordEvent(arcadeId, 0, -8, machineCount, resetTime.toISOString(), 'nearcade', pctx)
const departureAfter = predictor.getModel(arcadeId).avgDepartureRate

// 脏数据：深夜有人、人数爆表 —— 应被拒绝
for (const e of [
  { hour: 4, minute: 0, count: 12, diff: 0 },
  { hour: 14, minute: 0, count: 80, diff: 40 },
]) {
  const d = new Date(refTime)
  d.setHours(e.hour, e.minute, 0, 0)
  predictor.recordEvent(arcadeId, e.count, e.diff, machineCount, d.toISOString(), 'local', pctx)
}

predictor.sanitizeAll({ [arcadeId]: pctx })

const currentCount = samples[samples.length - 1][1]
const wait = predictor.predictWaitTime(arcadeId, currentCount, machineCount, playersPerMachine, 15, true, pctx)
const forecast = predictor.predictForecast(
  arcadeId, currentCount, DEFAULT_FORECAST_HOURS, DEFAULT_FORECAST_STEP_MINUTES, pctx, refTime,
)
const recommendation = predictor.recommendVisitTime(forecast, capacity, currentCount, arcadeId, pctx, refTime)
const schedule = predictor.formatForecastSchedule(forecast, recommendation.bestMinutes)
const points = predictor.getChartPoints(arcadeId, DEFAULT_HISTORY_HOURS, pctx, refTime)
const displayForecast = filterForecastForDisplay(forecast.map(p => ({
  timestamp: p.timestamp,
  count: p.predictedCount,
  label: p.label,
})))

const checks = []

// 1) 文字/图表不含 0 值预测
if (schedule.split('\n').some(line => /~0人/.test(line))) {
  checks.push('文字预测仍含 0 人条目')
}
if (displayForecast.some(p => p.count === 0)) {
  checks.push('图表预测仍含 0 值点')
}

// 2) 前向保持：3h 空档期间维持上一值
const holdValue = samples[samples.length - 2][1]
const holdSegment = points.filter(p =>
  p.timestamp > new Date(samples[samples.length - 2][0]).getTime()
  && p.timestamp < new Date(samples[samples.length - 1][0]).getTime()
  && p.count === holdValue,
)
if (holdSegment.length < 2) {
  checks.push('前向保持未生效：空档期间曲线未维持上一值')
}

// 3) 夜间断线：宽容期结束(01:30)到开门(10:00)之间不应有历史点
const nightPoints = points.filter(p => {
  const d = new Date(p.timestamp)
  return !isOperatingOrGrace(d, pctx.operatingHours)
})
if (nightPoints.length > 0) {
  checks.push(`夜间闭店时段出现 ${nightPoints.length} 个历史点，曲线未断开`)
}

// 4) 凌晨清零不学习离场速率
if (Math.abs(departureAfter - departureBefore) > 1e-9) {
  checks.push(`凌晨清零污染了离场速率：${departureBefore} → ${departureAfter}`)
}

// 5) 宽容期预测存在且向 0 衰减
const gracePoints = forecast.filter(p => {
  const d = new Date(p.timestamp)
  return !isOperatingHour(d, pctx.operatingHours) && isOperatingOrGrace(d, pctx.operatingHours)
})
if (gracePoints.length) {
  const first = gracePoints[0].predictedCount
  const last = gracePoints[gracePoints.length - 1].predictedCount
  if (last > first) {
    checks.push(`宽容期预测未衰减：${first} → ${last}`)
  }
}

// 6) 预测不超过合理上限
const maxReasonable = machineCount * playersPerMachine * 6
if (forecast.some(p => p.predictedCount > maxReasonable)) {
  checks.push('预测超出合理人数上限')
}

const validation = validateChartData(points, displayForecast, {
  historyHours: DEFAULT_CHART_HISTORY_HOURS,
  forecastHours: DEFAULT_FORECAST_HOURS,
  referenceTime: refTime,
})

const pngPath = path.join(sandbox, 'charts', 'test-preview.png')
const svg = generateQueueChartSvg({
  title: arcadeName,
  capacity,
  points,
  predictedPoints: forecast.map(p => ({
    timestamp: p.timestamp,
    count: p.predictedCount,
    source: 'forecast',
    label: p.label,
  })),
  historyHours: DEFAULT_CHART_HISTORY_HOURS,
  forecastHours: DEFAULT_FORECAST_HOURS,
  referenceTime: refTime,
})

// 7) SVG 标签不重叠（相邻预测标签中心距 >= 48px）
const labelXs = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" fill="#16a34a"/g)]
  .map(m => parseFloat(m[1]))
  .sort((a, b) => a - b)
for (let i = 1; i < labelXs.length; i++) {
  if (labelXs[i] - labelXs[i - 1] < 48) {
    checks.push(`预测标签间距过近：${labelXs[i - 1].toFixed(0)}px 与 ${labelXs[i].toFixed(0)}px`)
    break
  }
}
if (svg.includes('0值省略')) {
  checks.push('图例仍含「0值省略」')
}

// 8) 断轴省略：闭店空档应折叠为断轴标记
const breakCount = (svg.match(/<!--axis-break-->/g) || []).length
if (breakCount < 1) {
  checks.push('未生成断轴省略标记（闭店空档未压缩）')
}

// 9) 底部时间刻度不重叠（相邻刻度标签中心距 >= 40px）
const tickXs = [...svg.matchAll(/<text x="([\d.]+)" y="\d+" fill="#94a3b8" font-size="10" text-anchor="middle"/g)]
  .map(m => parseFloat(m[1]))
  .sort((a, b) => a - b)
for (let i = 1; i < tickXs.length; i++) {
  if (tickXs[i] - tickXs[i - 1] < 40) {
    checks.push(`时间刻度间距过近：${tickXs[i - 1].toFixed(0)}px 与 ${tickXs[i].toFixed(0)}px`)
    break
  }
}

;(async () => {
  const chartPath = await renderChartToPng(svg, pngPath)

  console.log('')
  console.log('=== predict 24h 图表测试 ===')
  console.log(`窗口: 近 ${DEFAULT_CHART_HISTORY_HOURS}h → 未来 ${DEFAULT_FORECAST_HOURS}h`)
  console.log(`营业: ${globalHours.openHour}:00–${globalHours.closeHour}:59 + 宽容 ${globalHours.closeGraceMinutes} 分钟`)
  console.log(`锚点「现在」: ${new Date(refTime).toLocaleString('zh-CN')}`)
  console.log(`原始事件: ${samples.length} 条 | 图表历史点: ${points.length} | 预测展示: ${displayForecast.length} 点`)
  console.log(`置信度: ${wait.confidence}%`)
  console.log('')
  console.log(schedule || '（无非零预测时段）')
  console.log('')
  console.log(`推荐: ${recommendation.reason}`)
  console.log(FORECAST_DISCLAIMER)
  console.log('')

  if (validation.warnings.length) {
    console.log('提示:')
    validation.warnings.forEach(w => console.log(' -', w))
  }

  const failed = [...checks, ...validation.errors]
  if (failed.length) {
    console.log('校验失败:')
    failed.forEach(line => console.log(' -', line))
    process.exitCode = 1
  } else {
    console.log(`校验通过: 24h窗口 / 前向保持 / 断轴省略(${breakCount}处) / 清零防护 / 宽容衰减 / 标签间距`)
  }
  console.log(`图表: ${chartPath}`)

  if (process.platform === 'darwin' && fs.existsSync(chartPath)) {
    require('child_process').execSync(`open "${chartPath}"`)
  }
})()
