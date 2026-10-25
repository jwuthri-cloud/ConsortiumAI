import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from '@slack/bolt'
import {
  bridge,
  decisionBody,
  UNAVAILABLE,
  type Round,
  type Tenancy,
  type Thread
} from '../src/main/slack'
import {
  DEFAULTS,
  addRound,
  askModal,
  earlierContext,
  followTurns,
  readAsk,
  settingsBrief
} from '../src/main/hosted'
import { openStore } from '../src/main/store'
import type { runMember } from '../src/main/cli'

const round = (n: number, more: Partial<Round> = {}): Round => ({
  id: `M${n}`,
  question: `Question ${n}?`,
  state: 'decided',
  decision: `# Consortium: Answer ${n}\n## Recommendation\nDo ${n}.\n## Next actions\n1. Step ${n}`,
  board: {
    recommendation: `Do ${n}`,
    agreed: [{ id: 'a', text: `Agreed ${n}`, sources: [1] }],
    disputed: [{ id: 'd', text: `Disputed ${n}`, sources: [] }],
    questions: [],
    actions: [{ id: 'x', text: `Action ${n}`, sources: [2] }]
  },
  link: `https://slack.test/p${n}`,
  cost: '$0.12',
  at: 1000 * n,
  ended: 1000 * n + 500,
  ...more
})

test('a thread record survives a restart, and a follow-up adds to it', async () => {
  const db = `sqlite:${join(await mkdtemp(join(tmpdir(), 'follow-')), 'c.db')}`
  const where = {
    channel: 'C1',
    repo: 'acme/api',
    files: [{ id: 'F1', name: 'spec.md', url_private: 'https://files.slack.com/F1' }]
  }
  let store = await openStore(db)
  await store.put('threads', 'T1:1.5', addRound(undefined, where, round(1)))
  await store.close()
  store = await openStore(db) // the server restarted
  const had = await store.get<Thread>('threads', 'T1:1.5')
  assert.deepEqual(had, { ...where, rounds: [round(1)] })
  // a follow-up ends: added after the first; the same meeting again replaces itself
  const two = addRound(addRound(had, where, round(2)), where, round(2, { cost: '$0.20' }))
  assert.deepEqual(
    two.rounds.map((r) => [r.id, r.cost]),
    [
      ['M1', '$0.12'],
      ['M2', '$0.20']
    ]
  )
  await store.close()

  // what's kept of the chair's document: none of the engine's appendix
  const md = `# Consortium: Ship\n## Recommendation\nShip it [T1].\n\n## Sources\n- [T1] The Strategist — “Ship”\n\n---\n\n## Final votes\n- x`
  assert.equal(decisionBody(md), '# Consortium: Ship\n## Recommendation\nShip it [T1].')
  assert.equal(
    decisionBody('# A\n## Next actions\n1. Go\n\n---\n\n## Final votes\n- y'),
    '# A\n## Next actions\n1. Go'
  )
})

test("a follow-up's brief: the earlier meetings, most recent first, condensed; half the turns", () => {
  const ctx = earlierContext([
    round(1),
    round(2),
    round(3, { state: 'stopped', decision: undefined })
  ])
  assert.ok(ctx.startsWith('## Earlier in this thread\n'))
  const at = (s: string): number => ctx.indexOf(s)
  assert.ok(at('Follow-up 2: Question 3?') < at('Follow-up 1: Question 2?'))
  assert.ok(at('Follow-up 1: Question 2?') < at('The first meeting: Question 1?'))
  assert.ok(ctx.includes('It was stopped before a decision.'))
  assert.ok(ctx.includes('Decision:\n# Consortium: Answer 2\n## Recommendation\nDo 2.'))
  assert.ok(ctx.includes('Agreed: Agreed 1') && ctx.includes('Actions: Action 2'))
  assert.ok(ctx.includes('Disputed: Disputed 3'))

  // long ones fit: the newest whole, the oldest left out
  const long = (n: number): Round => round(n, { decision: `${'word '.repeat(2000)}` })
  const many = earlierContext([long(1), long(2), long(3), long(4)], 4000)
  assert.ok(many.length <= 4000, String(many.length))
  assert.ok(many.includes('Follow-up 3: Question 4?'))
  assert.ok(!many.includes('The first meeting'))
  assert.match(many, /\(\d earlier meetings? left out\.\)$/)

  // in the brief: the question first, then what came before; half the turns, two a seat at least
  const s = { ...DEFAULTS, maxTurns: 12 }
  const brief = settingsBrief(s, `Next?\n\n${ctx}`)
  assert.ok(brief.task.startsWith('Next?\n\n## Earlier in this thread'))
  assert.equal(followTurns(s), 6)
  assert.equal(followTurns({ ...s, maxTurns: 30 }), 15)
  assert.equal(followTurns({ ...s, maxTurns: 7 }), 6) // three seats: six at least
  assert.equal(followTurns({ ...s, maxTurns: 100 }), 50)
})

test('Ask a follow-up: the form on the thread, its repository, an empty question', () => {
  const v = askModal({
    channel: 'C1',
    repos: ['acme/web', 'acme/api'],
    repo: 'acme/api',
    files: true,
    install: 'https://x/slack/install',
    follow: '1.5'
  })
  assert.equal(v.title.text, 'Ask a follow-up')
  assert.deepEqual(JSON.parse(v.private_metadata!), { thread: '1.5', channel: 'C1' })
  const input = (id: string): Record<string, unknown> =>
    (v.blocks.find((b) => b.block_id === id) as unknown as { element: Record<string, unknown> })
      .element
  assert.equal(input('question').initial_value, undefined)
  assert.equal(input('channel').initial_conversation, 'C1')
  assert.equal((input('repo').initial_option as { value: string }).value, 'acme/api')
  const r = readAsk({
    question: { question: { value: 'And the tests?' } },
    channel: { channel: { selected_conversation: 'C1' } },
    repo: { repo: { selected_option: { value: 'acme/api' } } }
  })
  assert.deepEqual(r, { question: 'And the tests?', channel: 'C1', repo: 'acme/api', files: [] })
  // a plain question's form has none of it
  const plain = askModal({ files: true, install: 'x' })
  assert.equal(plain.private_metadata, undefined)
  assert.equal(plain.title.text, 'Ask the table')
})

test('follow-ups: a mention or the button in an ended thread, a plain reply only hints, unknown threads', async () => {
  const VOTE =
    '```json\n{"position":"Ship","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
  const BOARD = JSON.stringify({
    recommendation: 'Ship the CSV',
    agreed: [{ text: 'CSV first', sources: [] }],
    disputed: [],
    questions: [],
    actions: [{ text: 'Write the exporter', sources: [] }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on: Record<string, (args: any) => Promise<unknown>> = {}
  const app = {
    command: (n: string, f: (typeof on)[string]) => (on[n] = f),
    event: (n: string, f: (typeof on)[string]) => (on[n] = f),
    message: (f: (typeof on)[string]) => (on.message = f),
    action: (n: string | RegExp, f: (typeof on)[string]) => (on[String(n)] = f),
    view: () => {}
  } as unknown as App
  // Slack: each call recorded; thread "50"'s root is this bot's, "60"'s someone else's
  const sent: { method: string; args: Record<string, unknown> }[] = []
  let n = 0
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    if (method === 'conversations.replies')
      return {
        messages: [
          args.ts === '60'
            ? { ts: '60', user: 'U5', text: 'hi' }
            : {
                ts: args.ts,
                bot_id: 'B1',
                text: 'root',
                blocks: [{ type: 'header', text: { type: 'plain_text', text: 'Ship?' } }]
              }
        ]
      }
    if (method === 'views.open') return { view: { id: 'V1' } }
    if (method === 'chat.getPermalink')
      return { permalink: `https://slack.test/p${args.message_ts}` }
    return { ts: String(++n), canvas_id: 'F1', url: 'https://x/', team_id: 'T1' }
  }
  const make = (path: string[]): unknown =>
    new Proxy(
      async (args: Record<string, unknown>) => {
        sent.push({ method: path.join('.'), args })
        return answer(path.join('.'), args)
      },
      { get: (_, k: string) => make([...path, k]) }
    )
  const client = make([])
  const run: typeof runMember = async (_cli, _a, _delta, key) => {
    if (key.endsWith(':whiteboard')) return { text: BOARD }
    if (key.endsWith(':chair'))
      return { text: '# Consortium: Ship\n## Recommendation\nShip it.\n## Next actions\n1. Go' }
    await new Promise((r) => setTimeout(r, 20)) // time for the clerk's board
    return { text: `Ship.\n${VOTE}` }
  }
  const threads = new Map<string, Thread>() // what hosted keeps in the store
  const convened: { question: string; thread?: string }[] = []
  const asks: unknown[] = []
  const dir = await mkdtemp(join(tmpdir(), 'follow-bridge-'))
  const tenancy: Tenancy = {
    refuse: async () => undefined,
    maxMeetings: async () => 3,
    convene: async (_team, channel, question, x) => {
      convened.push({ question, thread: x.thread })
      const prior = x.thread ? threads.get(x.thread) : undefined
      return {
        brief: settingsBrief(
          { ...DEFAULTS, seats: DEFAULTS.seats.slice(0, 2), maxTurns: 4 },
          question
        ),
        run,
        dir,
        issues: true,
        ...(prior && { follow: prior.rounds.length }),
        record: async (thread, r) =>
          void threads.set(
            thread,
            addRound(threads.get(thread), { channel, repo: 'acme/api', files: [] }, r)
          )
      }
    },
    thread: async (_team, ts) => threads.get(ts),
    ask: async (o) => (asks.push(o), !!o.view) // a form when there is one; a mention starts at once
  }
  bridge(app, tenancy)
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 600 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(ok(), 'condition did not settle')
  }
  const context = { teamId: 'T1', botId: 'B1', botUserId: 'UBOT' }
  const ephemerals = (): string[] =>
    sent.filter((x) => x.method === 'chat.postEphemeral').map((x) => String(x.args.text))

  // a meeting runs to its decision; what follow-ups need is kept under its thread
  await on.app_mention({
    event: { user: 'U1', channel: 'C1', text: '<@UBOT> Ship it?' },
    client,
    context
  })
  await until(() => threads.get('1')?.rounds.length === 1)
  const first = threads.get('1')!.rounds[0]
  assert.equal(first.question, 'Ship it?')
  assert.equal(first.state, 'decided')
  assert.equal(first.link, 'https://slack.test/p1')
  assert.ok(first.decision?.startsWith('# Consortium: Ship\n## Recommendation\nShip it.'))
  assert.ok(!first.decision?.includes('Final votes'))
  assert.deepEqual(
    first.board?.actions.map((a) => a.text),
    ['Write the exporter']
  )
  assert.match(first.note ?? '', /page_facing_up/)
  // the decision's message: Ask a follow-up and Create Linear issues
  const buttons = sent
    .filter((x) => x.method === 'chat.update' && Array.isArray(x.args.blocks))
    .flatMap((x) => x.args.blocks as { elements?: { action_id?: string; value?: string }[] }[])
    .flatMap((b) => b.elements ?? [])
  assert.ok(buttons.some((b) => b.action_id === 'follow_up' && b.value === '1'))
  assert.ok(buttons.some((b) => b.action_id === 'linear_issues' && b.value === `1:${first.id}`))

  // a plain reply starts nothing; its author hears how to continue, once
  const reply = (text: string, user = 'U2'): Promise<unknown> =>
    on.message({ message: { channel: 'C1', thread_ts: '1', user, text }, client, context })
  await reply('nice')
  await reply('really nice')
  await reply('<@UBOT> and the tests?') // a mention: app_mention has it, no hint
  assert.deepEqual(ephemerals(), ['Mention @Consortium or press Ask a follow-up to continue.'])
  assert.equal(convened.length, 1)

  // Ask a follow-up: the form, on the thread's channel and repository
  await on.follow_up({
    ack: async () => {},
    body: { user: { id: 'U2' }, trigger_id: 'TR', channel: { id: 'C1' } },
    action: { value: '1' },
    client,
    context
  })
  assert.deepEqual(asks.at(-1), {
    team: 'T1',
    client,
    user: 'U2',
    channel: 'C1',
    view: 'V1',
    follow: { thread: '1', repo: 'acme/api' }
  })

  // a mention in the thread: a follow-up there, under a header of its own
  const posts = sent.filter((x) => x.method === 'chat.postMessage').length
  await on.app_mention({
    event: { user: 'U2', channel: 'C1', thread_ts: '1', text: '<@UBOT> and the tests?' },
    client,
    context
  })
  assert.deepEqual(convened.at(-1), { question: 'and the tests?', thread: '1' })
  const header = sent.filter((x) => x.method === 'chat.postMessage')[posts]
  assert.equal(header.args.thread_ts, '1')
  assert.match(
    JSON.stringify(header.args.blocks),
    /Follow-up 1 · builds on what the table said above/
  )
  // while it runs, the button says so instead of a second one
  await on.follow_up({
    ack: async () => {},
    body: { user: { id: 'U2' }, trigger_id: 'TR', channel: { id: 'C1' } },
    action: { value: '1' },
    client,
    context
  })
  assert.match(
    JSON.stringify(sent.filter((x) => x.method === 'views.update').at(-1)),
    /already running in this thread/
  )
  await until(() => threads.get('1')?.rounds.length === 2)
  // the root says it has a follow-up
  const root = sent.find(
    (x) =>
      x.method === 'chat.update' &&
      x.args.ts === '1' &&
      JSON.stringify(x.args).includes('follow_ups')
  )
  assert.match(JSON.stringify(root?.args.blocks), /1 follow-up in the thread/)
  assert.equal(threads.get('1')!.rounds[1].question, 'and the tests?')

  // an old meeting's thread (no record, the root is mine): say so, offer to start fresh
  await on.app_mention({
    event: { user: 'U3', channel: 'C1', thread_ts: '50', text: '<@UBOT> what next?' },
    client,
    context
  })
  const offer = sent.filter((x) => x.method === 'chat.postEphemeral').at(-1)!
  assert.equal(offer.args.text, UNAVAILABLE)
  assert.match(
    JSON.stringify(offer.args.blocks),
    /"action_id":"fresh_start".*"value":"what next\?"/
  )
  assert.equal(convened.length, 2)
  // a thread that was never a meeting: a new meeting in the channel, as before
  const before = sent.filter((x) => x.method === 'chat.postMessage').length
  await on.app_mention({
    event: { user: 'U3', channel: 'C1', thread_ts: '60', text: '<@UBOT> what next?' },
    client,
    context
  })
  assert.deepEqual(convened.at(-1), { question: 'what next?', thread: undefined })
  const fresh = sent.filter((x) => x.method === 'chat.postMessage')[before]
  assert.equal(fresh.args.thread_ts, undefined)
  // a plain reply in a thread that was never a meeting: nothing
  const told = ephemerals().length
  await on.message({
    message: { channel: 'C1', thread_ts: '60', user: 'U2', text: 'hm' },
    client,
    context
  })
  assert.equal(ephemerals().length, told)
})
