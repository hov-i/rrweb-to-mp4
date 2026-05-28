import { writeFile, mkdir, rm, stat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
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

// 세그먼트별로 fresh Chromium 인스턴스를 띄워 메모리를 리셋시키며 변환.
// 1GB RAM 환경에서도 긴 세션(1시간 등)을 처리하기 위한 핵심 함수.
// 각 윈도우는 [winStart, winEnd] 시간 범위를 담당하되, rrweb 재생을 위해
// winStart 이전의 가장 가까운 FullSnapshot(type=2) 부터 이벤트를 포함시킨다.
// 그 prefix 만큼 영상이 길어지므로 ffmpeg -ss 로 잘라낸 뒤 concat 한다.
export async function convertEventsSegmented({
  events,
  outPath,
  segmentMs = 15 * 60 * 1000,
  segmentThresholdMs,
  speed = 4,
  scale = 0.75,
  workDir,
  onInit = () => {},
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  // 임계값 미지정 시 segmentMs 와 같이 잡음 (= 항상 분할). 호출자가 명시하면 그 값을 사용.
  const threshold = segmentThresholdMs ?? segmentMs
  if (!events || events.length < 2) throw new Error('rrweb 이벤트가 부족합니다.')

  const meta = events.find((e) => e.type === 4)
  const srcW = Math.max(320, Math.min(3840, meta?.data?.width ?? 1280))
  const srcH = Math.max(240, Math.min(2160, meta?.data?.height ?? 720))
  const outW = Math.round((srcW * scale) / 2) * 2
  const outH = Math.round((srcH * scale) / 2) * 2
  const t0 = events[0].timestamp
  const tEnd = events[events.length - 1].timestamp
  const totalMs = tEnd - t0
  if (totalMs <= 0) throw new Error('재생 길이가 0입니다.')
  const replayMs = totalMs / speed

  const boundaries = []
  for (let s = t0; s < tEnd; s += segmentMs) {
    boundaries.push({ winStart: s, winEnd: Math.min(s + segmentMs, tEnd) })
  }
  const segCount = boundaries.length

  onInit({ srcW, srcH, outW, outH, totalMs, replayMs, segments: segCount })

  if (totalMs <= threshold) {
    onLog(`세션 ${(totalMs / 60000).toFixed(1)}분 ≤ 임계값 ${threshold / 60000}분 → 단일 변환으로 처리`)
    return await convertEvents({ events, outPath, speed, scale, onInit: () => {}, onProgress, onLog })
  }

  onLog(`총 ${segCount}개 세그먼트로 분할 (각 최대 ${segmentMs / 60000}분)`)

  const tmpRoot = workDir
    ? path.join(workDir, 'segments')
    : path.join(tmpdir(), `rrvideo-seg-${randomUUID()}`)
  await mkdir(tmpRoot, { recursive: true })

  const segFiles = []
  const started = Date.now()
  let cumulativeReplayWall = 0

  try {
    for (let i = 0; i < segCount; i++) {
      const { winStart, winEnd } = boundaries[i]
      const sliced = sliceForWindow(events, winStart, winEnd)
      if (!sliced || sliced.events.length < 2) {
        onLog(`세그먼트 ${i + 1}/${segCount} 건너뜀 (이벤트 부족)`)
        continue
      }

      const segDurMs = winEnd - winStart
      const segReplayMs = segDurMs / speed
      const skipMs = winStart - sliced.snapshotTs
      const skipSec = skipMs > 0 ? skipMs / speed / 1000 : 0

      const rawPath = path.join(tmpRoot, `seg-${String(i).padStart(3, '0')}-raw.mp4`)
      const segPath = path.join(tmpRoot, `seg-${String(i).padStart(3, '0')}.mp4`)

      onLog(
        `세그먼트 ${i + 1}/${segCount} 변환 중… (윈도우 ${(segDurMs / 60000).toFixed(1)}분` +
          (skipSec > 0.5 ? `, prefix ${(skipMs / 60000).toFixed(1)}분 trim 예정` : '') +
          `)`,
      )

      await convertEvents({
        events: sliced.events,
        outPath: rawPath,
        speed,
        scale,
        onInit: () => {},
        onProgress: ({ wallMs }) => {
          const segPct = Math.min(1, wallMs / Math.max(1, segReplayMs + skipSec * 1000))
          const overallWall = cumulativeReplayWall + segPct * (segReplayMs + skipSec * 1000)
          const percent = Math.min(99, (overallWall / replayMs) * 100)
          onProgress({
            percent,
            wallMs: Date.now() - started,
            replayMs,
            segment: i + 1,
            segments: segCount,
          })
        },
        onLog: (m) => onLog(`[${i + 1}/${segCount}] ${m}`),
      })

      if (skipSec > 0.5) {
        await ffmpegTrim(rawPath, segPath, skipSec)
        await rm(rawPath, { force: true }).catch(() => {})
      } else {
        await rename(rawPath, segPath)
      }
      segFiles.push(segPath)
      cumulativeReplayWall += segReplayMs + skipSec * 1000
    }

    if (segFiles.length === 0) throw new Error('변환된 세그먼트가 없습니다.')

    if (segFiles.length === 1) {
      onLog('세그먼트가 1개라 concat 생략, 그대로 출력합니다.')
      await rename(segFiles[0], outPath)
    } else {
      onLog(`ffmpeg concat 시작 (${segFiles.length}개 세그먼트)…`)
      await ffmpegConcat(segFiles, outPath)
    }

    const info = await stat(outPath).catch(() => null)
    const wallMs = Date.now() - started
    onProgress({ percent: 100, wallMs, replayMs, segment: segCount, segments: segCount })
    return { wallMs, outW, outH, size: info?.size ?? 0 }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function sliceForWindow(events, winStart, winEnd) {
  const meta = events.find((e) => e.type === 4)
  let snapIdx = -1
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.timestamp > winStart) break
    if (e.type === 2) snapIdx = i
  }
  if (snapIdx === -1) {
    snapIdx = events.findIndex((e) => e.type === 2)
    if (snapIdx === -1) return null
  }
  const out = []
  if (meta && events.indexOf(meta) !== snapIdx) out.push(meta)
  for (let i = snapIdx; i < events.length; i++) {
    if (events[i].timestamp > winEnd) break
    out.push(events[i])
  }
  return { events: out, snapshotTs: events[snapIdx].timestamp }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 종료 코드 ${code}: ${stderr.slice(-500)}`))
    })
  })
}

async function ffmpegTrim(input, output, skipSec) {
  // -ss 를 -i 앞에 두면 keyframe 단위로 빠르게 seek (정밀도는 1~2초 오차 가능)
  await runFfmpeg(['-y', '-ss', String(skipSec.toFixed(3)), '-i', input, '-c', 'copy', output])
}

async function ffmpegConcat(inputs, output) {
  const listFile = output + '.concat.txt'
  // ffmpeg concat demuxer는 파일 경로에 작은따옴표가 있으면 이스케이프 필요
  const content = inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listFile, content)
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output])
  } finally {
    await rm(listFile, { force: true }).catch(() => {})
  }
}
