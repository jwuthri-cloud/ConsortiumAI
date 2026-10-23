import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { configure, runDebate, host, conclude, stop, loadSession, pause } from '../src/main/debate'
import type { runMember } from '../src/main/cli'
import type { Brief, DebateEvent } from '../src/shared/types'
import { initial, reducer } from '../src/renderer/src/state'

const until = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(5)
  assert.ok(predicate(), 'Condition did not settle')
}
const brief: Brief = {
  task: 'Choose an export plan',
  maxTurns: 10,
  chairId: 'a',
  members: [
    { id: 'a', cli: 'claude', persona: 'strategist' },
    { id: 'b', cli: 'codex', persona: 'engineer' }
  ]
}

test('human input preempts slow providers, discards late output, reaches targeted seat, and interrupts the chair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-priority-'))
  const events: DebateEvent[] = []
  type Result = Awaited<ReturnType<typeof runMember>>
  const calls: {
    key: string
    prompt: string
    delta: (text: string) => void
    resolve: (value: Result) => void
  }[] = []
  const runner: typeof runMember = (_cli, args, delta, key) => {
    if (key.endsWith(':whiteboard')) return new Promise(() => {})
    return new Promise((resolve) => calls.push({ key, prompt: args.prompt, delta, resolve }))
  }
  try {
    configure(root)
    runDebate(brief, (e) => events.push(structuredClone(e)), 'priority', undefined, runner)
    await until(() => calls.length === 1)
    calls[0].delta('An unfinished old argument')
    host('priority', {
      id: 'answer',
      kind: 'ask',
      targetId: 'b',
      text: 'We have only two days.',
      boardNote: { id: 'budget', revision: 3, text: 'How much time is available?' }
    })
    assert.equal(loadSession('priority')!.turns.at(-1)?.text.includes('two days'), true)
    await until(() => calls.length === 2) // old provider has STILL not returned
    assert.equal(calls[1].key, 'priority:b')
    assert.match(calls[1].prompt, /How much time is available/)
    assert.match(calls[1].prompt, /two days/)
    calls[0].delta('LATE STALE OUTPUT')
    calls[0].resolve({ text: 'STALE ANSWER', sessionId: 'stale-session' })
    await sleep(10)
    assert.ok(!JSON.stringify(events).includes('LATE STALE OUTPUT'))
    assert.ok(!loadSession('priority')!.turns.some((t) => t.text === 'STALE ANSWER'))
    host('priority', { id: 'answer', kind: 'ask', targetId: 'b', text: 'Duplicate ignored' })
    assert.equal(events.filter((e) => e.type === 'human').length, 1)
    calls[1].resolve({ text: 'Two days means CSV only.' })
    await until(() => calls.length === 3)
    pause('priority', true)
    host('priority', { id: 'focus', kind: 'focus', text: 'Accessibility is required.' })
    await until(() => calls.length === 4)
    assert.match(calls[3].prompt, /host's current focus: Accessibility is required/)
    conclude('priority')
    calls[3].resolve({ text: 'Use accessible controls.' })
    await until(() => calls.length === 5)
    assert.equal(calls[4].key, 'priority:chair')
    calls[4].delta('Old decision draft')
    host('priority', { id: 'chair-correction', kind: 'thought', text: 'The deadline is tomorrow.' })
    await until(() => calls.length === 6)
    assert.equal(calls[5].key, 'priority:chair')
    assert.match(calls[5].prompt, /deadline is tomorrow/)
    calls[4].resolve({ text: '# Stale decision' })
    calls[5].resolve({ text: '# Decision\nDeliver tomorrow.' })
    await until(() => events.some((e) => e.type === 'consortium'))
    const saved = loadSession('priority')!
    assert.match(saved.consortium!.markdown, /Deliver tomorrow/)
    assert.doesNotMatch(saved.consortium!.markdown, /Stale decision/)
    assert.equal(saved.hostMessages?.length, 3)
    assert.ok(saved.hostMessages?.every((m) => m.status === 'delivered'))
    let state = reducer(initial, { type: 'convene', brief, sessionId: 'priority' })
    for (const event of events) state = reducer(state, event)
    assert.ok(!state.turns.some((t) => t.status === 'running' || t.text.includes('unfinished')))
    assert.match(state.chair.text, /Deliver tomorrow/)
  } finally {
    stop('priority')
    await sleep(10)
    await rm(root, { recursive: true, force: true })
  }
})

test('human takeover releases audio waits and drops stale synthesized speech', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-audio-priority-'))
  const events: DebateEvent[] = []
  const calls: { prompt: string; resolve: (value: { text: string }) => void }[] = []
  const audio: { chunk: (pcm: Buffer, last: boolean) => void; resolve: (bytes: number) => void }[] =
    []
  const runner: typeof runMember = (_cli, args, _delta, key) => {
    if (key.endsWith(':whiteboard')) return new Promise(() => {})
    return new Promise((resolve) => calls.push({ prompt: args.prompt, resolve }))
  }
  try {
    configure(root)
    runDebate(
      { ...brief, voices: true, members: brief.members.map((m) => ({ ...m, voice: 'sarah' })) },
      (e) => events.push(structuredClone(e)),
      'audio-priority',
      undefined,
      runner,
      {
        enabled: () => true,
        filler: () => undefined,
        readAloud: (_voice, _text, _key, chunk) =>
          new Promise((resolve) => audio.push({ chunk, resolve }))
      }
    )
    await until(() => calls.length === 1)
    calls[0].resolve({ text: 'First spoken answer.' })
    await until(() => audio.length === 1 && calls.length === 2)
    audio[0].chunk(Buffer.from([1, 0]), false)
    calls[1].resolve({ text: 'Queued answer.' })
    await until(() => events.filter((e) => e.type === 'turn-done').length === 2)
    // Turn three is waiting for the first voice, which deliberately never finishes.
    assert.equal(calls.length, 2)
    host('audio-priority', {
      id: 'takeover',
      kind: 'thought',
      text: 'Stop that direction. Prioritize accessibility.'
    })
    await until(() => calls.length === 3)
    assert.match(calls[2].prompt, /Prioritize accessibility/)
    const voices = events.filter((e) => e.type === 'voice').length
    audio[0].chunk(Buffer.from([2, 0]), true)
    audio[0].resolve(2)
    await sleep(10)
    assert.equal(events.filter((e) => e.type === 'voice').length, voices, 'late audio is discarded')
    assert.equal(audio.length, 1, 'old queued synthesis never starts')
    calls[2].resolve({ text: 'Accessibility comes first.' })
    await until(() => audio.length === 2)
    audio[1].chunk(Buffer.from([3, 0]), true)
    assert.equal(events.filter((e) => e.type === 'voice').length, voices + 1)
  } finally {
    stop('audio-priority')
    await sleep(10)
    await rm(root, { recursive: true, force: true })
  }
})

test('long human instructions are preserved in member and chair prompts', async () => {
  const prompts = await import('../src/main/prompts')
  const text = 'Context. '.repeat(240) + 'FINAL CONSTRAINT: do not export personal data.'
  const turns = [{ n: 1, speaker: 'human', label: 'The Human', text, vote: null }]
  const labels = { a: 'The Strategist', b: 'The Engineer' }
  assert.match(
    prompts.opening(brief, brief.members[0], labels, turns),
    /FINAL CONSTRAINT: do not export personal data/
  )
  assert.match(
    prompts.turn(brief, brief.members[0], labels, turns, 'debate', 2, null),
    /FINAL CONSTRAINT: do not export personal data/
  )
  assert.match(
    prompts.chair(brief, labels, turns, {}, {}, ''),
    /FINAL CONSTRAINT: do not export personal data/
  )
})
