import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { streamActivity } from '../src/main/activity'
import { configure, listSessions, loadSession } from '../src/main/debate'
import { initial, reducer, type State } from '../src/renderer/src/state'
import type { Brief, Session } from '../src/shared/types'

const brief: Brief = {
  task: 'A question',
  members: [{ id: 'a', cli: 'claude', persona: 'strategist' }],
  chairId: 'a',
  maxTurns: 20
}
const started = (): State =>
  reducer(reducer(initial, { type: 'convene', brief, sessionId: 's' }), {
    type: 'turn-start',
    sessionId: 's',
    memberId: 'a',
    turn: 1,
    phase: 'open'
  })

test('tool and reasoning metadata become coarse states, never raw content', () => {
  assert.equal(
    streamActivity('claude', {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', name: 'Read', input: { file: 'private.txt' } }
      }
    }),
    'reading'
  )
  assert.equal(
    streamActivity('claude', {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Private reasoning' }
      }
    }),
    'thinking'
  )
  assert.equal(
    streamActivity('claude', {
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'private file' }] }
    }),
    'reviewing'
  )
  assert.equal(
    streamActivity('codex', {
      type: 'item.started',
      item: { type: 'command_execution', command: 'private command' }
    }),
    'tool'
  )
  assert.equal(
    streamActivity('codex', { type: 'item.completed', item: { type: 'command_execution' } }),
    'reviewing'
  )
  assert.equal(
    streamActivity('codex', {
      type: 'item.updated',
      item: { type: 'reasoning', text: 'private reasoning' }
    }),
    'thinking'
  )
  assert.equal(
    streamActivity('gemini', {
      type: 'tool_use',
      tool_name: 'grep_search',
      parameters: { query: 'private query' }
    }),
    'searching'
  )
  assert.equal(
    streamActivity('gemini', { type: 'tool_result', output: 'private output' }),
    'reviewing'
  )
  assert.equal(streamActivity('grok', { type: 'text', data: 'hello' }), 'responding')
  assert.equal(streamActivity('grok', { type: 'tool_call', name: 'unknown-tool-secret' }), 'tool')
  assert.equal(streamActivity('claude', { type: 'unknown', thinking: 'foo' }), undefined)
  assert.equal(streamActivity('gemini', null), undefined)
})

test('activity is scoped to the active turn and cleared when the turn finishes', () => {
  let s = started()
  assert.equal(s.activity?.kind, 'starting')
  for (const e of [
    { sessionId: 'other', memberId: 'a', turn: 1 },
    { sessionId: 's', memberId: 'b', turn: 1 },
    { sessionId: 's', memberId: 'a', turn: 0 }
  ])
    assert.equal(reducer(s, { ...e, type: 'activity', kind: 'reading' }), s)
  s = reducer(s, { type: 'activity', sessionId: 's', memberId: 'a', turn: 1, kind: 'reading' })
  assert.equal(s.activity?.kind, 'reading')
  s = reducer(s, { type: 'delta', sessionId: 's', memberId: 'a', turn: 1, text: 'My answer' })
  assert.equal(s.activity?.kind, 'responding')
  assert.equal(s.turns[0].text, 'My answer')
  s = reducer(s, {
    type: 'turn-done',
    sessionId: 's',
    turn: { n: 1, speaker: 'a', label: 'Strategist', text: 'My answer', vote: null }
  })
  assert.equal(s.activity, undefined)
  assert.equal(
    reducer(s, { type: 'activity', sessionId: 's', memberId: 'a', turn: 1, kind: 'reading' }),
    s
  )
})

test('chair activity is separate; stops and failures clear waiting indicators', () => {
  const s = reducer(started(), { type: 'chair-start', sessionId: 's', memberId: 'a' })
  assert.equal(s.activity?.turn, 0)
  assert.equal(
    reducer(s, { type: 'delta', sessionId: 's', memberId: 'a', turn: 1, text: 'late' }),
    s
  )
  const writing = reducer(s, {
    type: 'delta',
    sessionId: 's',
    memberId: 'a',
    turn: 0,
    text: 'Decision'
  })
  assert.equal(writing.chair.text, 'Decision')
  assert.equal(writing.activity?.kind, 'responding')
  assert.equal(reducer(writing, { type: 'stopped', sessionId: 's' }).activity, undefined)
  assert.equal(
    reducer(writing, { type: 'failed', sessionId: 's', message: 'failed' }).activity,
    undefined
  )
})

test('saved running sessions without a live engine cannot appear live after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-interrupted-test-'))
  try {
    configure(root)
    const session: Session = {
      version: 2,
      id: 'interrupted',
      createdAt: new Date().toISOString(),
      brief,
      labels: { a: 'Strategist' },
      turns: [],
      shape: null,
      converged: false,
      status: 'running'
    }
    const path = join(root, 'sessions', 'interrupted.json')
    await writeFile(path, JSON.stringify(session))
    assert.equal(listSessions()[0].status, 'stopped')
    const restored = loadSession('interrupted')!
    assert.equal(restored.status, 'stopped')
    assert.equal(reducer(initial, { type: 'open', session: restored }).stage, 'stopped')
    assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'running')
    await writeFile(path, JSON.stringify({ ...session, status: 'done' }))
    assert.equal(loadSession('interrupted')!.status, 'done')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
