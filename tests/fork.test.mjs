import test from 'node:test'
import assert from 'node:assert/strict'
import { planFork } from '../lib/fork.js'
import { RewindError } from '../lib/errors.js'

const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
  { type: 'turn/end', seq: 5, data: { turn: 1 } },
  { type: 'turn/start', seq: 6, data: { turn: 2 } },
  { type: 'user/message', seq: 7, data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'injected' }] } },
  { type: 'user/message', seq: 8, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] } },
  { type: 'turn/end', seq: 12, data: { turn: 2 } },
]

test('the first turn forks an empty session and later turns cut at the previous end', () => {
  const first = planFork(events, 1)
  assert.equal(first.messageSeq, 2)
  assert.equal(first.previousTurnEndSeq, undefined)
  assert.equal(first.promptText, 'first')
  const second = planFork(events, 2)
  assert.equal(second.messageSeq, 8)
  assert.equal(second.previousTurnEndSeq, 5)
  assert.equal(second.promptText, 'second')
})

test('a missing turn fails closed', () => {
  assert.throws(() => planFork(events, 9), (error) => error instanceof RewindError && error.code === 'NOT_FOUND')
})
