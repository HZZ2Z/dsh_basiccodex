// Repair session logs written by dsh-plugin-session-pause <= 0.1.0.
//
// The old continuation message was created with createDeveloperMessage() but the
// agent loop appends every followup message as `user/message`. Format v4 restore
// then refuses the log with:
//   "developer/message and developer role must occur together"
//
// The fix rewrites the offending `user/message` event's role to `user`, which is
// what the corrected plugin writes. Frames are independently decodable Zstandard
// frames; unchanged frames are copied through byte for byte.
//
// Usage:
//   node tools/repair-developer-role.mjs <session.v4.jsonl.zstd> [...]
//   node tools/repair-developer-role.mjs --apply <session.v4.jsonl.zstd> [...]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { constants } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const apply = process.argv.includes('--apply')
const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))

const here = path.dirname(fileURLToPath(import.meta.url))
const moduleRoots = [
  path.resolve(here, '../../.asar-tools/repro/node_modules'),
  path.resolve(here, '../node_modules'),
]
const moduleRoot = moduleRoots.find((root) => fs.existsSync(path.join(root, '@deepseek-ai/dsh-session-format-catalog')))
if (moduleRoot === undefined) throw new Error('cannot locate @deepseek-ai/dsh-session-format-catalog; run from the workspace or install profile dependencies')
const load = (specifier) => import(pathToFileURL(path.join(moduleRoot, specifier)).href)
const { sessionFormatCatalog } = await load('@deepseek-ai/dsh-session-format-catalog/lib/index.js')
const { KNOWN_SESSION_EVENT_TYPES } = await load('@deepseek-ai/dsh-session/lib/index.js')
KNOWN_SESSION_EVENT_TYPES.add('turn/suspend')
KNOWN_SESSION_EVENT_TYPES.add('turn/resume')

/** Split a concatenated-frame container into its frames. */
function splitFrames(bytes) {
  const starts = []
  let from = 0
  for (;;) {
    const at = bytes.indexOf(MAGIC, from)
    if (at < 0) break
    starts.push(at)
    from = at + 1
  }
  return starts.map((start, index) => bytes.subarray(start, index + 1 < starts.length ? starts[index + 1] : bytes.length))
}

/** Validate one log against the harness's real reader. */
function validate(headerRow, rowTexts) {
  const restore = sessionFormatCatalog.createRestore(JSON.parse(headerRow), { validation: 'current' })
  try {
    for (const text of rowTexts) {
      for (const row of text.split('\n').filter(Boolean)) restore.decodeRow(JSON.parse(row))
    }
    restore.finish()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

if (targets.length === 0) {
  console.error('usage: node tools/repair-developer-role.mjs [--apply] <session.v4.jsonl.zstd> [...]')
  process.exit(2)
}

for (const file of targets) {
  console.log(`\n=== ${file}`)
  const bytes = fs.readFileSync(file)
  const frames = splitFrames(bytes)
  const decoded = frames.map((frame) => zlib.zstdDecompressSync(frame).toString('utf8'))
  const headerText = decoded[0]
  const before = validate(headerText, decoded.slice(1))
  console.log('before: ' + (before.ok ? 'loads' : 'REFUSED — ' + before.error))
  if (before.ok) {
    console.log('no repair needed')
    continue
  }

  let changed = 0
  const outFrames = [frames[0]]
  for (let index = 1; index < decoded.length; index += 1) {
    const text = decoded[index]
    const rows = text.split('\n').filter(Boolean)
    const next = rows.map((row) => {
      const event = JSON.parse(row)
      if (event.type !== 'user/message') return row
      if (event.data?.role !== 'developer') return row
      changed += 1
      return JSON.stringify({ ...event, data: { ...event.data, role: 'user' } })
    })
    const body = next.join('\n') + '\n'
    outFrames.push(body === text ? frames[index] : zlib.zstdCompressSync(Buffer.from(body, 'utf8'), CHECKSUM_OPTIONS))
  }
  console.log(`rewrote ${changed} user/message role(s)`)

  const repairedRows = outFrames.slice(1).map((frame) => zlib.zstdDecompressSync(frame).toString('utf8'))
  const after = validate(headerText, repairedRows)
  console.log('after:  ' + (after.ok ? 'LOADS OK' : 'still refused — ' + after.error))
  if (!after.ok) {
    process.exitCode = 1
    continue
  }
  if (apply) {
    const backup = `${file}.bak-session-pause-role`
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
    fs.writeFileSync(file, Buffer.concat(outFrames))
    console.log(`applied (backup: ${backup})`)
  } else {
    console.log('dry run — pass --apply to write')
  }
}
