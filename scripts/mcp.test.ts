import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LIMITS,
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
  toolName,
  usable
} from '../src/main/mcp'
import { toolsLine } from '../src/main/slack'
import {
  DEFAULTS,
  allowModal,
  connectModal,
  fromStore,
  homeView,
  keyed,
  readConnect,
  readTable,
  seatTools,
  tableModal,
  toolStatus,
  toolsAttached,
  type Settings
} from '../src/main/hosted'
import { seal } from '../src/main/store'
import type { Connection } from '../src/main/mcp'
import type { runMember } from '../src/main/cli'

const SECRET = 'x'.repeat(40)

type FakeTool = {
  name: string
  readOnly?: boolean
  run?: (args: Record<string, unknown>) => Promise<string> | string
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
      const text = t?.run ? await t.run(m.params.arguments) : `ran ${m.params.name}`
      return reply({ result: { content: [{ type: 'text', text }] } })
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
  const admin = JSON.stringify(homeView(s, true, undefined, { tools: { conns, links } }))
  assert.match(admin, /\*Linear\* · :white_check_mark: 2 of 3 tools usable/)
  assert.match(admin, /Didn't connect last time: &lt;boom&gt;/)
  assert.match(admin, /\*Wiki\* · :hourglass_flowing_sand: Not authorized yet/)
  assert.match(admin, /"text":"Authorize".*?"url":"https:\/\/h\/mcp\/connect\?t=1&s=wiki"/)
  assert.match(
    admin,
    /"action_id":"mcp_add_notion".*?"url":"https:\/\/h\/mcp\/connect\?t=1&s=notion"/
  )
  assert.match(admin, /"action_id":"mcp_add_custom"/)
  assert.ok(
    !admin.includes('mcp_add_linear') && !admin.includes('mcp_add_datadog'),
    'connected: no Connect'
  )
  assert.match(admin, /The Skeptic · `a\/one` · \*chair\* · :hammer_and_wrench: no tools/)
  assert.match(admin, /`b\/two` · :hammer_and_wrench: Linear, Datadog/)
  assert.ok(!admin.includes(linear.secret!) && !admin.includes('lin_oauth_SECRET'))
  const member = JSON.stringify(homeView(s, false, undefined, { tools: { conns } }))
  assert.ok(!member.includes('mcp_add_') && !member.includes('mcp_off'))
  assert.match(member, /\*Linear\* · :white_check_mark:/)
  assert.equal(
    toolStatus({ ...linear, allow: ['create_issue'] }),
    ':white_check_mark: 3 of 3 tools usable, 1 of them allowed by an admin'
  )
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
