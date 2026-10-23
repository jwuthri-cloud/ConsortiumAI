import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { configure, runDebate, host, raiseHand, conclude, stop } from '../src/main/debate'
import { track, type runMember } from '../src/main/cli'
import type { Brief, DebateEvent } from '../src/shared/types'
import { initial, reducer } from '../src/renderer/src/state'

const until = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(5)
  assert.ok(predicate(), 'Condition did not settle')
}

test('a raised hand stops the seat preparing its turn; it goes again after the human', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-hand-test-'))
  const brief: Brief = {
    task: 'Export?',
    maxTurns: 10,
    chairId: 'a',
    members: [
      { id: 'a', cli: 'claude', persona: 'strategist' },
      { id: 'b', cli: 'codex', persona: 'engineer' }
    ]
  }
  type Call = { key: string; prompt: string; resolve: (t: string) => void }
  const calls: Call[] = []
  const events: DebateEvent[] = []
  // a member run the engine can kill, like a CLI process
  const runner: typeof runMember = (_cli, args, _delta, key) => {
    if (key.endsWith(':whiteboard')) return new Promise(() => {})
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController()
      const untrack = track(key, ctrl)
      ctrl.signal.addEventListener('abort', () => reject(new Error('killed')))
      calls.push({
        key,
        prompt: args.prompt,
        resolve: (text) => {
          untrack()
          resolve({ text })
        }
      })
    })
  }
  try {
    configure(root)
    runDebate(brief, (e) => events.push(e), 'hand-test', undefined, runner)
    await until(() => calls.length === 1)
    calls[0].resolve('Ship it small.')
    await until(() => calls.length === 2)
    assert.equal(calls[1].key, 'hand-test:b')

    raiseHand('hand-test', true) // b is preparing turn 2
    await until(() => events.some((e) => e.type === 'turn-cancelled'))
    const cancelled = events.find((e) => e.type === 'turn-cancelled')!
    assert.deepEqual(
      { ...cancelled, sessionId: undefined },
      {
        sessionId: undefined,
        type: 'turn-cancelled',
        memberId: 'b',
        turn: 2
      }
    )
    assert.ok(!events.some((e) => e.type === 'turn-error'), 'a raised hand is not an error')
    await sleep(30)
    assert.equal(calls.length, 2, 'the meeting holds while the hand is up')

    host('hand-test', { id: 'h1', kind: 'thought', text: 'Budget is capped at two weeks.' })
    raiseHand('hand-test', false)
    await until(() => calls.length === 3)
    assert.equal(calls[2].key, 'hand-test:b', 'the interrupted seat goes again')
    assert.match(calls[2].prompt, /Budget is capped at two weeks/)
    const starts = events.filter((e) => e.type === 'turn-start').map((e) => e.turn)
    assert.deepEqual(starts, [1, 2, 2], 'same turn number, retaken')

    // the room's state drops the cut-off turn instead of showing it as failed
    let s = reducer(initial, { type: 'convene', brief, sessionId: 'hand-test' })
    for (const e of events) s = reducer(s, e)
    assert.equal(s.turns.filter((t) => t.speaker === 'b').length, 1)
    assert.ok(s.turns.every((t) => t.status !== 'error'))

    calls[2].resolve('Two weeks fits a CSV export.')
    conclude('hand-test')
    await until(() => calls.length === 4)
    assert.equal(calls[3].key, 'hand-test:chair')
  } finally {
    stop('hand-test')
    await rm(root, { recursive: true, force: true })
  }
})
