import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import {
  Client,
  StreamableHTTPClientTransport,
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type CallToolResult,
  type FetchLike,
  type OAuthServerInfo,
  type OAuthTokens
} from '@modelcontextprotocol/client'
import { isPrivateIp } from './agentTools'
import { seal, unseal } from './store'

// The tools a hosted workspace connects for its seats: remote MCP servers (Linear, Datadog, …),
// one connection per server for the whole workspace. A meeting opens them, hands each seat the
// tools of its servers that only read (the server marks them readOnlyHint, or an admin allowed
// them), counts and cuts the calls, and closes them when it ends. Remote only: nothing runs here.

export type Catalog = {
  id: string
  name: string
  url: string
  auth: 'oauth' | 'headers'
  blurb: string // what the seats can look up there
}

// Each one's remote MCP server, from its docs (2026-10). All five take MCP OAuth with dynamic
// client registration; Datadog's needs its admin to allow the redirect URL first, so it goes on keys.
export const CATALOG: Catalog[] = [
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    blurb: 'issues, projects, cycles'
  },
  {
    id: 'datadog',
    name: 'Datadog',
    url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    auth: 'headers',
    blurb: 'logs, metrics, monitors, incidents'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    blurb: 'errors, issues, releases'
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    blurb: 'pages and databases'
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    blurb: 'Jira and Confluence'
  }
]

// Datadog's server lives on each site's own host.
export const DATADOG_SITES = [
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com'
]
export const datadogUrl = (site: string): string =>
  `https://mcp.${site}/api/unstable/mcp-server/mcp`

// A workspace's connection to one server, as stored (kind 'mcp': the workspace's list).
export type Connection = {
  id: string // a catalogue id, or custom-…
  name: string
  url: string
  auth: 'oauth' | 'headers'
  secret?: string // a sealed Secret; unset: an OAuth server not authorized yet
  tools?: { name: string; readOnly: boolean }[] // as it listed them last
  allow?: string[] // the tools an admin allowed beyond the read-only ones
  error?: string // why it didn't connect, last time it was tried
}

export type Grant = {
  tokens: OAuthTokens
  client: { client_id: string; client_secret?: string }
  expiresAt?: number
}
// What a connection's `secret` holds: headers to send, or an OAuth grant.
export type Secret = { headers?: Record<string, string>; oauth?: Grant }

export const LIMITS = {
  perTurn: 8, // tool calls in one seat's turn
  perMeeting: 60, // in the whole meeting, every seat together
  chars: 8000, // a result longer than this is cut
  callMs: 30_000,
  openMs: 15_000 // connecting and listing a server's tools
}

// ---------- addresses ----------

// Only https, only the public internet: an admin's URL must not reach this server's own network.
export async function publicHttps(raw: string | URL): Promise<URL> {
  const u = new URL(raw)
  if (u.protocol !== 'https:') throw new Error('MCP servers must be https.')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (!ips.length || ips.some(isPrivateIp))
    throw new Error(`${u.hostname} is a local or private address, which is off limits.`)
  return u
}

// Every request to a server, its discovery and its sign-in, checked first, and each redirect
// too (a caller that handles its own redirects, like the transport, gets them as they come).
// ponytail: checked at lookup time, like fetch_url; a DNS answer that changes before the fetch slips by
export const publicFetch: FetchLike = async (url, init) => {
  let at = await publicHttps(url)
  if (init?.redirect === 'manual' || init?.redirect === 'error') return fetch(at, init)
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch(at, { ...init, redirect: 'manual' })
    const next = r.headers.get('location')
    if (r.status < 300 || r.status >= 400 || !next) return r
    at = await publicHttps(new URL(next, at))
  }
  throw new Error('Too many redirects.')
}

// ---------- tools ----------

type Listed = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

// A tool a seat may call: the server says it only reads, or an admin allowed it.
export const usable = (t: Pick<Listed, 'name' | 'annotations'>, allow: string[] = []): boolean =>
  t.annotations?.readOnlyHint === true || allow.includes(t.name)

// The name the model sees: the server's id first, so "linear__list_issues"; models take
// [A-Za-z0-9_-], 64 at most.
export const toolName = (server: string, name: string): string =>
  `${server}__${name}`.replace(/[^\w-]/g, '_').slice(0, 64)

export const clip = (s: string, max = LIMITS.chars): string =>
  s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s

// A tool's result as text: its text blocks, else its structured content; pictures named only.
export function resultText(r: CallToolResult): string {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === 'text') return c.text
    if (c.type === 'resource') return 'text' in c.resource ? c.resource.text : '(a file)'
    if (c.type === 'resource_link') return `${c.name}: ${c.uri}`
    return `(${c.type})`
  })
  const text =
    parts.join('\n').trim() || (r.structuredContent ? JSON.stringify(r.structuredContent) : '')
  return `${r.isError ? 'The tool reported an error: ' : ''}${text || '(no output)'}`
}

// A server to open for a meeting: its headers ready (an OAuth token as Authorization).
export type Open = {
  id: string
  name: string
  url: string
  headers: Record<string, string>
  allow?: string[]
}

const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, no) =>
      setTimeout(() => no(new Error(`${what} took over ${ms / 1000} s`)), ms).unref()
    )
  ])

// A server, connected, and every tool it lists.
async function connect(
  s: Pick<Open, 'url' | 'headers'>,
  fetchFn: FetchLike,
  ms: number
): Promise<{ client: Client; tools: Listed[] }> {
  const client = new Client({ name: 'consortium', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(s.url), {
    requestInit: { headers: s.headers },
    fetch: fetchFn
  })
  try {
    return await timeout(
      (async () => {
        await client.connect(transport)
        const tools: Listed[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page++) {
          const r = await client.listTools(cursor ? { cursor } : undefined)
          tools.push(...(r.tools as Listed[]))
          if (!(cursor = r.nextCursor)) break
        }
        return { client, tools }
      })(),
      ms,
      'Connecting'
    )
  } catch (e) {
    void client.close().catch(() => {})
    throw e
  }
}

// What a server answers when connected: its tools, and which only read. For the Home tab.
export async function probe(
  s: Pick<Open, 'url' | 'headers'>,
  fetchFn: FetchLike = publicFetch,
  ms = LIMITS.openMs
): Promise<NonNullable<Connection['tools']>> {
  const { client, tools } = await connect(s, fetchFn, ms)
  void client.close().catch(() => {})
  return tools.map((t) => ({ name: t.name, readOnly: usable(t) }))
}

// No secret of `secrets` in `text`: what goes to the model and to the log.
export const hide = (text: string, secrets: string[]): string =>
  secrets.reduce((t, v) => (v.length > 3 ? t.split(v).join('[secret]') : t), text)

// One call a seat made, for the people at the table to see (its message's Tool calls button):
// secrets hidden, the arguments and the result cut short.
export type ToolCall = {
  who: string // the seat that called: m1…, chair
  server: string // its name, "Datadog"
  tool: string // the server's own name for it
  args: string // compact JSON
  chars: number // the whole result's length
  result: string // its start, or what went wrong
  error?: boolean
  ms: number
}
export const SHOWN = { args: 1000, result: 300 }

// Records `fn`'s call of `tool` as `who`: its arguments, how long it took, how much came back.
export async function recorded(
  c: Pick<ToolCall, 'who' | 'server' | 'tool'>,
  args: Record<string, unknown>,
  secrets: string[],
  fn: () => Promise<{ text: string; error?: boolean }>,
  shown = SHOWN.result
): Promise<{ text: string; call: ToolCall }> {
  const at = Date.now()
  let r: { text: string; error?: boolean }
  try {
    r = await fn()
  } catch (e) {
    r = { text: e instanceof Error ? e.message : String(e), error: true }
  }
  const text = hide(r.text, secrets)
  return {
    text,
    call: {
      ...c,
      args: clip(hide(JSON.stringify(args ?? {}), secrets), SHOWN.args),
      chars: text.length,
      result: text.length > shown ? `${text.slice(0, shown)}…` : text,
      ...(r.error && { error: true }),
      ms: Date.now() - at
    }
  }
}

export type Toolbox = {
  opened: { id: string; name: string; tools: number }[]
  failed: { id: string; name: string; why: string }[]
  listed: Record<string, NonNullable<Connection['tools']>> // what each opened server listed
  // A seat's tools: those of `servers` (unset: all), with a turn's budget of their own; their
  // calls recorded as `who`'s.
  forSeat(servers?: string[], who?: string): StructuredToolInterface[]
  // The calls `who` made since it was last asked, in order.
  take(who: string): ToolCall[]
  close(): Promise<void>
}

// A meeting's servers, opened side by side; one that doesn't answer is left out, not fatal.
export async function openToolbox(
  list: Open[],
  o: { limits?: typeof LIMITS; fetchFn?: FetchLike } = {}
): Promise<Toolbox> {
  const limits = o.limits ?? LIMITS
  const secrets = list.flatMap((s) =>
    Object.values(s.headers).flatMap((v) => [v, ...v.split(' ').filter((p) => p.length >= 16)])
  )
  const tried = await Promise.allSettled(
    list.map((s) => connect(s, o.fetchFn ?? publicFetch, limits.openMs))
  )
  const opened = list.flatMap((s, i) => {
    const r = tried[i]
    return r.status === 'fulfilled' ? [{ ...s, ...r.value }] : []
  })
  const failed = list.flatMap((s, i) => {
    const r = tried[i]
    if (r.status === 'fulfilled') return []
    const why = hide(r.reason instanceof Error ? r.reason.message : String(r.reason), secrets)
    console.error(`mcp: ${s.name} didn't open: ${why}`)
    return [{ id: s.id, name: s.name, why: why.slice(0, 200) }]
  })
  let meeting = 0
  let calls: ToolCall[] = []
  return {
    opened: opened.map((s) => ({
      id: s.id,
      name: s.name,
      tools: s.tools.filter((t) => usable(t, s.allow)).length
    })),
    failed,
    listed: Object.fromEntries(
      opened.map((s) => [s.id, s.tools.map((t) => ({ name: t.name, readOnly: usable(t) }))])
    ),
    forSeat: (servers, who = '') => {
      let turn = 0
      return opened
        .filter((s) => !servers || servers.includes(s.id))
        .flatMap((s) =>
          s.tools
            .filter((t) => usable(t, s.allow))
            .map((t) =>
              tool(
                async (args: Record<string, unknown>) => {
                  const { text, call } = await recorded(
                    { who, server: s.name, tool: t.name },
                    args,
                    secrets,
                    async () => {
                      if (turn >= limits.perTurn)
                        return {
                          text: `Tool limit reached: ${limits.perTurn} calls in one turn. Answer with what you have.`,
                          error: true
                        }
                      if (meeting >= limits.perMeeting)
                        return {
                          text: `Tool limit reached: ${limits.perMeeting} calls in this meeting. Answer with what you have.`,
                          error: true
                        }
                      turn++
                      meeting++
                      try {
                        const r = (await s.client.callTool(
                          { name: t.name, arguments: args },
                          { timeout: limits.callMs }
                        )) as CallToolResult
                        return { text: resultText(r), error: !!r.isError }
                      } catch (e) {
                        const why = e instanceof Error ? e.message : String(e)
                        return { text: `${s.name} ${t.name} failed: ${why}`, error: true }
                      }
                    }
                  )
                  calls.push(call) // until the seat's turn is over and its calls are taken
                  return clip(text, limits.chars)
                },
                {
                  name: toolName(s.id, t.name),
                  description: `${s.name}: ${t.description ?? t.name}`.slice(0, 1024),
                  schema: t.inputSchema
                }
              )
            )
        )
    },
    take: (who) => {
      const mine = calls.filter((c) => c.who === who)
      calls = calls.filter((c) => c.who !== who)
      return mine
    },
    close: async () => void (await Promise.allSettled(opened.map((s) => s.client.close())))
  }
}

// What a server's Test button calls: one cheap read where there's an obvious one, else only its
// list of tools. Its arguments come from the tool's own schema: those of `want` it takes.
const TESTS: Record<string, { tool: string; limit: number }> = {
  datadog: { tool: 'search_datadog_logs', limit: 1 },
  linear: { tool: 'list_issues', limit: 3 }
}
export function testArgs(
  schema: Record<string, unknown>,
  limit: number,
  now = Date.now()
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>
  const since = now - 15 * 60_000
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(props)) {
    const num = p?.type === 'number' || p?.type === 'integer'
    if (/^(query|q|filter|search)$/i.test(k) && !num) out[k] = '*'
    else if (/^(from|start|start_time|from_time|time_from)$/i.test(k))
      out[k] = num ? since : 'now-15m'
    else if (/^(to|end|end_time|to_time|time_to)$/i.test(k)) out[k] = num ? now : 'now'
    else if (/^(limit|page_size|max_results|first|count)$/i.test(k) && num) out[k] = limit
  }
  return out
}

export type TestResult = {
  connected: boolean
  tools: number // how many it lists
  usable: number // of them, read-only or allowed
  call?: ToolCall // the read it ran, if it has one to run
  error?: string // why it didn't connect, or its read is missing
}

// A server's Test: connect, list its tools, and run its cheap read; every answer as it came.
export async function testServer(
  s: Pick<Open, 'id' | 'name' | 'url' | 'headers' | 'allow'>,
  fetchFn: FetchLike = publicFetch,
  limits = LIMITS
): Promise<TestResult> {
  const secrets = Object.values(s.headers).flatMap((v) => [
    v,
    ...v.split(' ').filter((p) => p.length >= 16)
  ])
  let box: Awaited<ReturnType<typeof connect>>
  try {
    box = await connect(s, fetchFn, limits.openMs)
  } catch (e) {
    return {
      connected: false,
      tools: 0,
      usable: 0,
      error: hide(e instanceof Error ? e.message : String(e), secrets)
    }
  }
  try {
    const out: TestResult = {
      connected: true,
      tools: box.tools.length,
      usable: box.tools.filter((t) => usable(t, s.allow)).length
    }
    const want = TESTS[s.id]
    const t = want && box.tools.find((x) => x.name === want.tool)
    if (!want) return out
    if (!t)
      return { ...out, error: `${s.name} doesn't list ${want.tool}, the tool the Test calls.` }
    const args = testArgs(t.inputSchema, want.limit)
    const { call } = await recorded(
      { who: 'test', server: s.name, tool: t.name },
      args,
      secrets,
      async () => {
        const r = (await box.client.callTool(
          { name: t.name, arguments: args },
          { timeout: limits.callMs }
        )) as CallToolResult
        return { text: resultText(r), error: !!r.isError }
      },
      1500
    )
    return { ...out, call }
  } finally {
    void box.client.close().catch(() => {})
  }
}

// ---------- OAuth ----------

// The token's audience: the server's own protected-resource metadata says it, and it must be
// this server, or a server could collect a token meant for another one.
function resourceOf(url: string, info: OAuthServerInfo): URL | undefined {
  const r = info.resourceMetadata?.resource
  if (!r) return undefined
  if (!checkResourceAllowed({ requestedResource: url, configuredResource: r }))
    throw new Error(`the server names another resource (${r}) for its tokens`)
  return new URL(r)
}

// What the sign-in carries through the provider and back: who asked, for which server, and the
// PKCE verifier, sealed (encrypted and signed) with the server secret, for 15 minutes.
type State = {
  team: string
  user: string
  server: string
  verifier: string
  client: Grant['client']
}
const STATE = 'mcp-oauth-state'

export const sealState = (secret: string, s: State, now = Date.now()): string =>
  seal(JSON.stringify({ ...s, exp: now + 15 * 60_000 }), secret, STATE)

export function openState(secret: string, token: string, now = Date.now()): State | undefined {
  try {
    const { exp, ...s } = JSON.parse(unseal(token, secret, STATE)) as State & { exp: number }
    return exp > now ? s : undefined
  } catch {
    return undefined
  }
}

// The sign-in page's address: the server's authorization server found, Consortium registered
// with it (dynamic client registration), a PKCE challenge, and `state` sealed around it all.
export async function beginOAuth(
  o: { url: string; redirect: string; secret: string; team: string; user: string; server: string },
  fetchFn: FetchLike = publicFetch
): Promise<string> {
  const info = await discoverOAuthServerInfo(o.url, { fetchFn })
  const metadata = info.authorizationServerMetadata
  if (!metadata?.registration_endpoint)
    throw new Error(
      "this server doesn't let apps register themselves (dynamic client registration). Connect it as a custom server with an API key in its headers instead."
    )
  const scope = info.resourceMetadata?.scopes_supported?.join(' ')
  const registered = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: {
      client_name: 'Consortium for Slack',
      redirect_uris: [o.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope && { scope })
    },
    fetchFn
  })
  const client = {
    client_id: registered.client_id,
    ...(registered.client_secret && { client_secret: registered.client_secret })
  }
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata,
    clientInformation: client,
    redirectUrl: o.redirect,
    scope,
    resource: resourceOf(o.url, info)
  })
  const state = sealState(o.secret, {
    team: o.team,
    user: o.user,
    server: o.server,
    verifier: codeVerifier,
    client
  })
  authorizationUrl.searchParams.set('state', state)
  return authorizationUrl.href
}

const grantOf = (tokens: OAuthTokens, client: Grant['client'], now: number): Grant => ({
  tokens,
  client,
  ...(tokens.expires_in && { expiresAt: now + tokens.expires_in * 1000 })
})

// Back from the sign-in: the code for tokens.
export async function finishOAuth(
  o: { url: string; redirect: string; code: string; iss?: string; state: State },
  fetchFn: FetchLike = publicFetch,
  now = Date.now()
): Promise<Grant> {
  const info = await discoverOAuthServerInfo(o.url, { fetchFn })
  const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientInformation: o.state.client,
    authorizationCode: o.code,
    iss: o.iss,
    codeVerifier: o.state.verifier,
    redirectUri: o.redirect,
    resource: resourceOf(o.url, info),
    fetchFn
  })
  return grantOf(tokens, o.state.client, now)
}

// A grant good for a meeting: refreshed when it expires within 5 minutes (undefined: it's fine).
export async function refreshed(
  url: string,
  g: Grant,
  fetchFn: FetchLike = publicFetch,
  now = Date.now()
): Promise<Grant | undefined> {
  if (!g.expiresAt || g.expiresAt - now > 5 * 60_000) return undefined
  if (!g.tokens.refresh_token) throw new Error('its sign-in expired: an admin reconnects it')
  const info = await discoverOAuthServerInfo(url, { fetchFn })
  const tokens = await refreshAuthorization(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientInformation: g.client,
    refreshToken: g.tokens.refresh_token,
    resource: resourceOf(url, info),
    fetchFn
  })
  // a provider that doesn't rotate refresh tokens keeps the one it gave
  return grantOf({ refresh_token: g.tokens.refresh_token, ...tokens }, g.client, now)
}

// A connection's headers for a meeting.
export const headersOf = (s: Secret): Record<string, string> =>
  s.oauth ? { authorization: `Bearer ${s.oauth.tokens.access_token}` } : (s.headers ?? {})

// "Name: value" lines → headers; what's wrong, by line.
export function parseHeaders(text: string): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const [, name, value] = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.+)$/) ?? []
    if (!name) return `"${line.slice(0, 40)}" isn't a header (Name: value).`
    out[name] = value.trim()
  }
  return out
}
