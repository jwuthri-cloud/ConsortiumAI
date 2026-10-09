import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseBoard, createBoardWriter, type BoardSnapshot } from '../src/main/whiteboard'
import { configure, runDebate, host, conclude, pause, loadSession } from '../src/main/debate'
import type { runMember } from '../src/main/cli'
import type { Brief, DebateEvent } from '../src/shared/types'
import type { Whiteboard } from '../src/shared/whiteboard'
import { initial, reducer } from '../src/renderer/src/state'

const snapshot: BoardSnapshot = {
  task: 'Export?',
  turns: [{ n: 1, label: 'Engineer', text: 'Try CSV.' }]
}
const json = JSON.stringify({
  recommendation: 'Evaluate CSV',
  agreed: [],
  disputed: [],
  questions: [{ id: 'scope', text: 'Which customers need it?', sources: [1, 99, 1, '1'] }],
  actions: []
})
const until = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !predicate(); i++) await sleep(5)
  assert.ok(predicate(), 'Condition did not settle')
}

test('board validation rejects malformed updates, filters fabricated citations, and increments revisions', () => {
  assert.throws(() => parseBoard('not json', snapshot))
  assert.throws(() => parseBoard('{"recommendation":"fine"}', snapshot))
  const board = parseBoard(json, snapshot)
  assert.deepEqual(board.questions[0].sources, [1])
  assert.equal(board.model, 'gpt-6.1-sol')
  assert.equal(board.throughTurn, 1)
  assert.equal(parseBoard(json, snapshot, board).revision, 2)
})

test('writer coalesces snapshots, preserves the last good board on error, and ignores results after disposal', async () => {
  const pending: { resolve: (text: string) => void; reject: (error: Error) => void }[] = []
  const prompts: string[] = []
  const boards: Whiteboard[] = []
  const statuses: string[] = []
  let cancelled = 0
  const writer = createBoardWriter({
    intervalMs: 0,
    generate: (prompt) => {
      prompts.push(prompt)
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    publish: (board) => boards.push(board),
    status: (status) => statuses.push(status),
    cancel: () => {
      cancelled++
    }
  })
  try {
    writer.update(snapshot)
    await until(() => pending.length === 1)
    writer.update({ ...snapshot, task: 'superseded snapshot' })
    writer.update({ ...snapshot, task: 'latest snapshot' })
    assert.equal(pending.length, 1)
    pending[0].resolve(json)
    await until(() => pending.length === 2)
    assert.match(prompts[1], /Question: latest snapshot/)
    assert.doesNotMatch(prompts[1], /superseded snapshot/)
    pending[1].reject(new Error('offline'))
    await until(() => statuses.includes('error'))
    assert.equal(boards.length, 1)
    writer.update(snapshot, true)
    await until(() => pending.length === 3)
    assert.match(prompts[2], /"revision":1/)
    writer.dispose()
    pending[2].resolve(json)
    await sleep(10)
    assert.equal(boards.length, 1)
    assert.equal(cancelled, 1)
  } finally {
    writer.dispose()
  }
})

test('host targeting takes the next turn; focus persists; conclude while paused delivers queued messages to the chair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-host-test-'))
  const brief: Brief = {
    task: 'Export?',
    maxTurns: 20,
    chairId: 'a',
    members: [
      { id: 'a', cli: 'claude', persona: 'strategist' },
      { id: 'b', cli: 'codex', persona: 'engineer' },
      { id: 'c', cli: 'gemini', persona: 'researcher' }
    ]
  }
  const calls: { key: string; prompt: string; resolve: (value: { text: string }) => void }[] = []
  const events: DebateEvent[] = []
  const runner: typeof runMember = async (_cli, args, _delta, key) => {
    if (key.endsWith(':whiteboard'))
      return {
        text: JSON.stringify({
          ...JSON.parse(json),
          visuals: [
            {
              id: 'proposal-flow',
              kind: 'diagram',
              title: 'Proposal flow',
              caption: 'Proposed',
              sources: [1],
              nodes: [
                {
                  id: 'request',
                  label: 'Request',
                  detail: '',
                  status: 'proposed',
                  column: 0,
                  sources: [1]
                },
                {
                  id: 'download',
                  label: 'Download',
                  detail: '',
                  status: 'proposed',
                  column: 1,
                  sources: [1]
                }
              ],
              edges: [{ from: 'request', to: 'download', label: 'Export' }]
            }
          ]
        })
      }
    return new Promise((resolve) => calls.push({ key, prompt: args.prompt, resolve }))
  }
  try {
    configure(root)
    runDebate(brief, (e) => events.push(structuredClone(e)), 'host-test', undefined, runner)
    await until(() => calls.length === 1)
    host({ id: 'ask-c', kind: 'ask', targetId: 'c', text: 'Check demand first.' })
    host({ id: 'focus', kind: 'focus', text: 'Prioritize accessibility.' })
    host({ id: 'ask-c', kind: 'ask', targetId: 'c', text: 'Duplicate request.' })
    assert.throws(() => host({ id: 'invalid', kind: 'ask', targetId: 'missing', text: '?' }))
    calls[0].resolve({ text: 'A proposal.' })
    await until(() => calls.length === 2)
    assert.equal(calls[1].key, 'host-test:c')
    assert.match(calls[1].prompt, /Check demand first/)
    assert.match(calls[1].prompt, /host's current focus: Prioritize accessibility/)
    await until(() => events.some((e) => e.type === 'whiteboard'))
    calls[1].resolve({ text: 'Demand is uncertain.' })
    await until(() => calls.length === 3)
    assert.equal(calls[2].key, 'host-test:b', 'Resume the normal rotation after a targeted turn')
    assert.match(calls[2].prompt, /host's current focus: Prioritize accessibility/)
    assert.match(calls[2].prompt, /"id":"proposal-flow"/)
    assert.match(calls[2].prompt, /"from":"request","to":"download"/)
    host({ id: 'last', kind: 'thought', text: 'The launch must stay small.' })
    pause(true)
    calls[2].resolve({ text: 'Start with a small prototype.' })
    await until(() => events.filter((e) => e.type === 'turn-done').length === 3)
    assert.equal(calls.length, 3)
    conclude()
    await until(() => calls.length === 4)
    assert.equal(calls[3].key, 'host-test:chair')
    assert.match(calls[3].prompt, /launch must stay small/)
    assert.match(calls[3].prompt, /host asked to conclude now/)
    assert.match(calls[3].prompt, /"id":"proposal-flow"/)
    assert.throws(() => host({ id: 'late', kind: 'thought', text: 'Too late.' }))
    calls[3].resolve({ text: '# Decision\nRun a small pilot.' })
    await until(() => events.some((e) => e.type === 'consortium'))
    const saved = loadSession('host-test')!
    assert.equal(saved.status, 'done')
    assert.equal(saved.whiteboard?.visuals?.[0].id, 'proposal-flow')
    assert.equal(saved.focus, 'Prioritize accessibility.')
    assert.equal(saved.hostMessages?.length, 3)
    assert.ok(saved.hostMessages?.every((m) => m.status === 'delivered'))
    assert.equal(saved.hostMessages?.find((m) => m.id === 'ask-c')?.deliveredTo, saved.labels.c)
    assert.equal(saved.hostMessages?.find((m) => m.id === 'last')?.deliveredTo, saved.labels.a)
    assert.equal(events.filter((e) => e.type === 'turn-start').length, 3)
    const state = reducer(initial, { type: 'open', session: saved })
    assert.deepEqual(state.hostMessages, saved.hostMessages)
    assert.equal(
      reducer(state, { type: 'whiteboard', sessionId: 'wrong', board: parseBoard(json, snapshot) }),
      state
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writer resumes its session with only the new turns, and starts fresh after a failure', async () => {
  const calls: { prompt: string; resume?: string }[] = []
  let fail = false
  const writer = createBoardWriter({
    intervalMs: 0,
    generate: async (prompt, resume) => {
      calls.push({ prompt, resume })
      if (fail) throw new Error('offline')
      return { text: json, sessionId: 'S' }
    },
    publish: () => {},
    status: () => {},
    cancel: () => {}
  })
  try {
    const two = {
      ...snapshot,
      turns: [...snapshot.turns, { n: 2, label: 'Skeptic', text: 'Who asked?' }]
    }
    writer.update(snapshot)
    await until(() => calls.length === 1)
    writer.update(two)
    await until(() => calls.length === 2)
    assert.equal(calls[0].resume, undefined)
    assert.match(calls[0].prompt, /Turn 1 · Engineer: Try CSV/)
    assert.equal(calls[1].resume, 'S')
    assert.match(calls[1].prompt, /Turn 2 · Skeptic: Who asked\?/)
    assert.doesNotMatch(calls[1].prompt, /Try CSV/)
    fail = true
    writer.update({ ...two, task: 'retry' })
    await until(() => calls.length === 3)
    fail = false
    writer.update(two, true)
    await until(() => calls.length === 4)
    assert.equal(calls[3].resume, undefined)
    assert.match(calls[3].prompt, /Try CSV/)
  } finally {
    writer.dispose()
  }
})
