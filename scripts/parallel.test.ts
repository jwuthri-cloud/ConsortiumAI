import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, loadSession, runDebate, stop } from '../src/main/debate'
import { killMeeting, track, type runMember } from '../src/main/cli'
import type { Brief, DebateEvent } from '../src/shared/types'

// Two meetings at once with the CLIs faked: each member's turn waits until the test releases it.
const VOTE =
  '```json\n{"position":"Ship","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
const brief: Brief = {
  task: 'Ship a CSV export?',
  members: [
    { id: 'a', cli: 'claude', persona: 'strategist' },
    { id: 'b', cli: 'codex', persona: 'skeptic' }
  ],
  chairId: 'a',
  maxTurns: 4
}

test('two meetings run side by side, and stopping one leaves the other running', async () => {
  configure(await mkdtemp(join(tmpdir(), 'parallel-test-')))
  const waiting = new Map<string, () => void>() // run key → release
  const run: typeof runMember = async (_cli, _args, _delta, key) => {
    if (key.endsWith(':whiteboard')) return { text: 'not a board' }
    if (key.endsWith(':chair')) return { text: '# Decision\n\nShip it.' }
    await new Promise<void>((r) => waiting.set(key, () => (waiting.delete(key), r())))
    return { text: `Ship it.\n${VOTE}` }
  }
  const events: Record<string, DebateEvent[]> = { one: [], two: [] }
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(ok(), 'condition did not settle')
  }
  const saw = (id: string, type: string): boolean => events[id].some((e) => e.type === type)
  for (const id of ['one', 'two'])
    runDebate(brief, (e) => events[id].push(e), id, undefined, run, {
      enabled: () => false,
      filler: () => undefined,
      readAloud: async () => 0
    })
  // both opening turns are in flight at the same time: starting "two" didn't stop "one"
  await until(() => waiting.has('one:a') && waiting.has('two:a'))
  stop('one')
  await until(() => saw('one', 'stopped'))
  assert.equal(loadSession('one')?.status, 'stopped')
  assert.equal(loadSession('two')?.status, 'running')
  // "two" carries on to its decision
  const two = (): (() => void)[] =>
    [...waiting].filter(([key]) => key.startsWith('two:')).map(([, release]) => release)
  while (!saw('two', 'consortium')) {
    await until(() => two().length > 0 || saw('two', 'consortium'))
    for (const release of two()) release()
  }
  assert.equal(loadSession('two')?.status, 'done')
  assert.ok(!saw('one', 'consortium') && !saw('two', 'stopped'))
})

test("killMeeting aborts only that meeting's runs", () => {
  const one = new AbortController()
  const two = new AbortController()
  track('one:a', one)
  track('two:a', two)
  killMeeting('one')
  assert.equal(one.signal.aborted, true)
  assert.equal(two.signal.aborted, false)
  killMeeting('two')
})
