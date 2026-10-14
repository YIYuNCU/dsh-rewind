import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTool, isGeneratedPath, matchesGlob } from '../lib/capture.js'
import { RewindEngine } from '../lib/engine.js'
import { RewindError } from '../lib/errors.js'
import { retainGlobal, retainTurns } from '../lib/ledger.js'

function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function fixture(config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-'))
  const workspace = join(root, 'work')
  const storageDir = join(root, 'state')
  await writeFile(join(root, '.keep'), '')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  const engine = new RewindEngine({ storageDir, ...config })
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

async function openTurn(engine, workspace, turn = 1, sessionId = 'session-1') {
  await engine.beginTurn({ sessionId, workspace, turn, turnStartSeq: turn * 10 })
  await engine.noteUserMessage(sessionId, turn, turn * 10 + 1)
  return sessionId
}

async function changeFile(engine, workspace, sessionId, callId, path, before, after, tool = 'write') {
  const absolute = join(workspace, path)
  if (before !== undefined) await writeFile(absolute, before)
  const args = tool === 'edit'
    ? { file_path: path, old_string: 'old', new_string: 'new' }
    : { file_path: path, content: after }
  await engine.captureBefore({ sessionId, subagent: false, callId, toolName: tool, args })
  await writeFile(absolute, after)
  await engine.captureAfter({ sessionId, subagent: false, callId, toolName: tool, ok: true })
}

test('classifies built-in file tools, extra tools, and shells', () => {
  const config = { shellTools: ['bash', 'run_code'], extraFileTools: ['save'], pathFields: ['target'] }
  assert.deepEqual(classifyTool('write', { file_path: 'a.txt', content: 'x' }, config), { kind: 'file', path: 'a.txt' })
  assert.deepEqual(classifyTool('edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, config), { kind: 'file', path: 'a.txt' })
  assert.deepEqual(classifyTool('str_replace_editor', { command: 'insert', path: 'a.txt' }, config), { kind: 'file', path: 'a.txt' })
  assert.equal(classifyTool('str_replace_editor', { command: 'view', path: 'a.txt' }, config).kind, 'ignore')
  assert.equal(classifyTool('bash', { command: 'rm -rf .' }, config).kind, 'shell')
  assert.deepEqual(classifyTool('save', { target: 'note.txt' }, config), { kind: 'file', path: 'note.txt' })
  assert.equal(matchesGlob('secret/a.txt', ['secret/**']), true)
  assert.equal(matchesGlob('notes/a.txt', ['secret/**']), false)
  assert.equal(isGeneratedPath('node_modules/pkg/index.js'), true)
  assert.equal(isGeneratedPath('src/.git/config'), true)
  assert.equal(isGeneratedPath('src/distribute/app.js'), false)
})

test('restores the first before-image and keeps it across a second edit', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'a.txt', 'old', 'mid', 'edit')
    await changeFile(fx.engine, fx.workspace, sessionId, 'c2', 'a.txt', undefined, 'new', 'edit')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files[0]?.before, sha('old'))
    assert.equal(preview.files[0]?.current, sha('new'))
    assert.equal(preview.files[0]?.state, 'clean')
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'old')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('a failed tool does not become a checkpoint', async () => {
  const fx = await fixture()
  try {
    const path = join(fx.workspace, 'a.txt')
    await writeFile(path, 'old')
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await fx.engine.captureBefore({
      sessionId, subagent: false, callId: 'c1', toolName: 'edit',
      args: { file_path: 'a.txt', old_string: 'old', new_string: 'new' },
    })
    await fx.engine.captureAfter({ sessionId, subagent: false, callId: 'c1', toolName: 'edit', ok: false })
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.totalFiles, 0)
    assert.equal(await readFile(path, 'utf8'), 'old')
  } finally {
    await fx.cleanup()
  }
})

test('shell marks a gap and file bytes are still restored', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'a.txt', 'old', 'new', 'edit')
    await fx.engine.captureBefore({ sessionId, subagent: false, callId: 'sh', toolName: 'bash', args: { command: 'echo hi' } })
    await fx.engine.captureAfter({ sessionId, subagent: false, callId: 'sh', toolName: 'bash', ok: true })
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.shellGap, true)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'old')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('conflicts are skipped unless selected, and a stale fingerprint is rejected', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'a.txt', 'old', 'new', 'edit')
    await writeFile(join(fx.workspace, 'a.txt'), 'manual')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files[0]?.state, 'conflict')
    const skipped = await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.deepEqual(skipped.skipped, ['a.txt'])
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'manual')
    await writeFile(join(fx.workspace, 'a.txt'), 'other')
    await assert.rejects(
      fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint }),
      (error) => error instanceof RewindError && error.code === 'STALE',
    )
    await writeFile(join(fx.workspace, 'a.txt'), 'manual')
    const again = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    await fx.engine.apply({
      sessionId, workspace: fx.workspace, turn: 1, fingerprint: again.fingerprint, includeConflicts: ['a.txt'],
    })
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'old')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('overwrite policy restores a conflict without a checklist', async () => {
  const fx = await fixture({ conflictPolicy: 'overwrite' })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'a.txt', 'old', 'new', 'edit')
    await writeFile(join(fx.workspace, 'a.txt'), 'manual')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'old')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('created files are deleted only when that setting is on', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'made.txt', undefined, 'fresh')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files[0]?.action, 'delete')
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await assert.rejects(readFile(join(fx.workspace, 'made.txt')))
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
  const kept = await fixture({ restoreCreatedFiles: false })
  try {
    const sessionId = await openTurn(kept.engine, kept.workspace)
    await changeFile(kept.engine, kept.workspace, sessionId, 'c1', 'made.txt', undefined, 'fresh')
    const preview = await kept.engine.preview({ sessionId, workspace: kept.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files[0]?.state, 'gap')
    await kept.engine.apply({ sessionId, workspace: kept.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(kept.workspace, 'made.txt'), 'utf8'), 'fresh')
  } finally {
    await kept.cleanup()
  }
})

test('excluded, oversized, and escaped paths are not restored', async () => {
  const fx = await fixture({ excludeGlobs: 'skip/**', maxFileBytes: 4 })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(fx.workspace, 'skip'))
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'skip/a.txt', 'old', 'new', 'edit')
    await writeFile(join(fx.workspace, 'big.txt'), '0123456789')
    await fx.engine.captureBefore({
      sessionId, subagent: false, callId: 'big', toolName: 'edit',
      args: { file_path: 'big.txt', old_string: '0', new_string: '1' },
    })
    await fx.engine.captureAfter({ sessionId, subagent: false, callId: 'big', toolName: 'edit', ok: true })
    const outside = join(fx.root, 'secret.txt')
    await writeFile(outside, 'secret')
    await fx.engine.captureBefore({
      sessionId, subagent: false, callId: 'out', toolName: 'edit',
      args: { file_path: '../secret.txt', old_string: 'secret', new_string: 'nope' },
    })
    await fx.engine.captureAfter({ sessionId, subagent: false, callId: 'out', toolName: 'edit', ok: true })
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.path === 'skip/a.txt' && file.state !== 'gap'), false)
    assert.equal(preview.files.some(file => file.reason === 'too-large'), true)
    assert.equal(preview.files.some(file => file.reason === 'outside'), true)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.equal(await readFile(outside, 'utf8'), 'secret')
    assert.equal(await readFile(join(fx.workspace, 'big.txt'), 'utf8'), '0123456789')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('a symlink parent is not a restorable path', async (t) => {
  const fx = await fixture()
  try {
    const realDir = join(fx.root, 'real')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(realDir)
    await writeFile(join(realDir, 'a.txt'), 'secret')
    try {
      await symlink(realDir, join(fx.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return t.skip('this environment cannot create a directory link')
    }
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await fx.engine.captureBefore({
      sessionId, subagent: false, callId: 'c1', toolName: 'edit',
      args: { file_path: 'link/a.txt', old_string: 'secret', new_string: 'changed' },
    })
    await fx.engine.captureAfter({ sessionId, subagent: false, callId: 'c1', toolName: 'edit', ok: true })
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.reason === 'symlink'), true)
    assert.equal(await readFile(join(realDir, 'a.txt'), 'utf8'), 'secret')
  } finally {
    await fx.cleanup()
  }
})

test('a hard link is a gap', async (t) => {
  const fx = await fixture()
  try {
    const source = join(fx.workspace, 'source.txt')
    const alias = join(fx.workspace, 'alias.txt')
    await writeFile(source, 'same')
    try {
      await link(source, alias)
    } catch {
      return t.skip('this environment cannot create a hard link')
    }
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await fx.engine.captureBefore({
      sessionId, subagent: false, callId: 'c1', toolName: 'edit',
      args: { file_path: 'alias.txt', old_string: 'same', new_string: 'other' },
    })
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.reason === 'hardlink'), true)
  } finally {
    await fx.cleanup()
  }
})

test('retention keeps the newest checkpoint and the hidden preview rows still restore', async () => {
  const fx = await fixture({ maxCheckpointsPerSession: 1, maxPreviewFiles: 1 })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'old.txt', 'a', 'b', 'edit')
    await openTurn(fx.engine, fx.workspace, 2, sessionId)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c2', 'one.txt', '1', '2', 'edit')
    await changeFile(fx.engine, fx.workspace, sessionId, 'c3', 'two.txt', '3', '4', 'edit')
    const usage = await fx.engine.usage()
    assert.equal(usage[0]?.checkpoints, 1)
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 2, userMessageSeq: 21 })
    assert.equal(preview.files.length, 1)
    assert.equal(preview.totalFiles, 2)
    assert.equal(preview.hiddenCount, 1)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 2, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(fx.workspace, 'one.txt'), 'utf8'), '1')
    assert.equal(await readFile(join(fx.workspace, 'two.txt'), 'utf8'), '3')
    await fx.engine.commit(fx.workspace)
  } finally {
    await fx.cleanup()
  }
})

test('an interrupted restore is rolled back on the next startup', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'a.txt', 'old', 'new', 'edit')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'old')
    const restarted = new RewindEngine({ storageDir: fx.storageDir })
    const recovered = await restarted.initialize()
    assert.equal(recovered, 1)
    assert.equal(await readFile(join(fx.workspace, 'a.txt'), 'utf8'), 'new')
  } finally {
    await fx.cleanup()
  }
})

test('subagent edits attach to the parent turn and a disabled engine records nothing', async () => {
  const fx = await fixture()
  try {
    await openTurn(fx.engine, fx.workspace, 1, 'parent')
    await writeFile(join(fx.workspace, 'a.txt'), 'old')
    await fx.engine.captureBefore({
      sessionId: 'child', parentSessionId: 'parent', subagent: true, callId: 'c1', toolName: 'edit',
      args: { file_path: 'a.txt', old_string: 'old', new_string: 'new' },
    })
    await writeFile(join(fx.workspace, 'a.txt'), 'new')
    await fx.engine.captureAfter({
      sessionId: 'child', parentSessionId: 'parent', subagent: true, callId: 'c1', toolName: 'edit', ok: true,
    })
    const preview = await fx.engine.preview({ sessionId: 'parent', workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.totalFiles, 1)
    fx.engine.updateConfig({ storageDir: fx.storageDir, enabled: false })
    await writeFile(join(fx.workspace, 'b.txt'), 'old')
    await fx.engine.captureBefore({
      sessionId: 'parent', subagent: false, callId: 'c2', toolName: 'edit',
      args: { file_path: 'b.txt', old_string: 'old', new_string: 'new' },
    })
    const after = await fx.engine.preview({ sessionId: 'parent', workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(after.files.some(file => file.path === 'b.txt'), false)
  } finally {
    await fx.cleanup()
  }
})

test('manual and script edits between turns restore with the earlier turn', async () => {
  const fx = await fixture()
  try {
    await mkdir(join(fx.workspace, 'node_modules'), { recursive: true })
    await writeFile(join(fx.workspace, 'hand.txt'), 'v0')
    await writeFile(join(fx.workspace, 'tool.txt'), 'v0')
    await writeFile(join(fx.workspace, 'node_modules', 'dep.txt'), 'pkg')
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'tool.txt', 'v0', 'v1', 'edit')
    await writeFile(join(fx.workspace, 'hand.txt'), 'by-hand')
    await writeFile(join(fx.workspace, 'script.txt'), 'by-script')
    await writeFile(join(fx.workspace, 'node_modules', 'dep.txt'), 'changed')
    await openTurn(fx.engine, fx.workspace, 2, sessionId)
    const later = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 2, userMessageSeq: 21 })
    assert.equal(later.files.some(file => file.path === 'hand.txt' || file.path === 'script.txt'), false)
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    const hand = preview.files.find(file => file.path === 'hand.txt')
    const script = preview.files.find(file => file.path === 'script.txt')
    assert.equal(hand?.state, 'clean')
    assert.equal(hand?.action, 'restore')
    assert.equal(script?.action, 'delete')
    assert.equal(preview.files.some(file => file.path.includes('node_modules')), false)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    assert.equal(await readFile(join(fx.workspace, 'hand.txt'), 'utf8'), 'v0')
    assert.equal(await readFile(join(fx.workspace, 'tool.txt'), 'utf8'), 'v0')
    await assert.rejects(readFile(join(fx.workspace, 'script.txt')))
    assert.equal(await readFile(join(fx.workspace, 'node_modules', 'dep.txt'), 'utf8'), 'changed')
  } finally {
    await fx.cleanup()
  }
})

test('external capture can be turned off', async () => {
  const fx = await fixture({ captureExternal: false })
  try {
    await writeFile(join(fx.workspace, 'hand.txt'), 'v0')
    const sessionId = await openTurn(fx.engine, fx.workspace, 1)
    await writeFile(join(fx.workspace, 'hand.txt'), 'by-hand')
    await writeFile(join(fx.workspace, 'script.txt'), 'by-script')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.totalFiles, 0)
    await fx.engine.apply({ sessionId, workspace: fx.workspace, turn: 1, fingerprint: preview.fingerprint })
    await fx.engine.commit(fx.workspace)
    assert.equal(await readFile(join(fx.workspace, 'hand.txt'), 'utf8'), 'by-hand')
    assert.equal(await readFile(join(fx.workspace, 'script.txt'), 'utf8'), 'by-script')
  } finally {
    await fx.cleanup()
  }
})

test('retainTurns applies age, count, and byte limits', () => {
  const now = 1_700_000_000_000
  const records = [1, 2, 3].map(turn => ({
    version: 1,
    sessionId: 's',
    workspace: 'w',
    turn,
    turnStartSeq: turn,
    userMessageSeq: turn,
    createdAt: turn === 1 ? now - 3 * 24 * 60 * 60 * 1000 : now,
    updatedAt: now,
    shellGap: false,
    files: { [`${String(turn)}.txt`]: { before: `h${String(turn)}`, after: null, mode: 0o644, beforeBytes: 10, afterSize: 0, afterMtimeMs: 0 } },
    gaps: [],
  }))
  const aged = retainTurns(records, { retentionDays: 1, maxCheckpointsPerSession: 10, maxSessionBytes: 1_000 }, now)
  assert.deepEqual(aged.map(record => record.turn), [2, 3])
  const counted = retainTurns(records, { retentionDays: 0, maxCheckpointsPerSession: 1, maxSessionBytes: 1_000 }, now)
  assert.deepEqual(counted.map(record => record.turn), [3])
  const sized = retainTurns(records, { retentionDays: 0, maxCheckpointsPerSession: 10, maxSessionBytes: 15 }, now)
  assert.deepEqual(sized.map(record => record.turn), [3])
})

test('skipGenerated leaves generated directories unrecorded', async () => {
  const fx = await fixture()
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(fx.workspace, 'node_modules'))
    await mkdir(join(fx.workspace, 'src'))
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'node_modules/pkg.js', undefined, 'pkg')
    await changeFile(fx.engine, fx.workspace, sessionId, 'c2', 'src/app.js', undefined, 'app')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.path.includes('node_modules')), false)
    assert.equal(preview.files.some(file => file.path === 'src/app.js'), true)
  } finally {
    await fx.cleanup()
  }
})

test('skipGenerated can be turned off', async () => {
  const fx = await fixture({ skipGenerated: false })
  try {
    const sessionId = await openTurn(fx.engine, fx.workspace)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(fx.workspace, 'dist'))
    await changeFile(fx.engine, fx.workspace, sessionId, 'c1', 'dist/out.js', undefined, 'out')
    const preview = await fx.engine.preview({ sessionId, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.path === 'dist/out.js'), true)
  } finally {
    await fx.cleanup()
  }
})

function storedTurn(sessionId, turn, bytes) {
  return {
    version: 1,
    sessionId,
    workspace: 'w',
    turn,
    turnStartSeq: turn,
    userMessageSeq: turn,
    createdAt: turn,
    updatedAt: turn,
    shellGap: false,
    files: {
      [`${sessionId}-${String(turn)}.txt`]: {
        before: `${sessionId}-${String(turn)}`,
        after: null,
        mode: 0o644,
        beforeBytes: bytes,
        afterSize: 0,
        afterMtimeMs: 0,
      },
    },
    gaps: [],
  }
}

test('retainGlobal keeps the newest turns across sessions', () => {
  const sessions = [
    { sessionId: 'a', turns: [storedTurn('a', 1, 10), storedTurn('a', 2, 10)] },
    { sessionId: 'b', turns: [storedTurn('b', 3, 10)] },
  ]
  const counted = retainGlobal(sessions, { maxStoredTurns: 2, maxStorageBytes: 1_000 })
  assert.deepEqual(counted.find(session => session.sessionId === 'a')?.turns.map(record => record.turn), [2])
  assert.deepEqual(counted.find(session => session.sessionId === 'b')?.turns.map(record => record.turn), [3])
  const sized = retainGlobal(sessions, { maxStoredTurns: 10, maxStorageBytes: 15 })
  assert.deepEqual(sized.flatMap(session => session.turns).map(record => record.turn), [3])
})

test('a global turn cap drops the older session', async () => {
  const fx = await fixture({ maxStoredTurns: 1 })
  try {
    const older = await openTurn(fx.engine, fx.workspace, 1, 'session-a')
    await changeFile(fx.engine, fx.workspace, older, 'c1', 'a.txt', undefined, 'a')
    const newer = await openTurn(fx.engine, fx.workspace, 1, 'session-b')
    await changeFile(fx.engine, fx.workspace, newer, 'c2', 'b.txt', undefined, 'b')
    const usage = await fx.engine.usage()
    assert.deepEqual(usage.map(row => row.sessionId), ['session-b'])
    const preview = await fx.engine.preview({ sessionId: newer, workspace: fx.workspace, turn: 1, userMessageSeq: 11 })
    assert.equal(preview.files.some(file => file.path === 'b.txt'), true)
  } finally {
    await fx.cleanup()
  }
})
