import express from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { normalizeEvents, convertEventsSegmented } from './core.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT) || 3000

const jobs = new Map()

const MAX_CONCURRENT_JOBS = 1
// 세그먼트 변환으로 RAM은 길이와 무관하게 일정해지므로 hard cap만 남김 (남용/오작동 방지용 안전선)
const HARD_MAX_SESSION_MS = 60 * 60 * 1000
const SEGMENT_MS = 10 * 60 * 1000

function countRunningJobs() {
  let n = 0
  for (const j of jobs.values()) if (j.status === 'running') n++
  return n
}

app.use(express.static(path.join(__dirname, 'public')))

function pushEvent(job, evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`
  for (const res of job.subscribers) {
    try { res.write(line) } catch {}
  }
}

function replayJobEvents(job, res) {
  if (job.lastInit) res.write(`data: ${JSON.stringify(job.lastInit)}\n\n`)
  if (job.lastProgress) res.write(`data: ${JSON.stringify(job.lastProgress)}\n\n`)
  if (job.lastDone) res.write(`data: ${JSON.stringify(job.lastDone)}\n\n`)
  if (job.lastError) res.write(`data: ${JSON.stringify(job.lastError)}\n\n`)
}

app.post(
  '/jobs',
  express.raw({ type: '*/*', limit: '500mb' }),
  async (req, res) => {
    try {
      if (countRunningJobs() >= MAX_CONCURRENT_JOBS) {
        return res.status(429).json({ error: '다른 변환이 진행 중입니다. 잠시 후 다시 시도해주세요.' })
      }

      const speed = Math.max(1, Math.min(32, parseFloat(req.query.speed ?? '4')))
      const scale = Math.max(0.25, Math.min(1, parseFloat(req.query.scale ?? '0.75')))
      const filename = (req.query.filename || 'replay').toString().replace(/[^\w\-]+/g, '_')

      if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'empty body' })
      }

      let raw
      try {
        raw = JSON.parse(req.body.toString('utf8'))
      } catch {
        return res.status(400).json({ error: 'invalid JSON' })
      }
      const events = normalizeEvents(raw)
      if (events.length < 2) {
        return res.status(400).json({ error: 'rrweb 이벤트를 찾지 못했습니다.' })
      }

      const sessionMs = events[events.length - 1].timestamp - events[0].timestamp
      if (sessionMs > HARD_MAX_SESSION_MS) {
        return res.status(413).json({
          error: `세션이 너무 깁니다. 최대 ${HARD_MAX_SESSION_MS / 60000}분까지 지원합니다. (입력: ${(sessionMs / 60000).toFixed(1)}분)`,
        })
      }

      const id = randomUUID()
      const jobDir = path.join(tmpdir(), `rrweb-job-${id}`)
      await mkdir(jobDir, { recursive: true })
      const outPath = path.join(jobDir, `${filename}.mp4`)

      const job = {
        id,
        outPath,
        jobDir,
        downloadName: `${filename}.mp4`,
        status: 'running',
        startedAt: Date.now(),
        lastInit: null,
        lastProgress: null,
        lastDone: null,
        lastError: null,
        subscribers: new Set(),
      }
      jobs.set(id, job)

      res.json({ jobId: id })

      convertEventsSegmented({
        events,
        outPath,
        speed,
        scale,
        segmentMs: SEGMENT_MS,
        workDir: jobDir,
        onInit: (e) => {
          job.lastInit = { type: 'init', ...e }
          pushEvent(job, job.lastInit)
        },
        onProgress: (e) => {
          job.lastProgress = { type: 'progress', ...e }
          pushEvent(job, job.lastProgress)
        },
        onLog: (m) => {
          pushEvent(job, { type: 'log', message: m })
        },
      })
        .then(({ wallMs, outW, outH, size }) => {
          job.status = 'done'
          job.lastDone = {
            type: 'done',
            wallMs,
            outW,
            outH,
            size,
            downloadUrl: `/jobs/${id}/download`,
          }
          pushEvent(job, job.lastDone)
        })
        .catch((err) => {
          console.error(`[job ${id}]`, err)
          job.status = 'error'
          job.lastError = { type: 'error', message: err?.message ?? String(err) }
          pushEvent(job, job.lastError)
        })
    } catch (e) {
      console.error(e)
      res.status(500).json({ error: e?.message ?? String(e) })
    }
  },
)

app.get('/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).end()

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write(`data: ${JSON.stringify({ type: 'hello', jobId: job.id })}\n\n`)
  replayJobEvents(job, res)

  job.subscribers.add(res)
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch {}
  }, 15_000)
  req.on('close', () => {
    clearInterval(ping)
    job.subscribers.delete(res)
  })
})

app.get('/jobs/:id/download', async (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).end()
  if (job.status !== 'done') return res.status(409).json({ error: `status=${job.status}` })

  res.download(job.outPath, job.downloadName, () => {
    setTimeout(async () => {
      await rm(job.jobDir, { recursive: true, force: true }).catch(() => {})
      jobs.delete(job.id)
    }, 5 * 60 * 1000)
  })
})

setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (now - job.startedAt > 60 * 60 * 1000) {
      rm(job.jobDir, { recursive: true, force: true }).catch(() => {})
      jobs.delete(id)
    }
  }
}, 10 * 60 * 1000)

app.listen(PORT, () => {
  console.log(`\u{1F310}  http://localhost:${PORT}`)
})
