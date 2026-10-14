import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceOf } from '../lib/host.js'

test('readSession cwd is on the header, not under header.cwd', () => {
  const ctx = { agents: { list: () => [] } }
  assert.equal(workspaceOf(ctx, 's', { id: 's', cwd: 'G:/work' }), 'G:/work')
  assert.equal(workspaceOf(ctx, 's', { id: 's', header: { cwd: 'G:/nested' } }), 'G:/nested')
  assert.equal(workspaceOf(ctx, 's', { id: 's' }), undefined)
})

test('a live agent supplies cwd when the stored header has none', () => {
  const ctx = {
    agents: {
      list: () => [{ status: 'idle', session: { id: 's', header: { cwd: 'G:/live' } } }],
    },
  }
  assert.equal(workspaceOf(ctx, 's', { id: 's' }), 'G:/live')
})
