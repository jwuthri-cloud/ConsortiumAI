import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LIMITS,
  SHOWN,
  beginOAuth,
  clip,
  finishOAuth,
  refreshed,
  hide,
  openState,
  openToolbox,
  parseHeaders,
  probe,
  publicHttps,
  sealState,
  testArgs,
  testServer,
  toolName,
  usable
} from '../src/main/mcp'
import { bridge, toolsLine, type Tenancy } from '../src/main/slack'
import {
  DEFAULTS,
  allowModal,
  SECTIONS,
  callsModal,
  confirmModal,
  connectModal,
  firstSentence,
  fromStore,
  homeView,
  keyed,
  personaModal,
  readLens,
  readConnect,
  readTable,
  seatTools,
  settingsBrief,
  tableModal,
  testModal,
  toolStatus,
  toolsAttached,
  verbOf,
  type Settings
} from '../src/main/hosted'
import { seal } from '../src/main/store'
import type { Connection, ToolCall } from '../src/main/mcp'
import type { runMember } from '../src/main/cli'
import type { App, types } from '@slack/bolt'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERSONAS, PERSONA_IDS } from '../src/shared/personas'

const SECRET = 'x'.repeat(40)

type FakeTool = {
  name: string
  readOnly?: boolean
  run?: (
    args: Record<string, unknown>
  ) => Promise<string | { text: string; isError: true }> | string | { text: string; isError: true }
}

// A remote MCP server, as small as the protocol allows: JSON-RPC over POST, JSON answers.
async function fakeServer(
  tools: FakeTool[],
  o: { status?: number } = {}
): Promise<{ url: string; seen: IncomingHttpHeaders[]; close(): void }> {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer(async (req, res) => {
    seen.push(req.headers)
    if (o.status) return void res.writeHead(o.status).end('nope')
    if (req.method !== 'POST') return void res.writeHead(405).end()
    let body = ''
    for await (const c of req) body += c
    const m = JSON.parse(body)
    if (m.id === undefined) return void res.writeHead(202).end()
    const reply = (x: object): void =>
      void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...x }))
    if (m.method === 'initialize')
      return reply({
        result: {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' }
        }
      })
    if (m.method === 'tools/list')
      return reply({
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: `the ${t.name} tool`,
            inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
            ...(t.readOnly !== undefined && { annotations: { readOnlyHint: t.readOnly } })
          }))
        }
      })
    if (m.method === 'tools/call') {
      const t = tools.find((x) => x.name === m.params.name)
      const out = t?.run ? await t.run(m.params.arguments) : `ran ${m.params.name}`
      const r = typeof out === 'string' ? { text: out } : out
      return reply({
        result: {
          content: [{ type: 'text', text: r.text }],
          ...('isError' in r && { isError: true })
        }
      })
    }
    reply({ error: { code: -32601, message: 'Method not found' } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => void server.close()
  }
}

test('usable: read-only by the server, or allowed by an admin', () => {
  assert.equal(usable({ name: 'a', annotations: { readOnlyHint: true } }), true)
  assert.equal(usable({ name: 'a', annotations: { readOnlyHint: false } }), false)
  assert.equal(usable({ name: 'a' }), false) // no word on it: not read-only
  assert.equal(usable({ name: 'a' }, ['a']), true)
  assert.equal(usable({ name: 'b', annotations: { readOnlyHint: false } }, ['a']), false)
  assert.equal(toolName('linear', 'list issues/all'), 'linear__list_issues_all')
  assert.equal(toolName('x', 'y'.repeat(100)).length, 64)
})

test('a seat gets the read-only and allowed tools, capped per turn and per meeting', async () => {
  const big = 'z'.repeat(20_000)
  const s = await fakeServer([
    { name: 'search', readOnly: true, run: () => big },
    { name: 'create_issue', readOnly: false },
    { name: 'get_issue' }, // not annotated
    { name: 'leak', readOnly: true, run: () => 'the key is sk-test-0123456789abcdef!' }
  ])
  const box = await openToolbox(
    [
      {
        id: 'fake',
        name: 'Fake',
        url: s.url,
        headers: { authorization: 'Bearer sk-test-0123456789abcdef' },
        allow: ['get_issue']
      }
    ],
    { limits: { ...LIMITS, perTurn: 3, perMeeting: 4, chars: 1000 }, fetchFn: fetch }
  )
  try {
    assert.deepEqual(box.opened, [{ id: 'fake', name: 'Fake', tools: 3 }])
    assert.deepEqual(box.failed, [])
    assert.deepEqual(box.listed.fake, [
      { name: 'search', readOnly: true },
      { name: 'create_issue', readOnly: false },
      { name: 'get_issue', readOnly: false },
      { name: 'leak', readOnly: true }
    ])
    // the headers went with every request
    assert.ok(s.seen.every((h) => h.authorization === 'Bearer sk-test-0123456789abcdef'))

    const turn1 = box.forSeat()
    assert.deepEqual(
      turn1.map((t) => t.name),
      ['fake__search', 'fake__get_issue', 'fake__leak']
    )
    const [search, getIssue, leak] = turn1
    const r1 = String(await search.invoke({ q: 'x' }))
    assert.ok(r1.length < 1100 && r1.includes('more characters cut'), 'results are cut')
    assert.equal(String(await getIssue.invoke({ q: 'x' })), 'ran get_issue')
    assert.equal(
      String(await leak.invoke({})),
      'the key is [secret]!',
      'no secret reaches the model'
    )
    assert.match(String(await search.invoke({})), /3 calls in one turn/)

    // a new turn: its own budget, the meeting's still counting
    const [search2] = box.forSeat()
    assert.equal(String(await search2.invoke({})).length > 900, true)
    assert.match(String(await search2.invoke({})), /4 calls in this meeting/)

    // a seat without this server, or the clerk: none of its tools
    assert.equal(box.forSeat(['other']).length, 0)
    assert.equal(box.forSeat([]).length, 0)
  } finally {
    await box.close()
    s.close()
  }
})

test('a slow tool times out, and the seat hears why', async () => {
  const s = await fakeServer([
    {
      name: 'slow',
      readOnly: true,
      run: () => new Promise((r) => setTimeout(() => r('late'), 500))
    }
  ])
  const box = await openToolbox([{ id: 'f', name: 'F', url: s.url, headers: {} }], {
    limits: { ...LIMITS, callMs: 50 },
    fetchFn: fetch
  })
  try {
    const [slow] = box.forSeat()
    assert.match(String(await slow.invoke({})), /^F slow failed: .*time/i)
  } finally {
    await box.close()
    s.close()
  }
})

test("a server that refuses is left out, and its secret isn't logged", async () => {
  const s = await fakeServer([], { status: 401 })
  const ok = await fakeServer([{ name: 'read', readOnly: true }])
  const logged: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(' '))
  try {
    const box = await openToolbox(
      [
        { id: 'no', name: 'No', url: s.url, headers: { DD_API_KEY: 'dd-secret-api-key-123456' } },
        { id: 'ok', name: 'Ok', url: ok.url, headers: {} }
      ],
      { fetchFn: fetch }
    )
    assert.deepEqual(
      box.opened.map((o) => o.id),
      ['ok']
    )
    assert.equal(box.failed.length, 1)
    assert.equal(box.failed[0].id, 'no')
    assert.ok(logged.length)
    for (const text of [...logged, box.failed[0].why])
      assert.ok(!text.includes('dd-secret-api-key-123456'), text)
    await box.close()
    await assert.rejects(probe({ url: s.url, headers: {} }, fetch))
    assert.deepEqual(await probe({ url: ok.url, headers: {} }, fetch), [
      { name: 'read', readOnly: true }
    ])
  } finally {
    console.error = error
    s.close()
    ok.close()
  }
})

test('OAuth state: sealed, signed, short-lived, ours only', () => {
  const state = {
    team: 'T1',
    user: 'U1',
    server: 'linear',
    verifier: 'v'.repeat(43),
    client: { client_id: 'abc' }
  }
  const now = 1_000_000
  const token = sealState(SECRET, state, now)
  assert.deepEqual(openState(SECRET, token, now + 60_000), state)
  assert.ok(!token.includes('v'.repeat(10)) && !token.includes('linear'), 'the verifier is hidden')
  assert.equal(openState(SECRET, token, now + 16 * 60_000), undefined, 'expired')
  assert.equal(openState('y'.repeat(40), token, now), undefined, 'another server secret')
  const [v, iv, tag, body] = token.split('.')
  const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1)
  assert.equal(openState(SECRET, [v, iv, tag, flipped].join('.'), now), undefined, 'tampered')
  assert.equal(openState(SECRET, 'garbage', now), undefined)
})

test('custom servers: https on the public internet, headers one per line', async () => {
  await assert.rejects(publicHttps('http://mcp.linear.app/mcp'), /https/)
  await assert.rejects(publicHttps('https://127.0.0.1/mcp'), /private/)
  await assert.rejects(publicHttps('https://169.254.169.254/latest'), /private/)
  await assert.rejects(publicHttps('https://[::1]/mcp'), /private/)
  assert.deepEqual(parseHeaders('Authorization: Bearer abc\n\nX-Org:  42 '), {
    Authorization: 'Bearer abc',
    'X-Org': '42'
  })
  assert.match(String(parseHeaders('not a header')), /isn't a header/)
  assert.equal(hide('a sk-123456 b', ['sk-123456']), 'a [secret] b')
  assert.equal(clip('abc', 2), 'ab\n… (1 more characters cut)')
})

test("each seat's footer lists the connected tools it called", () => {
  assert.equal(
    toolsLine([
      { kind: 'tool', name: 'linear__list_issues' },
      { kind: 'tool', name: 'read_file' },
      { kind: 'thinking', text: 'hm' },
      { kind: 'tool', name: 'linear__list_issues' },
      { kind: 'tool', name: 'datadog__search_logs' }
    ]),
    ':hammer_and_wrench: `linear.list_issues` ×2, `datadog.search_logs`'
  )
  assert.equal(toolsLine([{ kind: 'tool', name: 'web_search' }]), '')
  assert.equal(toolsLine(), '')
})

// ---------- the hosted app's side ----------

type Values = Parameters<typeof readTable>[0]
const sel = (value: string): { selected_option: { value: string } } => ({
  selected_option: { value }
})
const tableValues = (tools: (string[] | undefined)[]): Values => ({
  ...Object.fromEntries(
    tools.flatMap((t, i) => [
      [`seat${i}`, { persona: sel('skeptic'), model: sel(`lab/model-${i}`) }],
      ...(t ? [[`tools${i}`, { tools: { selected_options: t.map((value) => ({ value })) } }]] : [])
    ])
  ),
  chair: { chair: sel('0') },
  clerk: { clerk: sel('anthropic/claude-haiku-5.5') },
  turns: { turns: { value: '12' } },
  max: { max: { value: '3' } },
  who: { who: sel('everyone') }
})

const linear: Connection = {
  id: 'linear',
  name: 'Linear',
  url: 'https://mcp.linear.app/mcp',
  auth: 'oauth',
  secret: seal(
    JSON.stringify({ oauth: { tokens: { access_token: 'lin_oauth_SECRET' } } }),
    SECRET,
    'T1:linear'
  ),
  tools: [
    { name: 'list_issues', readOnly: true },
    { name: 'get_issue', readOnly: true },
    { name: 'create_issue', readOnly: false }
  ]
}

test('settings: seats saved before tools use every server; the Edit table keeps a pick', () => {
  const old = fromStore({ seats: ['a/one', 'b/two'] as unknown as Settings['seats'] })
  assert.deepEqual(old.seats, [
    { model: 'a/one', persona: 'strategist' },
    { model: 'b/two', persona: 'engineer' }
  ])
  assert.equal(seatTools(old, 'm1'), undefined) // all
  const s = fromStore({
    ...DEFAULTS,
    chair: 1,
    seats: [
      { model: 'a/one', persona: 'skeptic', tools: [] },
      { model: 'b/two', persona: 'engineer', tools: ['linear'] }
    ]
  })
  assert.deepEqual(seatTools(s, 'm1'), [])
  assert.deepEqual(seatTools(s, 'm2'), ['linear'])
  assert.deepEqual(seatTools(s, 'chair'), ['linear'])
  assert.deepEqual(seatTools(s, 'whiteboard'), [])
  assert.deepEqual(seatTools(s, 'm9'), [])

  const servers = ['linear', 'datadog']
  const r = readTable(tableValues([['linear', 'datadog'], ['datadog'], [], undefined]), servers)
  assert.ok('table' in r)
  assert.deepEqual(
    r.table.seats.map((x) => x.tools),
    [undefined, ['datadog'], [], undefined] // all picked = all, later ones too
  )
  assert.ok(!JSON.stringify(r.table).includes('secret'))
})

test('the Edit table offers each seat the connected servers, its own picked', () => {
  const s = fromStore({
    seats: [
      { model: 'a/one', persona: 'skeptic', tools: ['datadog'] },
      { model: 'b/two', persona: 'engineer' }
    ]
  })
  const none = tableModal(s, [])
  assert.ok(!JSON.stringify(none).includes('multi_static_select'), 'no servers, no select')
  const view = tableModal(
    s,
    [],
    [
      { id: 'linear', name: 'Linear' },
      { id: 'datadog', name: 'Datadog' }
    ]
  )
  const input = (i: number): { element: { initial_options?: { value: string }[] } } =>
    view.blocks.find((b) => b.block_id === `tools${i}`) as never
  assert.deepEqual(
    input(0).element.initial_options?.map((o) => o.value),
    ['datadog']
  )
  assert.deepEqual(
    input(1).element.initial_options?.map((o) => o.value),
    ['linear', 'datadog']
  )
  assert.deepEqual(
    input(5).element.initial_options?.map((o) => o.value),
    ['linear', 'datadog']
  )
})

test('the Home tab: connections, their state, and Connect buttons for admins only', () => {
  const s = fromStore({
    seats: [
      { model: 'a/one', persona: 'skeptic', tools: [] },
      { model: 'b/two', persona: 'engineer' }
    ]
  })
  const conns: Connection[] = [
    linear,
    {
      id: 'datadog',
      name: 'Datadog',
      url: 'https://x',
      auth: 'headers',
      secret: 'v1.a.b.c',
      error: '<boom>'
    },
    { id: 'wiki', name: 'Wiki', url: 'https://wiki.example.com/mcp', auth: 'oauth' }
  ]
  const links = {
    linear: 'https://h/mcp/connect?t=1&s=linear',
    wiki: 'https://h/mcp/connect?t=1&s=wiki',
    notion: 'https://h/mcp/connect?t=1&s=notion'
  }
  const view = (admin: boolean, section: 'tools' | 'table'): string =>
    JSON.stringify(
      homeView(s, admin, undefined, { section, icons: 'https://h/icons', tools: { conns, links } })
    )
  const admin = view(true, 'tools')
  assert.match(admin, /"text":"\*Linear\*".*?"type":"overflow"/)
  assert.match(admin, /"image_url":"https:\/\/h\/icons\/linear.png".*?2 of 3 tools usable/)
  assert.match(admin, /"image_url":"https:\/\/h\/icons\/custom.png","alt_text":"Wiki"/)
  assert.match(admin, /Didn't connect last time: &lt;boom&gt;/)
  assert.match(admin, /:hourglass_flowing_sand: Not authorized yet/)
  assert.match(admin, /"Authorize"\},"url":"https:\/\/h\/mcp\/connect\?t=1&s=wiki"/)
  assert.match(admin, /"Reconnect"\},"url":"https:\/\/h\/mcp\/connect\?t=1&s=linear"/)
  for (const v of ['mcp_test:linear', 'mcp_allow:linear', 'mcp_off:linear', 'mcp_off:wiki'])
    assert.ok(admin.includes(`"value":"${v}"`), v)
  assert.ok(!admin.includes('mcp_test:wiki'), 'not authorized: nothing to test')
  assert.match(
    admin,
    /"action_id":"mcp_add_notion".*?"url":"https:\/\/h\/mcp\/connect\?t=1&s=notion"/
  )
  assert.match(admin, /"action_id":"mcp_add_custom"/)
  assert.ok(
    !admin.includes('mcp_add_linear') && !admin.includes('mcp_add_datadog'),
    'connected: no Connect'
  )
  assert.ok(!admin.includes('"style":"danger"'), 'no red buttons')
  const table = view(true, 'table')
  assert.match(table, /`a\/one`"\},\{"type":"mrkdwn","text":"no tools"/)
  assert.match(table, /`b\/two`".*?linear.png.*?datadog.png.*?"Linear, Datadog"/)
  assert.ok(!admin.includes(linear.secret!) && !admin.includes('lin_oauth_SECRET'))
  const member = view(false, 'tools')
  assert.ok(!member.includes('mcp_add_') && !member.includes('home_menu'))
  assert.match(member, /2 of 3 tools usable/)
  assert.equal(
    toolStatus({ ...linear, allow: ['create_issue'] }),
    ':white_check_mark: 3 of 3 tools usable, 1 of them allowed by an admin'
  )
  const off = confirmModal('mcp_off:linear', 'Linear')!
  validView(off)
  assert.match(JSON.stringify(off.blocks), /Disconnect \*Linear\*\?/)
  assert.deepEqual(verbOf('mcp_off:my-server'), ['mcp_off', 'my-server'])
  assert.equal(confirmModal('mcp_test:linear'), undefined, 'Test asks nothing')
})

test('connecting Datadog or a custom server, and the allowed tools', () => {
  assert.ok(JSON.stringify(connectModal('datadog')).includes('datadoghq.eu'))
  const dd = readConnect('datadog', {
    site: { site: sel('datadoghq.eu') },
    api: { api: { value: ' key1 ' } },
    app: { app: { value: 'key2' } }
  })
  assert.deepEqual(dd, {
    conn: {
      id: 'datadog',
      name: 'Datadog',
      url: 'https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp',
      auth: 'headers'
    },
    headers: { DD_API_KEY: 'key1', DD_APPLICATION_KEY: 'key2' }
  })
  assert.deepEqual(Object.keys((readConnect('datadog', {}) as { errors: object }).errors).sort(), [
    'api',
    'app',
    'site'
  ])
  const custom = (name: string, url: string, headers = ''): Values => ({
    name: { name: { value: name } },
    url: { url: { value: url } },
    headers: { headers: { value: headers } }
  })
  const sg = readConnect(
    'custom',
    custom('Source Graph!', 'https://sg.example.com/mcp', 'Authorization: Bearer t'),
    ['source-graph']
  )
  assert.ok('conn' in sg)
  assert.deepEqual(sg.conn, {
    id: 'source-graph-2',
    name: 'Source Graph!',
    url: 'https://sg.example.com/mcp',
    auth: 'headers'
  })
  const signIn = readConnect('custom', custom('Linear', 'https://mcp.linear.app/mcp'))
  assert.ok('conn' in signIn && signIn.conn.auth === 'oauth' && signIn.conn.id === 'linear-2')
  const bad = readConnect('custom', custom('', 'http://x', 'nope'))
  assert.deepEqual(Object.keys((bad as { errors: object }).errors).sort(), [
    'headers',
    'name',
    'url'
  ])
  const allow = JSON.stringify(allowModal({ ...linear, allow: ['create_issue'] }))
  assert.match(allow, /marks 2 of its tools read-only/)
  assert.ok(allow.includes('"initial_options":[{"value":"create_issue"'))
  assert.ok(!allow.includes('"value":"list_issues"'))
})

test('keyed hands each seat its tools for the turn, and the root message names them', async () => {
  const got: Record<string, string[]> = {}
  const run: typeof runMember = async (_cli, a, _d, key) => {
    got[key] = (a.tools ?? []).map((t) => t.name)
    return { text: 'ok' }
  }
  const fake = (name: string): never => ({ name }) as never
  const r = keyed('sk', '/tmp/home', run, {
    tools: (who) => (who === 'whiteboard' ? [] : [fake(`linear__${who}`)])
  })
  for (const who of ['m1', 'chair', 'whiteboard'])
    await r('harness', { prompt: 'p', model: 'openrouter:a/b' }, () => {}, `meeting:${who}`)
  assert.deepEqual(got, {
    'meeting:m1': ['linear__m1'],
    'meeting:chair': ['linear__chair'],
    'meeting:whiteboard': []
  })
  assert.equal(
    toolsAttached({
      opened: [{ id: 'linear', name: 'Linear', tools: 12 }],
      failed: [{ id: 'dd', name: 'Datadog', why: '401 <Unauthorized>' }]
    }),
    ':hammer_and_wrench: *Tools* Linear (12) · read-only, up to 8 calls a turn\n_Tools left out: Datadog (401 &lt;Unauthorized&gt;)_'
  )
})

test('MCP OAuth: discovery, registration, PKCE, the code for tokens, a refresh', async () => {
  const seen: Record<string, string>[] = []
  let challenge = ''
  const server = createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const json = (x: object, status = 200): void =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(x))
    let body = ''
    for await (const c of req) body += c
    const path = new URL(req.url ?? '', base).pathname
    if (path === '/.well-known/oauth-protected-resource/mcp')
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['read']
      })
    if (path === '/.well-known/oauth-authorization-server')
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      })
    if (path === '/register') return json({ ...JSON.parse(body), client_id: 'cid' }, 201)
    if (path === '/token') {
      const f = Object.fromEntries(new URLSearchParams(body))
      seen.push(f)
      if (f.grant_type === 'authorization_code') {
        const ok = createHash('sha256').update(f.code_verifier).digest('base64url') === challenge
        return ok
          ? json({
              access_token: 'at1',
              refresh_token: 'rt1',
              expires_in: 60,
              token_type: 'Bearer'
            })
          : json({ error: 'invalid_grant' }, 400)
      }
      return json({ access_token: 'at2', expires_in: 3600, token_type: 'Bearer' })
    }
    json({ error: 'not found' }, 404)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const url = `${base}/mcp`
  const redirect = 'https://consortium.example.com/mcp/callback'
  try {
    const to = new URL(
      await beginOAuth(
        { url, redirect, secret: SECRET, team: 'T1', user: 'U1', server: 'x' },
        fetch
      )
    )
    assert.equal(to.origin + to.pathname, `${base}/authorize`)
    assert.equal(to.searchParams.get('client_id'), 'cid')
    assert.equal(to.searchParams.get('redirect_uri'), redirect)
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(to.searchParams.get('resource'), url)
    assert.equal(to.searchParams.get('scope'), 'read')
    challenge = to.searchParams.get('code_challenge') ?? ''
    const state = openState(SECRET, to.searchParams.get('state') ?? '')
    assert.ok(
      state && state.team === 'T1' && state.server === 'x' && state.client.client_id === 'cid'
    )

    const now = 1_000_000
    const g = await finishOAuth({ url, redirect, code: 'the-code', state }, fetch, now)
    assert.equal(seen[0].code, 'the-code')
    assert.equal(seen[0].resource, url)
    assert.deepEqual(g.client, { client_id: 'cid' })
    assert.equal(g.tokens.access_token, 'at1')
    assert.equal(g.expiresAt, now + 60_000)

    assert.equal(await refreshed(url, { ...g, expiresAt: now + 3_600_000 }, fetch, now), undefined)
    const r = await refreshed(url, g, fetch, now)
    assert.equal(seen[1].grant_type, 'refresh_token')
    assert.equal(seen[1].refresh_token, 'rt1')
    assert.equal(r?.tokens.access_token, 'at2')
    assert.equal(r?.tokens.refresh_token, 'rt1', "a provider that doesn't rotate: the old one kept")
    await assert.rejects(
      refreshed(url, { ...g, tokens: { access_token: 'a', token_type: 'Bearer' } }, fetch, now),
      /reconnects/
    )
  } finally {
    server.close()
  }
})

test("the meeting's rules leave room for connected services in every case", async () => {
  const { intro } = await import('../src/main/prompts')
  const members = [
    { id: 'm1', cli: 'harness' as const, model: 'openrouter:x/y', persona: 'engineer' as const }
  ]
  const brief = { task: 'How is prod?', members, chairId: 'm1', maxTurns: 4 }
  for (const b of [
    brief,
    { ...brief, attachments: ['/a/b.png'] },
    { ...brief, projectPath: '/p' }
  ]) {
    const said = intro(b, members[0], { m1: 'The Engineer' })
    assert.ok(said.includes('call their read-only tools when the question needs live facts'))
    assert.ok(
      !said.includes('Do not use tools') && !said.includes('only to read the attached files')
    )
  }
})

// Slack's limits on what a view or message holds: 100 blocks, 3,000 characters a section or
// context text, 24 a title, 75 an option, 2,000 a button's value; an input's text within its cap.
function slackValid(blocks: unknown[], title?: string): void {
  assert.ok(blocks.length <= 100, `${blocks.length} blocks`)
  if (title !== undefined) assert.ok(title.length <= 24, `title ${title}`)
  const walk = (x: unknown, where: string): void => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${where}[${i}]`))
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (o.type === 'section' && o.text)
      assert.ok((o.text as { text: string }).text.length <= 3000, `${where}: section too long`)
    if (o.type === 'mrkdwn' || o.type === 'plain_text')
      assert.ok(String(o.text).length <= 3000, `${where}: text too long`)
    if (o.type === 'button' && o.value) assert.ok(String(o.value).length <= 2000, where)
    if (o.type === 'button')
      assert.ok((o.text as { text: string }).text.length <= 75, `${where}: button text`)
    if (o.type === 'overflow') {
      const opts = o.options as { value?: string; url?: string }[]
      assert.ok(opts.length >= 1 && opts.length <= 5, `${where}: ${opts.length} overflow options`)
      for (const x of opts) assert.ok(x.value && x.value.length <= 150, `${where}: option value`)
    }
    if (o.type === 'image') {
      assert.match(String(o.image_url), /^https:\/\/.+\.png$/, where)
      assert.ok(o.alt_text, `${where}: alt text`)
    }
    if (o.type === 'context')
      assert.ok((o.elements as unknown[]).length <= 10, `${where}: context elements`)
    if (o.type === 'actions')
      assert.ok((o.elements as unknown[]).length <= 25, `${where}: actions elements`)
    if (o.type === 'actions' || o.type === 'section') {
      const ids = [
        ...((o.elements as { action_id?: string }[]) ?? []),
        o.accessory as { action_id?: string }
      ]
        .map((x) => x?.action_id)
        .filter(Boolean)
      assert.equal(new Set(ids).size, ids.length, `${where}: action_ids repeat in a block`)
    }
    if (o.confirm) {
      const c = o.confirm as Record<string, { text: string }>
      assert.ok(c.title.text.length <= 100 && c.text.text.length <= 300, `${where}: confirm`)
      assert.ok(c.confirm.text.length <= 30 && c.deny.text.length <= 30, `${where}: confirm`)
    }
    if (o.type === 'modal')
      assert.ok(!o.submit || (o.submit as { text: string }).text.length <= 24, where)
    if (o.type === 'plain_text_input' && o.initial_value && o.max_length)
      assert.ok(String(o.initial_value).length <= Number(o.max_length), `${where}: over its cap`)
    if ('value' in o && 'text' in o && typeof o.text === 'object' && o.type === undefined)
      assert.ok((o.text as { text: string }).text.length <= 75, `${where}: option too long`)
    for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`)
  }
  walk(blocks, 'blocks')
}
const validView = (v: types.ModalView): void => slackValid(v.blocks, v.title.text)

test('each tool call is recorded for its seat: arguments, size, errors, secrets hidden', async () => {
  const KEY = 'sk-test-0123456789abcdef'
  const s = await fakeServer([
    { name: 'search', readOnly: true, run: (a) => `found 3 logs for ${a.q}; token ${KEY}` },
    {
      name: 'broken',
      readOnly: true,
      run: () => ({ text: 'Forbidden: logs_read_data', isError: true })
    },
    {
      name: 'slow',
      readOnly: true,
      run: () => new Promise((r) => setTimeout(() => r('late'), 300))
    }
  ])
  const box = await openToolbox(
    [{ id: 'dd', name: 'Datadog', url: s.url, headers: { authorization: `Bearer ${KEY}` } }],
    { limits: { ...LIMITS, perTurn: 3, callMs: 50 }, fetchFn: fetch }
  )
  try {
    const [search] = box.forSeat(undefined, 'm1')
    const said = String(await search.invoke({ q: `service:api ${KEY}` }))
    assert.equal(said, 'found 3 logs for service:api [secret]; token [secret]')
    const [, broken, slow] = box.forSeat(undefined, 'm2')
    assert.match(String(await broken.invoke({})), /^The tool reported an error: Forbidden/)
    assert.match(String(await slow.invoke({})), /^Datadog slow failed: .*time/i)
    await broken.invoke({})
    assert.match(String(await broken.invoke({})), /3 calls in one turn/) // refused, recorded too

    const m1 = box.take('m1')
    assert.equal(m1.length, 1)
    const [c] = m1
    assert.deepEqual(
      { ...c, ms: 0 },
      {
        who: 'm1',
        server: 'Datadog',
        tool: 'search',
        args: '{"q":"service:api [secret]"}',
        chars: said.length,
        result: said,
        ms: 0
      }
    )
    assert.ok(c.ms >= 0)
    assert.deepEqual(box.take('m1'), [], 'taken once')
    const m2 = box.take('m2')
    assert.deepEqual(
      m2.map((x) => [x.tool, !!x.error]),
      [
        ['broken', true],
        ['slow', true],
        ['broken', true],
        ['broken', true]
      ]
    )
    assert.match(m2[1].result, /time/i)
    assert.match(m2[3].result, /Tool limit reached/)
    assert.ok(!JSON.stringify(m2).includes(KEY))
  } finally {
    await box.close()
    s.close()
  }
})

test('a long result: the seat reads 8,000 characters, the record keeps its size and start', async () => {
  const s = await fakeServer([{ name: 'big', readOnly: true, run: () => 'y'.repeat(20_000) }])
  const box = await openToolbox([{ id: 'f', name: 'F', url: s.url, headers: {} }], {
    fetchFn: fetch
  })
  try {
    const [big] = box.forSeat(undefined, 'm1')
    await big.invoke({ q: 'z'.repeat(5000) })
    const [c] = box.take('m1')
    assert.equal(c.chars, 20_000)
    assert.equal(c.result.length, SHOWN.result + 1)
    assert.ok(c.args.length < SHOWN.args + 60 && c.args.includes('more characters cut'))
  } finally {
    await box.close()
    s.close()
  }
})

test("the Test button: one cheap read, its arguments from the tool's own schema", async () => {
  const now = Date.parse('2026-10-24T01:00:00Z')
  assert.deepEqual(
    testArgs(
      {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          limit: { type: 'integer' },
          sort: { type: 'string' }
        }
      },
      1,
      now
    ),
    { query: '*', from: 'now-15m', to: 'now', limit: 1 }
  )
  assert.deepEqual(
    testArgs({ properties: { start_time: { type: 'number' }, first: { type: 'number' } } }, 3, now),
    { start_time: now - 15 * 60_000, first: 3 }
  )

  const asked: Record<string, unknown>[] = []
  const KEY = 'dd-secret-api-key-123456'
  const dd = await fakeServer([
    { name: 'search_datadog_logs', readOnly: true, run: (a) => (asked.push(a), `1 log: ${KEY}`) },
    { name: 'create_monitor', readOnly: false }
  ])
  const refused = await fakeServer([], { status: 401 })
  const plain = await fakeServer([{ name: 'read', readOnly: true }])
  try {
    const headers = { DD_API_KEY: KEY }
    const ok = await testServer({ id: 'datadog', name: 'Datadog', url: dd.url, headers }, fetch)
    assert.deepEqual(asked, [{ q: '*' }]) // the fake's schema takes only q
    assert.equal(ok.connected, true)
    assert.equal(ok.tools, 2)
    assert.equal(ok.usable, 1)
    assert.equal(ok.call?.tool, 'search_datadog_logs')
    assert.equal(ok.call?.result, '1 log: [secret]')
    const missing = await testServer({ id: 'linear', name: 'Linear', url: dd.url, headers }, fetch)
    assert.match(missing.error ?? '', /doesn't list list_issues/)
    const no = await testServer(
      { id: 'datadog', name: 'Datadog', url: refused.url, headers },
      fetch
    )
    assert.equal(no.connected, false)
    assert.ok(no.error && !no.error.includes(KEY))
    const other = await testServer({ id: 'wiki', name: 'Wiki', url: plain.url, headers: {} }, fetch)
    assert.deepEqual(other, { connected: true, tools: 1, usable: 1 })

    for (const [r, id] of [
      [ok, 'datadog'],
      [missing, 'linear'],
      [no, 'datadog'],
      [other, 'wiki']
    ] as const)
      validView(testModal('Datadog', id, r))
    const shown = JSON.stringify(testModal('Datadog', 'datadog', ok))
    assert.match(shown, /Connected.*2 tools listed, 1 of them usable/)
    assert.match(
      shown,
      /search_datadog_logs.*\{&quot;q&quot;:&quot;\*&quot;\}|search_datadog_logs.*\{\\"q\\":\\"\*\\"\}/
    )
    assert.match(shown, /datadoghq\.com/)
    assert.match(JSON.stringify(testModal('Datadog', 'datadog', no)), /didn't connect/)
  } finally {
    dd.close()
    refused.close()
    plain.close()
  }
})

test("the Tool calls modal: every call within Slack's limits, nothing unescaped", () => {
  const call = (i: number): ToolCall => ({
    who: 'm1',
    server: 'Datadog <prod>',
    tool: 'search_datadog_logs',
    args: JSON.stringify({ query: '```<b>&' + 'q'.repeat(2000) }).slice(0, 1050),
    chars: 12_345,
    result: '```' + '<x>&'.repeat(500),
    ...(i % 2 && { error: true }),
    ms: 1234
  })
  const v = callsModal({
    who: 'The Researcher · turn 3',
    calls: Array.from({ length: 50 }, (_, i) => call(i))
  })
  validView(v)
  assert.equal(v.blocks.length, 41)
  const text = JSON.stringify(v)
  assert.ok(!/<b>|<x>|<prod>/.test(text), 'escaped')
  assert.match(text, /The Researcher · turn 3\* · 50 calls/)
  assert.match(text, /The first 40 are shown/)
  assert.match(
    text,
    /1\. Datadog &lt;prod&gt; · search_datadog_logs\* · 1\.2 s · 12,345 characters/
  )
  assert.match(text, /2\. .* · :x: failed/)
  // each code block opens and closes once: no fence of its own inside
  const first = (v.blocks[1] as { text: { text: string } }).text.text
  assert.equal(first.match(/```/g)?.length, 4)
})

test('the Home tab: every section valid, for admins and members, empty and fully set up', () => {
  const full = fromStore({ ...DEFAULTS, key: 'v1.k', keyHint: 'sk-or-v1-…3f9a' })
  full.lenses = { skeptic: 'Doubt <everything>. Then build.' }
  full.seats = PERSONA_IDS.map((persona, i) => ({ model: `x/m${i}`, persona }))
  const conns: Connection[] = Array.from({ length: 10 }, (_, i) => ({
    id: i < 5 ? ['linear', 'datadog', 'sentry', 'notion', 'atlassian'][i] : `s${i}`,
    name: `Server ${i}`,
    url: 'https://x',
    auth: i ? 'oauth' : 'headers',
    secret: 'v1.a.b.c',
    tools: [
      { name: 'read', readOnly: true },
      { name: 'write', readOnly: false }
    ]
  }))
  const meetings = Array.from({ length: 7 }, (_, i) => ({
    ts: `17000000${i}.0001`,
    channel: 'C1',
    user: i % 2 ? 'U1' : 'U2',
    question: `Should we <ship> ${'x'.repeat(400)}?`,
    link: `https://acme.slack.com/archives/C1/p${i}`,
    state: (['running', 'decided', 'stopped', 'failed'] as const)[i % 4],
    cost: i ? '$0.42' : '—',
    at: 1_700_000_000_000 - i * 60_000
  }))
  const everything = {
    files: false,
    install: 'https://h/slack/install',
    github: { connect: 'https://h/gh', account: 'acme', repos: 3 },
    tools: { conns, links: Object.fromEntries(conns.map((c) => [c.id, `https://h/${c.id}`])) },
    icons: 'https://h/icons',
    meetings,
    viewer: 'U1'
  }
  const empty = {
    github: { connect: 'https://h/gh' },
    tools: { conns: [] },
    icons: 'https://h/icons'
  }
  for (const [s, more] of [
    [full, everything],
    [DEFAULTS, empty],
    [DEFAULTS, {}]
  ] as const)
    for (const admin of [true, false])
      for (const section of SECTIONS) {
        const v = homeView(s, admin, admin ? 'https://h/connect' : undefined, { ...more, section })
        slackValid(v.blocks)
        const a = JSON.stringify(v)
        assert.ok(!a.includes('"style":"danger"'), 'no red buttons')
        assert.ok((a.match(/"style":"primary"/g) ?? []).length <= 1, 'one primary button')
        assert.match(a, /"action_id":"home_ask"/)
        assert.equal(a.match(/"action_id":"home_section_/g)?.length, 4)
        assert.ok(
          a.includes(
            `● ${section === 'table' ? 'The table' : section[0].toUpperCase() + section.slice(1)}`
          )
        )
        if (!admin) assert.ok(!/home_menu|persona_edit|home_table|mcp_add_/.test(a), section)
      }
  const at = (admin: boolean, section: (typeof SECTIONS)[number]): string =>
    JSON.stringify(homeView(full, admin, 'https://h/connect', { ...everything, section }))
  const personas = at(true, 'personas')
  assert.equal(personas.match(/"action_id":"persona_edit"/g)?.length, 6)
  assert.match(personas, /\*The Skeptic\* · _edited_\\nDoubt &lt;everything&gt;\."/)
  assert.ok(personas.includes(firstSentence(PERSONAS.strategist.lens)))
  assert.ok(!personas.includes(PERSONAS.strategist.lens), 'the full lens only in its modal')
  assert.equal(at(true, 'tools').match(/"value":"mcp_test:/g)?.length, 10)
  assert.match(at(true, 'table'), /:thinking_face: \*The Skeptic\* · _edited persona_/)
  const overview = at(false, 'overview')
  assert.match(overview, /Reinstall to enable files/)
  assert.equal(overview.match(/acme\.slack\.com/g)?.length, 5, 'the last five')
  assert.match(
    overview,
    /<https:\/\/acme\.slack\.com\/archives\/C1\/p1\|Should we &lt;ship&gt; x+…>/
  )
  assert.match(overview, /\|A question> from <@U2>/)
  assert.ok(!overview.includes('Should we &lt;ship&gt; x+…> from'), "others' questions stay hidden")
  assert.match(
    overview,
    /<#C1> · <!date\^1699999940\^\{date_short_pretty\} at \{time\}\|[^>]+> · :white_check_mark: decided · \$0\.42/
  )
  assert.ok(!overview.includes(':white_circle:'), 'all set up: no checklist')
  const fresh = JSON.stringify(homeView(DEFAULTS, true, 'https://h/connect', empty))
  assert.match(
    fresh,
    /:white_circle: OpenRouter key.*:white_circle: GitHub.*:white_circle: Tools.*:white_circle: Invite me to a channel/
  )
  assert.match(fresh, /"Connect OpenRouter"\},"url":"https:\/\/h\/connect"/)
  assert.match(fresh, /_None yet\._/)
  assert.match(fresh, /"image_url":"https:\/\/h\/icons\/consortium.png"/)
  for (const v of ['key_forget', 'gh_off', 'mcp_off:linear']) validView(confirmModal(v, 'Linear')!)
})

test('the persona form: prefilled, capped, and Reset to the default', () => {
  const lensOf = (v: types.ModalView): Record<string, unknown> =>
    (v.blocks.find((b) => b.block_id === 'lens') as unknown as { element: Record<string, unknown> })
      .element
  for (const p of PERSONA_IDS) validView(personaModal(p, { [p]: 'z'.repeat(1500) }))
  assert.equal(lensOf(personaModal('skeptic', { skeptic: 'Doubt.' })).initial_value, 'Doubt.')
  assert.equal(lensOf(personaModal('skeptic')).initial_value, PERSONAS.skeptic.lens)
  assert.equal(lensOf(personaModal('skeptic')).max_length, 1500)
  const v = (text: string, reset = false): Parameters<typeof readLens>[1] => ({
    lens: { lens: { value: text } },
    reset: { reset: { selected_options: reset ? [{ value: 'reset' }] : [] } }
  })
  assert.deepEqual(readLens('skeptic', v('  Doubt everything.  ')), { lens: 'Doubt everything.' })
  assert.deepEqual(readLens('skeptic', v('Doubt everything.', true)), {}, 'reset')
  assert.deepEqual(readLens('skeptic', v('   ')), {}, 'emptied')
  assert.deepEqual(readLens('skeptic', v(PERSONAS.skeptic.lens)), {}, "the default's words")
  assert.match(
    JSON.stringify(readLens('skeptic', v('z'.repeat(1501)))),
    /At most 1500 characters; this is 1501/
  )
})

test('a seat message gets a Tool calls button when its turn used tools, the decision too', async () => {
  const VOTE =
    '```json\n{"position":"Ship","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on: Record<string, (args: any) => Promise<unknown>> = {}
  const app = {
    command: (n: string, f: (typeof on)[string]) => (on[n] = f),
    event: () => {},
    message: () => {},
    action: () => {}
  } as unknown as App
  const sent: { method: string; args: Record<string, unknown> }[] = []
  let n = 0
  const make = (path: string[]): unknown =>
    new Proxy(
      async (args: Record<string, unknown>) => {
        sent.push({ method: path.join('.'), args })
        return { ts: String(++n), canvas_id: 'F1', url: 'https://x/', team_id: 'T1' }
      },
      { get: (_, k: string) => make([...path, k]) }
    )
  const run: typeof runMember = async (_cli, _a, _delta, key) => {
    if (key.endsWith(':whiteboard')) return { text: 'not a board' }
    if (key.endsWith(':chair')) return { text: '# Decision\n## Recommendation\nShip.' }
    return { text: `Ship.\n${VOTE}` }
  }
  const asked: [string, string][] = []
  const tenancy: Tenancy = {
    refuse: async () => undefined,
    maxMeetings: async () => 1,
    convene: async (_team, _channel, question) => ({
      brief: settingsBrief(
        { ...DEFAULTS, seats: DEFAULTS.seats.slice(0, 2), maxTurns: 4 },
        question
      ),
      run,
      dir: await mkdtemp(join(tmpdir(), 'calls-')),
      calls: async (who, title) => {
        asked.push([who, title])
        return who === 'm1' || who === 'chair' ? `id-${who}` : undefined
      }
    })
  }
  bridge(app, tenancy)
  await on['/consortium']({
    command: { channel_id: 'C1', user_id: 'U1', text: 'Ship it?' },
    ack: async () => {},
    respond: async () => {},
    client: make([]),
    context: { teamId: 'T1' }
  })
  const buttons = (): string[] =>
    sent
      .filter((x) => x.method === 'chat.update')
      .flatMap(
        (x) =>
          (x.args.blocks as {
            type: string
            elements?: { action_id?: string; value?: string }[]
          }[]) ?? []
      )
      .flatMap((b) => b.elements ?? [])
      .filter((e) => e.action_id === 'tool_calls')
      .map((e) => e.value!)
  for (let i = 0; i < 400 && !asked.some(([w]) => w === 'chair'); i++)
    await new Promise((r) => setTimeout(r, 5))
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(asked.slice(0, 2), [
    ['m1', 'The Strategist · turn 1'],
    ['m2', 'The Engineer · turn 2']
  ])
  assert.ok(asked.some(([w, t]) => w === 'chair' && t === 'The decision'))
  const b = buttons()
  assert.ok(b.includes('id-m1') && b.includes('id-chair'), b.join())
  assert.ok(!b.includes('id-m2'))
  for (const x of sent.filter((y) => y.method === 'chat.update' && Array.isArray(y.args.blocks)))
    slackValid(x.args.blocks as unknown[])
})
