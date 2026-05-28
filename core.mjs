import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { transformToVideo } from 'rrvideo'

export function normalizeEvents(raw) {
  const visit = (n) => {
    if (!n) return []
    if (Array.isArray(n)) {
      if (n.length && typeof n[0] === 'object' && 'type' in n[0] && 'timestamp' in n[0]) {
        return n
      }
      return n.flatMap(visit)
    }
    if (typeof n === 'object') {
      if (Array.isArray(n.events)) return visit(n.events)
      if (Array.isArray(n.segments)) return visit(n.segments)
      if (n.data) return visit(n.data)
    }
    return []
  }
  const events = visit(raw)
  events.sort((a, b) => a.timestamp - b.timestamp)
  return events
}

export async function convertEvents({
  events,
  outPath,
  speed = 4,
  scale = 0.75,
  onInit = () => {},
  onProgress = () => {},
  onLog = () => {},
  signal,
} = {}) {
  if (!events || events.length < 2) throw new Error('rrweb 이벤트가 부족합니다.')
  if (signal?.aborted) throw new Error('aborted')

  const meta = events.find((e) => e.type === 4)
  const srcW = Math.max(320, Math.min(3840, meta?.data?.width ?? 1280))
  const srcH = Math.max(240, Math.min(2160, meta?.data?.height ?? 720))
  const outW = Math.round((srcW * scale) / 2) * 2
  const outH = Math.round((srcH * scale) / 2) * 2
  const totalMs = events[events.length - 1].timestamp - events[0].timestamp
  if (totalMs <= 0) throw new Error('재생 길이가 0입니다.')
  const replayMs = totalMs / speed

  onInit({ srcW, srcH, outW, outH, totalMs, replayMs })

  const tmp = path.join(tmpdir(), `rrvideo-${randomUUID()}`)
  await mkdir(tmp, { recursive: true })
  const inputPath = path.join(tmp, 'events.json')
  await writeFile(inputPath, JSON.stringify(events))

  const started = Date.now()
  let rrvideoPercent = null

  const timer = setInterval(() => {
    const wallMs = Date.now() - started
    const timeBased = Math.min(99, (wallMs / replayMs) * 100)
    const percent =
      rrvideoPercent != null ? Math.max(rrvideoPercent, timeBased) : timeBased
    onProgress({ percent, wallMs, replayMs })
  }, 500)

  try {
    onLog(`rrvideo 시작 (speed=${speed}x, ratio=${scale})…`)
    onLog('Playwright Chromium 기동 중… (첫 실행이면 다운로드 대기 길 수 있음)')

    await transformToVideo({
      input: inputPath,
      output: outPath,
      headless: true,
      resolutionRatio: scale,
      onProgressUpdate: (data) => {
        let n = null
        if (typeof data === 'number' && Number.isFinite(data)) {
          n = data
        } else if (data && typeof data === 'object') {
          const cand =
            data.payload ?? data.percent ?? data.progress ?? data.detail?.payload
          if (typeof cand === 'number' && Number.isFinite(cand)) n = cand
        }
        if (n !== null) {
          const normalized = n <= 1 ? n * 100 : n
          rrvideoPercent = Math.max(0, Math.min(100, normalized))
        }
      },
      rrwebPlayer: {
        speed,
        skipInactive: true,
        showWarning: false,
        mouseTail: false,
      },
    })

    const info = await stat(outPath).catch(() => null)
    const wallMs = Date.now() - started
    onProgress({ percent: 100, wallMs, replayMs })
    return { wallMs, outW, outH, size: info?.size ?? 0 }
  } finally {
    clearInterval(timer)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
