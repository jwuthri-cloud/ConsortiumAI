import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App, Installation } from '@slack/bolt'
import { runDebate, stop } from '../src/main/debate'
import { runMember } from '../src/main/cli'
import { SILENT } from '../src/main/api'
import {
  DEFAULTS,
  SCOPES,
  explain,
  fromStore,
  homeView,
  keyed,
  modelGroups,
  readLink,
  readTable,
  serveHosted,
  settingsBrief,
  signLink,
  tableModal
} from '../src/main/hosted'
import { installations, openStore, seal, unseal } from '../src/main/store'
import { bridge, type Tenancy } from '../src/main/slack'
import type { DebateEvent } from '../src/shared/types'

const SECRET = 'x'.repeat(40)

test('keys: sealed with AES-GCM, open only with the same secret and workspace', () => {
  const sealed = seal('sk-or-v1-secret', SECRET, 'T1')
  assert.ok(!sealed.includes('sk-or-v1-secret'))
  assert.notEqual(seal('sk-or-v1-secret', SECRET, 'T1'), sealed) // a fresh IV each time
  assert.equal(unseal(sealed, SECRET, 'T1'), 'sk-or-v1-secret')
  assert.throws(() => unseal(sealed, SECRET, 'T2')) // copied to another workspace's row
  assert.throws(() => unseal(sealed, 'y'.repeat(40), 'T1'))
  const [v, iv, tag, body] = sealed.split('.')
  const flipped = Buffer.from(body, 'base64url')
  flipped[0] ^= 1
  assert.throws(() => unseal([v, iv, tag, flipped.toString('base64url')].join('.'), SECRET, 'T1'))
})

test("a workspace's settings make a Deep-agent-only brief on OpenRouter, personas as picked", () => {
  const seats = [
    { model: 'a/one', persona: 'skeptic' as const },
    { model: 'b/two', persona: 'customer' as const },
    { model: 'c/three', persona: 'skeptic' as const }
  ]
  const b = settingsBrief({ ...DEFAULTS, seats, chair: 1, maxTurns: 10 }, 'Ship a CSV export?')
  assert.equal(b.task, 'Ship a CSV export?')
  assert.deepEqual(
    b.members.map((m) => [m.cli, m.model, m.persona]),
    [
      ['harness', 'openrouter:a/one', 'skeptic'],
      ['harness', 'openrouter:b/two', 'customer'],
      ['harness', 'openrouter:c/three', 'skeptic']
    ]
  )
  assert.equal(b.chairId, 'm2')
  assert.equal(b.maxTurns, 10)
  assert.equal(b.projectPath, undefined)
  assert.equal(b.attachments, undefined)
  assert.equal(b.board, undefined) // the chair's seat writes the board
})

test('settings saved before personas: model ids get personas in seat order', () => {
  const old = { seats: ['a/one', 'b/two', 'c/three'], chair: 2, maxTurns: 9 } as unknown as Partial<
    typeof DEFAULTS
  >
  const s = fromStore(old)
  assert.deepEqual(s.seats, [
    { model: 'a/one', persona: 'strategist' },
    { model: 'b/two', persona: 'engineer' },
    { model: 'c/three', persona: 'researcher' }
  ])
  assert.deepEqual([s.chair, s.maxTurns, s.maxMeetings], [2, 9, DEFAULTS.maxMeetings])
  assert.deepEqual(fromStore(s), s) // new rows read as they are
  assert.deepEqual(fromStore(undefined), DEFAULTS)
})

test('the Edit table modal: six seat rows, empty ones dropped, chair among the seats', () => {
  type Values = Parameters<typeof readTable>[0]
  const sel = (value: string): { selected_option: { value: string } } => ({
    selected_option: { value }
  })
  // rows: [persona, model]; 'none' = an empty seat
  const values = (rows: [string, string][], chair = '0', turns = '12', max = '3'): Values => ({
    ...Object.fromEntries(
      rows.map(([persona, model], i) => [`seat${i}`, { persona: sel(persona), model: sel(model) }])
    ),
    chair: { chair: sel(chair) },
    turns: { turns: { value: turns } },
    max: { max: { value: max } },
    who: { who: sel('admins') }
  })
  const table = values(
    [
      ['skeptic', 'a/one'],
      ['designer', 'none'],
      ['skeptic', 'meta/llama-5:free'],
      ['customer', 'none']
    ],
    '2'
  )
  assert.deepEqual(readTable(table), {
    table: {
      seats: [
        { model: 'a/one', persona: 'skeptic' },
        { model: 'meta/llama-5:free', persona: 'skeptic' } // the same persona twice is fine
      ],
      chair: 1, // row 3 is the second seat
      maxTurns: 12,
      who: 'admins',
      maxMeetings: 3
    }
  })
  const errors = (v: Values): Record<string, string> => {
    const r = readTable(v)
    return 'errors' in r ? r.errors : {}
  }
  const two: [string, string][] = [
    ['skeptic', 'a/one'],
    ['engineer', 'b/two']
  ]
  assert.match(errors(values([['skeptic', 'a/one']])).chair, /at least two seats/)
  assert.match(errors(values([...two, ['customer', 'none']], '2')).chair, /Seat 3 is empty/)
  assert.match(errors(values([two[0], ['engineer', 'not an id']])).chair, /not an id/)
  assert.match(errors(values(two, '0', '3')).turns, /4 to 100/)
  assert.match(errors(values(two, '0', '12', '11')).max, /1 to 10/)
  assert.deepEqual(errors(values(two)), {})
})

test("the model select: main providers' newest, within Slack's 100, the seats' models always in", () => {
  // newest first, as OpenRouter lists them: 60 each from three providers, and an unlisted one
  const catalogue = ['anthropic', 'openai', 'google', 'acme'].flatMap((p) =>
    Array.from({ length: 60 }, (_, i) => `${p}/m${i}`)
  )
  const groups = modelGroups(catalogue, ['openai/m59', 'retired/old-model'])
  const ids = groups.flatMap((g) => g.options.map((o) => o.value))
  assert.equal(ids.length, 100)
  assert.equal(ids[0], 'none')
  assert.ok(ids.includes('openai/m59') && ids.includes('retired/old-model'))
  assert.ok(!ids.some((id) => id.startsWith('acme/'))) // not a main provider
  assert.deepEqual(
    groups.map((g) => [g.label.text, g.options.length]),
    [
      ['No model', 1],
      ['Anthropic', 33], // taken in turn: the 97 free places go 33, 32, 32
      ['OpenAI', 33], // its 32 newest and the seat's old one
      ['Google', 32],
      ['retired', 1]
    ]
  )
  const anthropic = groups[1].options.map((o) => o.value)
  assert.deepEqual(anthropic.slice(0, 3), ['anthropic/m0', 'anthropic/m1', 'anthropic/m2']) // newest first
  // no catalogue (OpenRouter slow): the seats' own models and "— empty —"
  assert.deepEqual(
    modelGroups([], ['a/one']).flatMap((g) => g.options.map((o) => o.value)),
    ['none', 'a/one']
  )
})

test("the Edit table modal opens on the table as it is, every select's initial pick among its options", () => {
  const s = { ...DEFAULTS, chair: 2 }
  const view = tableModal(s, ['anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol'])
  const json = JSON.stringify(view)
  const selects = view.blocks.flatMap((b) =>
    b.type === 'actions' ? b.elements : b.type === 'input' ? [b.element] : []
  ) as {
    type: string
    action_id: string
    initial_option?: { value: string }
    options?: { value: string }[]
    option_groups?: { options: { value: string }[] }[]
  }[]
  const statics = selects.filter((e) => e.type === 'static_select')
  assert.equal(statics.length, 13) // six seats × persona + model, and the chair
  for (const e of statics) {
    const options = e.options ?? e.option_groups!.flatMap((g) => g.options)
    assert.ok(options.length <= 100)
    assert.ok(
      options.some((o) => JSON.stringify(o) === JSON.stringify(e.initial_option)),
      `${e.action_id}: initial option not among its options`
    )
  }
  const picks = statics.filter((e) => e.action_id !== 'chair').map((e) => e.initial_option!.value)
  assert.deepEqual(picks, [
    'strategist',
    'anthropic/claude-sonnet-5.5', // a seat's model, though not in the catalogue
    'engineer',
    'openai/gpt-6.1-sol',
    'researcher',
    'google/gemini-3.8-flash',
    'designer', // the empty rows start on the personas not yet seated
    'none',
    'skeptic',
    'none',
    'customer',
    'none'
  ])
  assert.equal(statics.at(-1)!.initial_option!.value, '2')
  assert.ok(json.includes('anthropic/claude-opus-5.5'))
})

test('the hosted runner: Deep-agent on OpenRouter only, no files, its own key and folder', async () => {
  const seen: Parameters<typeof runMember>[1][] = []
  const run = keyed('sk-A', '/data/teams/T1', async (_cli, a) => {
    seen.push(a)
    return { text: 'ok' }
  })
  await run(
    'harness',
    { prompt: 'p', model: 'openrouter:a/one', cwd: '/', dirs: ['/etc'] },
    () => {},
    'k'
  )
  assert.deepEqual(seen[0], {
    prompt: 'p',
    model: 'openrouter:a/one',
    cwd: undefined,
    dirs: undefined,
    apiKey: 'sk-A',
    home: '/data/teams/T1'
  })
  await assert.rejects(
    run('claude', { prompt: 'p' }, () => {}, 'k'),
    /Only OpenRouter Deep-agent/
  )
  await assert.rejects(
    run('harness', { prompt: 'p', model: 'openai:gpt-6' }, () => {}, 'k'),
    /Only OpenRouter Deep-agent/
  )
  assert.equal(seen.length, 1)
  assert.match(
    String(explain(new Error('401 No auth credentials found'))),
    /An admin can replace it/
  )
  assert.match(String(explain(new Error('402 Insufficient credits'))), /out of credits/)
  const other = new Error('Deep-agent stopped')
  assert.equal(explain(other), other)
})

test('Slack installations: saved sealed, fetched per workspace, deleted', async () => {
  for (const url of ['sqlite::memory:', process.env.TEST_DATABASE_URL].filter(
    (u): u is string => !!u
  )) {
    const store = await openStore(url)
    const installed: string[] = []
    const s = installations(store, SECRET, async (team) => void installed.push(team))
    const i = {
      team: { id: 'T1', name: 'One' },
      enterprise: undefined,
      user: { id: 'U1', token: undefined, scopes: undefined },
      bot: { token: 'xoxb-one', scopes: SCOPES, id: 'B1', userId: 'UB1' },
      isEnterpriseInstall: false
    } as unknown as Installation
    await s.storeInstallation(i)
    assert.deepEqual(installed, ['T1'])
    assert.ok(!JSON.stringify(await store.get('installation', 'T1')).includes('xoxb-one'))
    const q = { teamId: 'T1', enterpriseId: undefined, isEnterpriseInstall: false as const }
    assert.deepEqual(await s.fetchInstallation(q), JSON.parse(JSON.stringify(i)))
    await assert.rejects(s.fetchInstallation({ ...q, teamId: 'T2' }), /no installation/)
    await s.deleteInstallation!(q)
    await assert.rejects(s.fetchInstallation(q), /no installation/)
    await store.close()
  }
})

test('the Connect OpenRouter link is signed and expires', () => {
  const t = signLink(SECRET, 'T1', 'U1', 1000)
  assert.deepEqual(readLink(SECRET, t, 2000), { team: 'T1', user: 'U1' })
  assert.equal(readLink(SECRET, t, 1000 + 3_600_001), undefined)
  assert.equal(readLink('y'.repeat(40), t, 2000), undefined)
  const forged = Buffer.from(JSON.stringify({ team: 'T2', user: 'U1', exp: 9e15 })).toString(
    'base64url'
  )
  assert.equal(readLink(SECRET, `${forged}.${t.split('.')[1]}`, 2000), undefined)
})

test('the Home tab: the table by persona and model, buttons for admins only, never the key', () => {
  const seats = [
    { model: 'anthropic/claude-sonnet-5.5', persona: 'skeptic' as const },
    { model: 'openai/gpt-6.1-sol', persona: 'skeptic' as const }
  ]
  const s = { ...DEFAULTS, seats, chair: 1, key: 'v1.sealed', keyHint: 'sk-or-v1-…3f9a' }
  const text = (admin: boolean): string => JSON.stringify(homeView(s, admin, 'https://x/connect'))
  assert.ok(text(false).includes('1. The Skeptic · `anthropic/claude-sonnet-5.5`\\n'))
  assert.ok(text(false).includes('2. The Skeptic 2 · `openai/gpt-6.1-sol` · *chair*'))
  assert.ok(text(true).includes('home_key') && text(true).includes('https://x/connect'))
  assert.ok(!text(false).includes('home_key') && !text(false).includes('https://x/connect'))
  assert.ok(text(false).includes('sk-or-v1-…3f9a') && !text(false).includes('v1.sealed'))
})

test("two workspaces' meetings run side by side, each on its own key and in its own folder", async () => {
  const VOTE =
    '```json\n{"position":"Ship","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
  const keys: Record<string, Set<string | undefined>> = { A: new Set(), B: new Set() }
  const fake: typeof runMember = async (_cli, a, _delta, key) => {
    keys[key.split(':')[0]].add(a.apiKey)
    if (key.endsWith(':whiteboard')) return { text: 'not a board' }
    if (key.endsWith(':chair')) return { text: '# Decision\n\nShip it.' }
    await new Promise((r) => setTimeout(r, 2)) // the two meetings' turns interleave
    return { text: `Ship it.\n${VOTE}` }
  }
  const dirs = {
    A: await mkdtemp(join(tmpdir(), 'team-a-')),
    B: await mkdtemp(join(tmpdir(), 'team-b-'))
  }
  const s = { ...DEFAULTS, seats: DEFAULTS.seats.slice(0, 2), maxTurns: 4 }
  const done = (['A', 'B'] as const).map(
    (team) =>
      new Promise<DebateEvent>((resolve) =>
        runDebate(
          settingsBrief(s, `Question for ${team}`),
          (e) => ['consortium', 'failed', 'stopped'].includes(e.type) && resolve(e),
          team,
          undefined,
          keyed(`sk-${team}`, dirs[team], fake),
          SILENT,
          dirs[team]
        )
      )
  )
  const ends = await Promise.all(done)
  assert.deepEqual(
    ends.map((e) => e.type),
    ['consortium', 'consortium']
  )
  assert.deepEqual([...keys.A], ['sk-A'])
  assert.deepEqual([...keys.B], ['sk-B'])
  assert.ok(
    existsSync(join(dirs.A, 'sessions', 'A.json')) &&
      !existsSync(join(dirs.A, 'sessions', 'B.json'))
  )
  assert.ok(
    existsSync(join(dirs.B, 'sessions', 'B.json')) &&
      !existsSync(join(dirs.B, 'sessions', 'A.json'))
  )
  assert.ok(!readFileSync(join(dirs.A, 'sessions', 'A.json'), 'utf8').includes('sk-A')) // the key is never saved
})

test("the Deep-agent sends the run's key to OpenRouter, not the server's", async () => {
  process.env.OPENROUTER_API_KEY = 'sk-SERVER'
  const sent: [string, string | null][] = [] // model → Authorization
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('/chat/completions')) return new Response('{"data":[]}')
    const headers = new Headers(init?.headers ?? (input as Request).headers)
    sent.push([JSON.parse(String(init?.body)).model, headers.get('authorization')])
    return new Response('{"error":{"message":"No auth credentials found","code":401}}', {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  }
  try {
    const home = await mkdtemp(join(tmpdir(), 'harness-home-'))
    const one = (model: string, apiKey: string): Promise<unknown> =>
      runMember(
        'harness',
        { prompt: 'hi', model: `openrouter:${model}`, apiKey, home },
        () => {},
        `m-${apiKey}`
      )
    const results = await Promise.allSettled([one('a/one', 'sk-A'), one('b/two', 'sk-B')])
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'rejected']
    )
    assert.ok(sent.length >= 2)
    for (const [model, auth] of sent)
      assert.equal(auth, model === 'a/one' ? 'Bearer sk-A' : 'Bearer sk-B')
  } finally {
    globalThis.fetch = real
    delete process.env.OPENROUTER_API_KEY
  }
})

test('the hosted manifest asks for the scopes the installer requests', () => {
  const yml = readFileSync(join(__dirname, '..', 'slack-manifest.hosted.yml'), 'utf8')
  const bot = yml.match(/bot:\n((?:\s+- .+\n)+)/)![1]
  assert.deepEqual(
    bot
      .split('\n')
      .map((l) => l.replace(/^\s*- /, '').trim())
      .filter(Boolean)
      .sort(),
    [...SCOPES].sort()
  )
})

test('the bridge: a workspace reaches only its own meetings, under its own limit', async () => {
  const VOTE =
    '```json\n{"position":"Ship","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on: Record<string, (args: any) => Promise<unknown>> = {}
  const app = {
    command: (n: string, f: (typeof on)[string]) => (on[n] = f),
    event: (n: string, f: (typeof on)[string]) => (on[n] = f),
    message: (f: (typeof on)[string]) => (on.message = f),
    action: () => {}
  } as unknown as App
  // a workspace's Slack: every call answers, and each workspace numbers its messages from 1,
  // so both meetings' threads are "1"
  const calls: string[] = []
  const slack = (team: string): unknown => {
    let n = 0
    const make = (path: string[]): unknown =>
      new Proxy(
        async () => {
          calls.push(`${team} ${path.join('.')}`)
          return { ts: String(++n), canvas_id: 'F1', url: 'https://x/', team_id: team }
        },
        { get: (_, k: string) => make([...path, k]) }
      )
    return make([])
  }
  const clients = { TA: slack('TA'), TB: slack('TB'), TC: slack('TC') }
  const prompts: [string, string][] = [] // meeting id, prompt
  const run: typeof runMember = async (_cli, a, _delta, key) => {
    if (key.endsWith(':whiteboard')) return { text: 'not a board' }
    if (key.endsWith(':chair')) return { text: '# Decision' }
    prompts.push([key.split(':')[0], a.prompt])
    await new Promise(() => {}) // holds the floor until the host speaks (or the test ends)
    return { text: `Ship.\n${VOTE}` }
  }
  const dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  const tenancy: Tenancy = {
    refuse: async (_team, user) => (user === 'NOPE' ? 'not you' : undefined),
    maxMeetings: async () => 1,
    convene: async (_team, _channel, question) => ({
      brief: settingsBrief(
        { ...DEFAULTS, seats: DEFAULTS.seats.slice(0, 2), maxTurns: 4 },
        question
      ),
      run,
      dir
    })
  }
  bridge(app, tenancy)
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(ok(), 'condition did not settle')
  }
  const said: string[] = []
  const command = (team: keyof typeof clients, text: string): Promise<unknown> =>
    on['/consortium']({
      command: { channel_id: 'C1', user_id: 'U1', text },
      ack: async () => {},
      respond: async (r: { text: string }) => void said.push(r.text),
      client: clients[team],
      context: { teamId: team }
    })
  const reply = (team: keyof typeof clients, user: string, text: string): Promise<unknown> =>
    on.message({
      message: { thread_ts: '1', user, text },
      client: clients[team],
      context: { teamId: team }
    })

  await command('TA', 'Question A')
  await until(() => prompts.length === 1)
  const a = prompts[0][0]
  await command('TA', 'Another one') // over TA's limit
  assert.deepEqual(said, [
    '1 meetings are running, the most this table holds at once (1). Try again when one ends.'
  ])
  await command('TB', 'Question B') // TB has a limit of its own
  await until(() => prompts.length === 2)
  const b = prompts[1][0]

  await reply('TA', 'U1', 'FROM-A')
  await reply('TB', 'U1', 'FROM-B')
  await reply('TC', 'U1', 'FROM-C') // a workspace with no meeting in thread "1"
  await reply('TA', 'NOPE', 'FROM-NOPE')
  await until(() => prompts.length === 4)
  const of = (id: string): string =>
    prompts
      .filter(([m]) => m === id)
      .map(([, p]) => p)
      .join('\n')
  assert.ok(of(a).includes('FROM-A') && !of(a).includes('FROM-B'))
  assert.ok(of(b).includes('FROM-B') && !of(b).includes('FROM-A'))
  assert.ok(!prompts.some(([, p]) => /FROM-(C|NOPE)/.test(p)))
  assert.ok(calls.includes('TA chat.postEphemeral')) // NOPE was told, only NOPE
  assert.ok(!calls.some((c) => c.startsWith('TC ')))
  // sessions and decisions in the workspace's folder
  assert.ok(existsSync(join(dir, 'sessions', `${a}.json`)))
  stop(a)
  stop(b)
})

test("the web pages: landing and privacy, Bolt's OAuth results replaced, nothing echoed unescaped", async () => {
  const port = await new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as AddressInfo
      s.close(() => done(port))
    })
  })
  Object.assign(process.env, {
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATABASE_URL: 'sqlite::memory:',
    CONSORTIUM_DATA: await mkdtemp(join(tmpdir(), 'consortium-pages-')),
    CONSORTIUM_SECRET: SECRET,
    SLACK_CLIENT_ID: '1.2',
    SLACK_CLIENT_SECRET: 'x',
    SLACK_SIGNING_SECRET: 'x'
  })
  const app = await serveHosted()
  const XSS = '<script>alert(1)</script>'
  const get = async (path: string): Promise<[number, string]> => {
    const r = await fetch(`http://localhost:${port}${path}`)
    return [r.status, await r.text()]
  }
  try {
    for (const path of ['/', '/privacy']) {
      const [status, html] = await get(`${path}?q=${encodeURIComponent(XSS)}`)
      assert.equal(status, 200)
      assert.match(html, /<a class="btn[^"]*" href="\/slack\/install">/)
      assert.ok(!html.includes('alert(1)'))
    }
    const [cancelled, why] = await get('/slack/oauth_redirect?error=access_denied&state=s')
    assert.equal(cancelled, 400)
    assert.match(why, /cancelled on Slack's permission screen/)
    assert.match(why, /href="\/slack\/install">Try again/)
    const [failed, page] = await get(`/slack/oauth_redirect?error=${encodeURIComponent(XSS)}`)
    assert.equal(failed, 400)
    assert.ok(page.includes('Slack said: &lt;script&gt;alert(1)&lt;/script&gt;'))
    assert.ok(!page.includes(XSS))
    const [expired, link] = await get(`/openrouter/connect?t=${encodeURIComponent(XSS)}`)
    assert.equal(expired, 400)
    assert.ok(!link.includes('alert(1)'))
  } finally {
    await app.stop()
  }
})
