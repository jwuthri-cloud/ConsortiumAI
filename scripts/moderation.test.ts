import assert from 'node:assert/strict'
import test from 'node:test'
import { moderatedSpeaker, moderationContext } from '../src/main/moderation'
import { parseBoard, createBoardWriter, boardUpdatePrompt } from '../src/main/whiteboard'
import type { Member, Turn } from '../src/shared/types'
import { setTimeout as sleep } from 'node:timers/promises'
const members: Member[] = [
  { id: 'a', cli: 'claude', persona: 'strategist' },
  { id: 'b', cli: 'codex', persona: 'engineer' },
  { id: 'c', cli: 'gemini', persona: 'skeptic' }
]
const turns: Turn[] = members.map((m, i) => ({
  n: i + 1,
  speaker: m.id,
  label: m.id,
  text: 'Position',
  vote: null
}))
const snapshot = {
  task: 'Export',
  focus: 'Keep the scope small',
  members: members.map((m) => ({ id: m.id, label: m.id })),
  turns
}
const data = {
  recommendation: 'CSV',
  agreed: [],
  disputed: [],
  questions: [],
  actions: [],
  moderation: {
    kind: 'refocus',
    message: 'Return to export scope; compare the two concrete options.',
    nextMemberId: 'b',
    sources: [2, 999]
  }
}

test('moderator validates routing, preserves openings and fairness, and ignores stale or draft guidance', () => {
  const board = parseBoard(JSON.stringify(data), snapshot)
  assert.deepEqual(board.moderation?.sources, [2])
  assert.equal(moderatedSpeaker(members, turns, board, 0)?.id, 'b')
  assert.equal(moderatedSpeaker(members, turns.slice(0, 1), board, 0), undefined)
  assert.equal(moderatedSpeaker(members, turns, board, 1), undefined)
  assert.equal(moderatedSpeaker(members, turns, { ...board, provisional: true }, 0), undefined)
  assert.equal(moderatedSpeaker(members, [...turns, { ...turns[0], n: 20 }], board, 0), undefined)
  const invalid = parseBoard(
    JSON.stringify({ ...data, moderation: { ...data.moderation, nextMemberId: 'outsider' } }),
    snapshot
  )
  assert.equal(invalid.moderation?.nextMemberId, undefined)
  assert.match(moderationContext(board, 3), /human's latest message and focus take priority/)
  assert.match(boardUpdatePrompt(snapshot, 0), /Keep the scope small/)
  const repeating = [
    ...turns,
    ...Array.from({ length: 6 }, (_, i) => ({ ...turns[i % 2], n: i + 4 }))
  ]
  assert.equal(moderatedSpeaker(members, repeating, { ...board, throughTurn: 9 }, 0)?.id, 'c')
})

test('human interruption invalidates an in-flight board, including providers that ignore cancellation', async () => {
  const calls: ((value: string) => void)[] = []
  const published: string[] = []
  const writer = createBoardWriter({
    intervalMs: 0,
    generate: () => new Promise((resolve) => calls.push(resolve)),
    cancel: () => {},
    publish: (board) => published.push(board.recommendation),
    status: () => {}
  })
  const until = async (n: number): Promise<void> => {
    for (let i = 0; i < 100 && calls.length < n; i++) await sleep(5)
    assert.equal(calls.length, n)
  }
  try {
    writer.update(snapshot, true)
    await until(1)
    writer.invalidate()
    writer.update({ ...snapshot, focus: 'Human changed the plan' }, true)
    await until(2)
    calls[0](JSON.stringify({ ...data, recommendation: 'STALE' }))
    calls[1](JSON.stringify({ ...data, recommendation: 'Updated' }))
    await sleep(20)
    assert.deepEqual(published, ['Updated'])
  } finally {
    writer.dispose()
  }
})

test('fresh moderator guidance routes the next engine turn, while human targeting overrides it', async () => {
  const { configure, runDebate, pause, host, stop, loadSession } =
    await import('../src/main/debate')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'consortium-moderation-'))
  const calls: { key: string; prompt: string; resolve: (value: { text: string }) => void }[] = []
  const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) await sleep(5)
    assert.ok(predicate(), 'Condition did not settle')
  }
  try {
    configure(root)
    runDebate(
      { task: 'Export', members, maxTurns: 12, chairId: 'a' },
      () => {},
      'moderated',
      undefined,
      async (_cli, args, _delta, key) => {
        if (key.endsWith(':whiteboard')) return { text: JSON.stringify(data) }
        return new Promise((resolve) => calls.push({ key, prompt: args.prompt, resolve }))
      }
    )
    for (let i = 0; i < 3; i++) {
      await until(() => calls.length === i + 1)
      if (i === 2) pause('moderated', true)
      calls[i].resolve({ text: 'Opening position.' })
    }
    await until(() => loadSession('moderated')?.whiteboard?.throughTurn === 3)
    pause('moderated', false)
    await until(() => calls.length === 4)
    assert.equal(
      calls[3].key,
      'moderated:b',
      'Moderator chooses Engineer instead of normal Strategist rotation'
    )
    assert.match(calls[3].prompt, /Return to export scope/)
    host('moderated', {
      id: 'override',
      kind: 'ask',
      targetId: 'c',
      text: 'Check the evidence first.'
    })
    await until(() => calls.length === 5)
    assert.equal(calls[4].key, 'moderated:c')
    assert.match(calls[4].prompt, /Check the evidence first/)
  } finally {
    stop('moderated')
    await sleep(10)
    await rm(root, { recursive: true, force: true })
  }
})
