#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeEvents, convertEvents } from './core.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

function usage() {
  console.log(`Usage:
  node convert.mjs <input.json> [output.mp4] [options]

Options:
  --speed N    비디오 재생 속도 (기본 4)
  --scale N    해상도 배율 0.25~1 (기본 0.75)
`)
}

const args = parseArgs(process.argv.slice(2))
const input = args._[0]
if (!input) {
  usage()
  process.exit(1)
}
const outArg = args._[1]
const outPath = path.resolve(outArg || input.replace(/\.json$/i, '.mp4'))

console.log(`\u{1F4C2} ${input}`)
const raw = JSON.parse(await readFile(path.resolve(input), 'utf8'))
const events = normalizeEvents(raw)
console.log(`✓ ${events.length} events`)

let lastLogAt = 0
const result = await convertEvents({
  events,
  outPath,
  speed: parseFloat(args.speed ?? '4'),
  scale: parseFloat(args.scale ?? '0.75'),
  onInit: ({ srcW, srcH, totalMs, replayMs }) => {
    console.log(
      `\u{1F4CF} ${srcW}×${srcH} | session ${(totalMs / 1000).toFixed(1)}s | expected ${(replayMs / 1000).toFixed(1)}s`,
    )
  },
  onProgress: ({ wallMs, replayMs }) => {
    if (Date.now() - lastLogAt < 500) return
    lastLogAt = Date.now()
    const pct = Math.min(100, (wallMs / replayMs) * 100).toFixed(0)
    process.stdout.write(
      `\r⏺  ${pct}% | ${(wallMs / 1000).toFixed(1)}s   `,
    )
  },
  onLog: (m) => console.log('\n' + m),
})
process.stdout.write('\n')
console.log(`✅ ${outPath} (${(result.size / 1024 / 1024).toFixed(1)} MB, ${(result.wallMs / 1000).toFixed(1)}s)`)
