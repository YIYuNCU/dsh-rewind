/**
 * Load and timing checks for the file ledger.
 * Budgets are "this got stuck" ceilings, not a tuned benchmark.
 */
import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RewindEngine } from '../lib/engine.js'

const report = []

function note(name, ms, detail = '') {
  const row = { name, ms: Math.round(ms * 10) / 10, detail }
  report.push(row)
  console.log(`${name}: ${row.ms} ms${detail === '' ? '' : ` (${detail})`}`)
}

function elapsed(start) {
  return performance.now() - start
}

async function fixture(config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-stress-'))
  const workspace = join(root, 'work')
  const storageDir = join(root, 'state')
  await mkdir(workspace)
  const engine = new RewindEngine({
    storageDir,
    retentionDays: 0,
    maxCheckpointsPerSession: 10_000,
    maxStoredTurns: 10_000,
    maxStorageBytes: 512 * 1024 * 1024,
    maxSessionBytes: 512 * 1024 * 1024,
    captureExternal: false,
    ...config,
  })
  await engine.initialize()
  return {
    root,
    workspace,
    storageDir,
    engine,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function openTurn(engine, workspace, turn, sessionId = 'session-stress') {
  await engine.beginTurn({ sessionId, workspace, turn, turnStartSeq: turn * 10 })
  await engine.noteUserMessage(sessionId, turn, turn * 10 + 1)
  return sessionId
}

async function changeFile(engine, workspace, sessionId, callId, path, before, after) {
  const absolute = join(workspace, path)
  await mkdir(join(absolute, '..'), { recursive: true })
  if (before !== undefined) await writeFile(absolute, before)
  await engine.captureBefore({
    sessionId, subagent: false, callId, toolName: 'edit', args: { file_path: path, old_string: 'before', new_string: 'after' },
  })
  await writeFile(absolute, after)
  await engine.captureAfter({ sessionId, subagent: false, callId, toolName: 'edit', ok: true })
}

async function countBlobs(storageDir) {
  const root = join(storageDir, 'blobs')
  let count = 0
  let names
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  for (const name of names) {
    count += (await readdir(join(root, name))).length
  }
  return count
}

function percentile(samples, ratio) {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))
  return sorted[index] ?? 0
}

test('sequential burst captures, previews past the page, and restores every file', async () => {
  const count = 80
  const fx = await fixture({ maxPreviewFiles: 10 })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const samples = []
    const started = performance.now()
    for (let index = 0; index < count; index += 1) {
      const step = performance.now()
      const name = index === 0 ? join('笔记', '甲.txt') : `file-${String(index).padStart(3, '0')}.txt`
      await changeFile(fx.engine, fx.workspace, sessionId, `c${String(index)}`, name, `before-${String(index)}`, `after-${String(index)}`)
      samples.push(elapsed(step))
    }
    const captureMs = elapsed(started)
    note('burst capture 80 files', captureMs, `p50 ${percentile(samples, 0.5).toFixed(1)} ms, p95 ${percentile(samples, 0.95).toFixed(1)} ms, last ${samples.at(-1).toFixed(1)} ms`)
    assert.ok(captureMs < 60_000, `capture took ${captureMs.toFixed(0)} ms`)

    const previewStarted = performance.now()
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    note('preview 80 files', elapsed(previewStarted))
    assert.equal(preview.totalFiles, count)
    assert.equal(preview.files.length, 10)
    assert.equal(preview.hiddenCount, count - 10)
    assert.equal(preview.files.every(file => file.state === 'clean'), true)

    const restoreStarted = performance.now()
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    note('restore 80 files', elapsed(restoreStarted))
    assert.equal(await readFile(join(fx.workspace, '笔记', '甲.txt'), 'utf8'), 'before-0')
    assert.equal(await readFile(join(fx.workspace, 'file-079.txt'), 'utf8'), 'before-79')

    const reloaded = new RewindEngine({ storageDir: fx.storageDir, retentionDays: 0, maxPreviewFiles: 10, maxStoredTurns: 10_000 })
    await reloaded.initialize()
    const again = await reloaded.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(again.totalFiles, count)
    assert.equal(await readFile(join(fx.workspace, 'file-079.txt'), 'utf8'), 'before-79')
  } finally {
    await fx.cleanup()
  }
})

test('identical contents share one blob', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const payload = 'same-bytes'
    const started = performance.now()
    for (let index = 0; index < 30; index += 1) {
      await changeFile(fx.engine, fx.workspace, sessionId, `d${String(index)}`, `dup-${String(index)}.txt`, payload, payload)
    }
    const blobs = await countBlobs(fx.storageDir)
    note('dedup 30 identical files', elapsed(started), `${String(blobs)} blobs`)
    assert.equal(blobs, 1)
  } finally {
    await fx.cleanup()
  }
})

test('a 2 MiB file is captured and restored', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const before = Buffer.alloc(2 * 1024 * 1024, 1)
    const after = Buffer.alloc(2 * 1024 * 1024, 2)
    const started = performance.now()
    await changeFile(fx.engine, fx.workspace, sessionId, 'big', 'big.bin', before, after)
    const captureMs = elapsed(started)
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    const restoreStarted = performance.now()
    const restored = await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    const restoreMs = elapsed(restoreStarted)
    const got = await readFile(join(fx.workspace, 'big.bin'))
    note('2 MiB capture', captureMs, `preview ${preview.files.map(file => `${file.state}/${file.action}`).join(',') || 'none'} restored ${restored.restored.length} skipped ${restored.skipped.length} byte0 ${String(got[0])}`)
    note('2 MiB restore', restoreMs)
    assert.ok(captureMs < 15_000)
    assert.ok(restoreMs < 15_000)
    assert.equal((await readFile(join(fx.workspace, 'big.bin'))).compare(before), 0)
  } finally {
    await fx.cleanup()
  }
})

test('the global turn cap drops the oldest turns and keeps the newest restorable', async () => {
  const turns = 24
  const keep = 8
  const fx = await fixture({ maxStoredTurns: keep, maxStorageBytes: 64 * 1024 * 1024 })
  try {
    const sessionId = 'session-cap'
    const started = performance.now()
    for (let turn = 1; turn <= turns; turn += 1) {
      await openTurn(fx.engine, fx.workspace, turn, sessionId)
      await changeFile(
        fx.engine, fx.workspace, sessionId, `t${String(turn)}`, `turn-${String(turn)}.txt`,
        `before-${String(turn)}`, `after-${String(turn)}`,
      )
    }
    note('24 turns under a cap of 8', elapsed(started))
    const usage = await fx.engine.usage()
    assert.equal(usage.length, 1)
    assert.equal(usage[0]?.checkpoints, keep)
    const remaining = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(remaining.totalFiles, keep)
    assert.equal(remaining.files.some(file => file.path === 'turn-1.txt'), false)
    const newest = turns
    const preview = await fx.engine.preview({
      sessionId, workspace: fx.workspace, turn: newest, userMessageSeq: newest * 10 + 1,
    })
    assert.equal(preview.totalFiles >= 1, true)
    await fx.engine.apply({
      sessionId, workspace: fx.workspace, turn: newest, userMessageSeq: newest * 10 + 1, fingerprint: preview.fingerprint,
    })
    await fx.engine.commit(fx.workspace)
    assert.equal(await readFile(join(fx.workspace, `turn-${String(newest)}.txt`), 'utf8'), `before-${String(newest)}`)
  } finally {
    await fx.cleanup()
  }
})

test('concurrent edits of different paths all restore', async () => {
  const count = 32
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const started = performance.now()
    await Promise.all(Array.from({ length: count }, (_, index) => changeFile(
      fx.engine, fx.workspace, sessionId, `p${String(index)}`, `parallel-${String(index)}.txt`,
      `before-${String(index)}`, `after-${String(index)}`,
    )))
    note('32 concurrent paths', elapsed(started))
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.totalFiles, count)
    assert.equal(preview.files.every(file => file.state === 'clean'), true)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    assert.equal(await readFile(join(fx.workspace, 'parallel-0.txt'), 'utf8'), 'before-0')
    assert.equal(await readFile(join(fx.workspace, 'parallel-31.txt'), 'utf8'), 'before-31')
  } finally {
    await fx.cleanup()
  }
})

test('concurrent edits of one path still restore the original bytes', async () => {
  const trials = 20
  const width = 8
  let lost = 0
  const started = performance.now()
  for (let trial = 0; trial < trials; trial += 1) {
    const fx = await fixture()
    try {
      const sessionId = await openTurn(fx.engine, fx.workspace, 1)
      await writeFile(join(fx.workspace, 'race.txt'), 'v0')
      await Promise.all(Array.from({ length: width }, async (_, index) => {
        const callId = `r${String(trial)}-${String(index)}`
        await fx.engine.captureBefore({
          sessionId, subagent: false, callId, toolName: 'write', args: { file_path: 'race.txt', content: `v${String(index + 1)}` },
        })
        await writeFile(join(fx.workspace, 'race.txt'), `v${String(index + 1)}`)
        await fx.engine.captureAfter({ sessionId, subagent: false, callId, toolName: 'write', ok: true })
      }))
      const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
      await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
      await fx.engine.commit(fx.workspace)
      const restored = await readFile(join(fx.workspace, 'race.txt'), 'utf8')
      if (restored !== 'v0') lost += 1
    } finally {
      await fx.cleanup()
    }
  }
  note('same-path race 20x8', elapsed(started), `${String(lost)} lost the original`)
  assert.equal(lost, 0)
})

test('a 32 MiB file is captured and restored', async () => {
  const bytes = 32 * 1024 * 1024
  const fx = await fixture({
    maxFileBytes: bytes,
    maxStorageBytes: 128 * 1024 * 1024,
    maxSessionBytes: 128 * 1024 * 1024,
  })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const before = Buffer.alloc(bytes, 3)
    const after = Buffer.alloc(bytes, 4)
    const started = performance.now()
    await changeFile(fx.engine, fx.workspace, sessionId, 'huge', 'huge.bin', before, after)
    const captureMs = elapsed(started)
    const previewStarted = performance.now()
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    const previewMs = elapsed(previewStarted)
    const restoreStarted = performance.now()
    const restored = await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    const restoreMs = elapsed(restoreStarted)
    const got = await readFile(join(fx.workspace, 'huge.bin'))
    note('32 MiB capture', captureMs, `preview ${previewMs.toFixed(1)} ms ${preview.files.map(file => `${file.state}/${file.action}`).join(',') || 'none'}`)
    note('32 MiB restore', restoreMs, `restored ${String(restored.restored.length)} skipped ${String(restored.skipped.length)} bytes ${String(got.length)}`)
    assert.ok(captureMs < 30_000)
    assert.ok(previewMs < 15_000)
    assert.ok(restoreMs < 30_000)
    assert.equal(restored.restored.length, 1)
    assert.equal(got.compare(before), 0)
  } finally {
    await fx.cleanup()
  }
})

test('a thousand files are captured, previewed, and restored', async () => {
  const count = 1000
  const fx = await fixture({ maxPreviewFiles: 20 })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    const started = performance.now()
    for (let index = 0; index < count; index += 1) {
      const name = `many/file-${String(index).padStart(4, '0')}.txt`
      await changeFile(
        fx.engine, fx.workspace, sessionId, `m${String(index)}`, name,
        `before-${String(index)}`, `after-${String(index)}`,
      )
    }
    const captureMs = elapsed(started)
    const previewStarted = performance.now()
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    const previewMs = elapsed(previewStarted)
    assert.equal(preview.totalFiles, count)
    assert.equal(preview.files.length, 20)
    assert.equal(preview.hiddenCount, count - 20)
    const restoreStarted = performance.now()
    const restored = await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    const restoreMs = elapsed(restoreStarted)
    note('1000-file capture', captureMs)
    note('1000-file preview', previewMs, `page ${String(preview.files.length)} hidden ${String(preview.hiddenCount)}`)
    note('1000-file restore', restoreMs, `restored ${String(restored.restored.length)} skipped ${String(restored.skipped.length)}`)
    assert.ok(captureMs < 60_000)
    assert.ok(previewMs < 30_000)
    assert.ok(restoreMs < 60_000)
    assert.equal(restored.restored.length, count)
    assert.equal(await readFile(join(fx.workspace, 'many', 'file-0000.txt'), 'utf8'), 'before-0')
    assert.equal(await readFile(join(fx.workspace, 'many', 'file-0999.txt'), 'utf8'), 'before-999')
  } finally {
    await fx.cleanup()
  }
})

test.after(() => {
  console.log(JSON.stringify(report, null, 2))
})
