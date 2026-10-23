import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { App, webApi, type BlockAction, type CustomRoute, type types } from '@slack/bolt'
import * as debate from './debate'
import { toBrief } from './api'
import { listModels, runMember } from './cli'
import { dataDir } from './paths'
import { bridge, type Tenancy } from './slack'
import { derive, installations, openStore, seal, tenantOf, unseal } from './store'
import { PERSONAS, PERSONA_IDS, makeLabels } from '../shared/personas'
import { splitModel, type Brief, type PersonaId } from '../shared/types'

// The Slack app anyone can add to their workspace ("Add to Slack"), hosted: many workspaces in one
// process, over HTTP, each on its own OpenRouter key. Installs and settings live in the database
// (store.ts); a workspace's admins edit its settings in the app's Home tab. Deep-agent seats only
// (the CLIs are signed in on someone's machine, not shareable), and no files: no project, no
// attachments, so the agents see nothing of this server's disk.

type Client = App['client']
type Values = Record<
  string,
  Record<string, { value?: string | null; selected_option?: { value: string } | null }>
>
export type Seat = { model: string; persona: PersonaId } // model: an OpenRouter id

export const SCOPES = [
  'app_mentions:read',
  'canvases:write',
  'channels:history',
  'chat:write',
  'chat:write.customize',
  'commands',
  'files:write',
  'groups:history',
  'users:read' // who is an admin: they edit the settings
]

export type Settings = {
  key?: string // the OpenRouter key, sealed; never shown again, never logged
  keyHint?: string // "sk-or-v1-…3f9a", enough to recognise it
  seats: Seat[] // 2–6, in seat order
  chair: number // the seat that writes the decision
  maxTurns: number
  who: 'admins' | 'everyone' // who may convene, steer and press the buttons
  maxMeetings: number // running at once in this workspace
  installer?: string // who installed it: an admin here whatever Slack says
}

// ponytail: a capable, mid-priced trio from three labs; admins change it in the Home tab
export const DEFAULTS: Settings = {
  seats: [
    { model: 'anthropic/claude-sonnet-5.5', persona: 'strategist' },
    { model: 'openai/gpt-6.1-sol', persona: 'engineer' },
    { model: 'google/gemini-3.8-flash', persona: 'researcher' }
  ],
  chair: 0,
  maxTurns: 12,
  who: 'everyone',
  maxMeetings: 3
}
const MAX_MEETINGS = 10 // the most a workspace may run at once

// A workspace's row → settings. Rows saved before seats had a persona hold model ids; those seats
// get the personas toBrief used to hand out, in seat order.
export function fromStore(row: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULTS, ...row }
  const seats = s.seats as (Seat | string)[]
  return {
    ...s,
    seats: seats.map((x, i) => (typeof x === 'string' ? { model: x, persona: PERSONA_IDS[i] } : x))
  }
}

// A workspace's table for a question: Deep-agent seats on OpenRouter, nothing else.
export function settingsBrief(s: Settings, task: string): Brief {
  return toBrief({
    task,
    members: s.seats.map(({ model, persona }) => ({
      cli: 'harness',
      model: `openrouter:${model}`,
      persona
    })),
    chairId: `m${s.chair + 1}`,
    maxTurns: s.maxTurns
  })
}

// The runner for one workspace's meetings: its key on every call (whiteboard and chair too), its
// folder for the agents' memory, no files, and anything but an OpenRouter Deep-agent refused.
// Never process.env: every workspace's meetings run side by side in this one process.
export const keyed =
  (apiKey: string, home: string, run: typeof runMember = runMember): typeof runMember =>
  async (cli, a, ...rest) => {
    if (cli !== 'harness' || splitModel(a.model).provider !== 'openrouter')
      throw new Error('Only OpenRouter Deep-agent seats run on the hosted table.')
    try {
      return await run(cli, { ...a, cwd: undefined, dirs: undefined, apiKey, home }, ...rest)
    } catch (e) {
      throw explain(e)
    }
  }

// OpenRouter's refusals, said so the workspace knows what to do.
export function explain(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e)
  if (/\b401\b|no auth credentials|invalid api key|user not found|unauthori[sz]ed/i.test(msg))
    return new Error(
      `OpenRouter refused this workspace's key (${msg}). An admin can replace it in Consortium's Home tab.`
    )
  if (/\b402\b|insufficient credits|more credits/i.test(msg))
    return new Error(
      `This workspace's OpenRouter key is out of credits (${msg}). Top it up at openrouter.ai/settings/credits.`
    )
  return e
}

// 200 = a live key, 401/403 = OpenRouter doesn't know it, 0 = no answer in time.
export async function keyStatus(key: string, ms = 2000): Promise<number> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ms)
    })
    return r.status
  } catch {
    return 0
  }
}

const hint = (key: string): string => `${key.slice(0, 9)}…${key.slice(-4)}`
const refusedKey = (status: number): boolean => status === 401 || status === 403

const ROWS = 6 // the Edit table modal's seat rows; a row with no model is an empty seat
const EMPTY = 'none' // the model select's "— empty —"

// The Edit table modal's answers → settings, or what's wrong by block. Seat rows are actions
// blocks (two selects side by side) and Slack shows errors on input blocks only, so the seats'
// errors go on the chair, right below them.
export function readTable(
  values: Values
): { table: Omit<Settings, 'key' | 'keyHint' | 'installer'> } | { errors: Record<string, string> } {
  const v = (block: string): Values[string][string] | undefined => values[block]?.[block]
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const pick = (a: string): string | undefined => values[`seat${i}`]?.[a]?.selected_option?.value
    const persona = pick('persona') as PersonaId
    const model = pick('model') ?? EMPTY
    return model === EMPTY
      ? undefined
      : { model, persona: PERSONA_IDS.includes(persona) ? persona : PERSONA_IDS[i] }
  })
  const seats = rows.filter((r): r is Seat => !!r)
  const row = Number(v('chair')?.selected_option?.value ?? 0)
  const chair = rows.slice(0, row).filter(Boolean).length // its place once empty rows are dropped
  const maxTurns = Number(v('turns')?.value)
  const maxMeetings = Number(v('max')?.value)
  const who = v('who')?.selected_option?.value === 'admins' ? 'admins' : 'everyone'
  const errors: Record<string, string> = {}
  const bad = seats.find(({ model }) => !/^[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(model))
  if (seats.length < 2) errors.chair = 'Pick a model for at least two seats.'
  else if (bad) errors.chair = `${bad.model} isn't an OpenRouter model id.`
  else if (!rows[row]) errors.chair = `Seat ${row + 1} is empty: the chair needs a model.`
  if (!Number.isInteger(maxTurns) || maxTurns < seats.length * 2 || maxTurns > 100)
    errors.turns = `A whole number from ${Math.max(4, seats.length * 2)} to 100.`
  if (!Number.isInteger(maxMeetings) || maxMeetings < 1 || maxMeetings > MAX_MEETINGS)
    errors.max = `1 to ${MAX_MEETINGS}.`
  return Object.keys(errors).length
    ? { errors }
    : { table: { seats, chair, maxTurns, who, maxMeetings } }
}

const PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  moonshotai: 'Moonshot AI',
  'z-ai': 'Z.ai',
  'meta-llama': 'Meta',
  minimax: 'MiniMax'
}
const MAX_OPTIONS = 100 // Slack's cap on a select's options

// The model select's options, grouped by provider: the main providers' newest models, taken in
// turn so each gets a share, within Slack's 100 with "— empty —" and the seats' own models
// (whatever they are) always in. `catalogue`: OpenRouter ids, newest first, as OpenRouter lists them.
export function modelGroups(
  catalogue: string[],
  keep: string[]
): { label: types.PlainTextElement; options: types.PlainTextOption[] }[] {
  const picked = new Set(keep)
  const lists = Object.keys(PROVIDERS).map((p) => catalogue.filter((id) => id.startsWith(`${p}/`)))
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let r = 0; r < longest; r++)
    for (const l of lists) if (l[r] && picked.size < MAX_OPTIONS - 1) picked.add(l[r])
  const rank = (id: string): number => {
    const i = catalogue.indexOf(id)
    return i < 0 ? catalogue.length : i
  }
  const groups = new Map<string, string[]>(Object.keys(PROVIDERS).map((p) => [p, []]))
  for (const id of [...picked].sort((a, b) => rank(a) - rank(b))) {
    const p = id.split('/')[0]
    groups.set(p, [...(groups.get(p) ?? []), id])
  }
  return [
    { label: plain('No model'), options: [option(EMPTY, '— empty —')] },
    ...[...groups]
      .filter(([, ids]) => ids.length)
      .map(([p, ids]) => ({
        label: plain(PROVIDERS[p] ?? p),
        options: ids.map((id) => option(id, id))
      }))
  ]
}

// ---------- the Home tab ----------

const plain = (text: string): types.PlainTextElement => ({ type: 'plain_text', text })
const option = (value: string, text: string): types.PlainTextOption => ({
  value,
  text: plain(text.slice(0, 75)) // Slack's cap on an option's text
})
const section = (text: string, accessory?: types.Button): types.KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
  ...(accessory && { accessory })
})
const button = (
  action_id: string,
  text: string,
  extra: Partial<types.Button> = {}
): types.Button => ({
  type: 'button',
  action_id,
  text: plain(text),
  ...extra
})

// What everyone sees; an admin also gets the buttons. `connect` = the "Connect OpenRouter" link.
export function homeView(s: Settings, admin: boolean, connect?: string): types.HomeView {
  const labels = makeLabels(s.seats.map((x, i) => ({ id: String(i), persona: x.persona })))
  const seats = s.seats
    .map((x, i) => `${i + 1}. ${labels[i]} · \`${x.model}\`${i === s.chair ? ' · *chair*' : ''}`)
    .join('\n')
  const keyButtons: types.Button[] = [
    ...(connect
      ? [button('home_connect', 'Connect OpenRouter', { url: connect, style: 'primary' })]
      : []),
    button('home_key', s.key ? 'Paste another key' : 'Paste a key'),
    ...(s.key
      ? [
          button('home_forget', 'Remove key', {
            style: 'danger',
            confirm: {
              title: plain('Remove the key?'),
              text: plain('Meetings in this workspace stop starting until an admin adds one.'),
              confirm: plain('Remove'),
              deny: plain('Keep it')
            }
          })
        ]
      : [])
  ]
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: plain('Consortium') },
      section(
        'A table of AI models that debates your question in a thread and writes the decision. Invite me to a channel, then `/consortium <question>` or mention @Consortium there. Reply in the thread to steer the meeting.'
      ),
      { type: 'divider' },
      section(
        `*OpenRouter key*\n${s.key ? `:white_check_mark: Connected (\`${s.keyHint}\`). Meetings here run on it; each one's cost is in its footer.` : ":warning: Not set: meetings can't start until an admin adds one."}`
      ),
      ...(admin ? [{ type: 'actions' as const, elements: keyButtons }] : []),
      { type: 'divider' },
      section(
        `*The table*\n${seats}\n\nTurn budget ${s.maxTurns} · up to ${s.maxMeetings} meetings at once · ${s.who === 'admins' ? 'workspace admins' : "everyone in channels I'm in"} can convene`,
        admin ? button('home_table', 'Edit') : undefined
      ),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: admin
              ? 'Only workspace admins and whoever installed Consortium can change these.'
              : 'A workspace admin can change these here.'
          }
        ]
      }
    ]
  }
}

export const keyModal = (): types.ModalView => ({
  type: 'modal',
  callback_id: 'key_modal',
  title: plain('OpenRouter key'),
  submit: plain('Save'),
  close: plain('Cancel'),
  blocks: [
    {
      type: 'input',
      block_id: 'key',
      label: plain('Key'),
      element: { type: 'plain_text_input', action_id: 'key', placeholder: plain('sk-or-v1-…') },
      hint: plain(
        "From openrouter.ai/settings/keys. It's checked with OpenRouter, then kept encrypted; this workspace's meetings run on it."
      )
    }
  ]
})

// `catalogue`: OpenRouter ids, newest first; empty = only the seats' own models to pick from.
export function tableModal(s: Settings, catalogue: string[]): types.ModalView {
  const personas = PERSONA_IDS.map((p) => option(p, PERSONAS[p].label))
  const groups = modelGroups(
    catalogue,
    s.seats.map((x) => x.model)
  )
  const models = groups.flatMap((g) => g.options)
  const free = PERSONA_IDS.filter((p) => !s.seats.some((x) => x.persona === p))
  const rows = Array.from({ length: ROWS }, (_, i): types.KnownBlock[] => {
    const seat = s.seats[i]
    const persona = seat?.persona ?? free[i - s.seats.length] ?? PERSONA_IDS[i]
    return [
      section(`*Seat ${i + 1}*`),
      {
        type: 'actions',
        block_id: `seat${i}`,
        elements: [
          {
            type: 'static_select',
            action_id: 'persona',
            options: personas,
            initial_option: personas[PERSONA_IDS.indexOf(persona)]
          },
          {
            type: 'static_select',
            action_id: 'model',
            option_groups: groups,
            initial_option: models.find((o) => o.value === (seat?.model ?? EMPTY))
          }
        ]
      }
    ]
  })
  const seatOptions = Array.from({ length: ROWS }, (_, i) => option(String(i), `Seat ${i + 1}`))
  const whoOptions = [
    option('everyone', "Everyone in channels I'm in"),
    option('admins', 'Workspace admins only')
  ]
  return {
    type: 'modal',
    callback_id: 'table_modal',
    title: plain('The table'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: "Two to six seats: a persona and an OpenRouter model each. Set a seat's model to — empty — to leave it out."
          }
        ]
      },
      ...rows.flat(),
      {
        type: 'input',
        block_id: 'chair',
        label: plain('Chair (writes the decision)'),
        element: {
          type: 'static_select',
          action_id: 'chair',
          options: seatOptions,
          initial_option: seatOptions[s.chair]
        }
      },
      {
        type: 'input',
        block_id: 'turns',
        label: plain('Turn budget'),
        element: {
          type: 'number_input',
          action_id: 'turns',
          is_decimal_allowed: false,
          min_value: '4',
          max_value: '100',
          initial_value: String(s.maxTurns)
        },
        hint: plain('Turns across all seats; at least two per seat. More turns, more cost.')
      },
      {
        type: 'input',
        block_id: 'who',
        label: plain('Who can convene, steer and press the buttons'),
        element: {
          type: 'radio_buttons',
          action_id: 'who',
          options: whoOptions,
          initial_option: whoOptions[s.who === 'admins' ? 1 : 0]
        }
      },
      {
        type: 'input',
        block_id: 'max',
        label: plain('Meetings at once'),
        element: {
          type: 'number_input',
          action_id: 'max',
          is_decimal_allowed: false,
          min_value: '1',
          max_value: String(MAX_MEETINGS),
          initial_value: String(s.maxMeetings)
        }
      }
    ]
  }
}

// ---------- signed links ----------

// "This admin of this workspace", signed, for an hour: the Connect OpenRouter link carries it.
export function signLink(secret: string, team: string, user: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ team, user, exp: now + 3_600_000 })).toString(
    'base64url'
  )
  return `${body}.${createHmac('sha256', derive(secret, 'link')).update(body).digest('base64url')}`
}

export function readLink(
  secret: string,
  token: string,
  now = Date.now()
): { team: string; user: string } | undefined {
  const [body, sig] = token.split('.')
  if (!body || !sig) return undefined
  const want = createHmac('sha256', derive(secret, 'link')).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return p.exp > now ? { team: p.team, user: p.user } : undefined
}

// ---------- pages ----------

const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function page(res: ServerResponse, status: number, title: string, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1d1c1d}a{color:#1264a3}</style><h1>${escHtml(title)}</h1>${html}`
  )
}

const LANDING = `<p>A table of AI models that debates your question in a Slack thread, live, and writes the decision. It runs on your workspace's own OpenRouter key: you pick the models, you pay OpenRouter directly.</p>
<p><a href="/slack/install"><img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"></a></p>
<p>After installing, open Consortium's <b>Home</b> tab in Slack to connect OpenRouter. <a href="/privacy">Privacy</a></p>`

// PLACEHOLDER: replace with your own policy (and contact) before listing in the Slack Marketplace.
const PRIVACY = `<p><b>Placeholder: replace this page before you publish the app.</b></p>
<p>What this service keeps, per Slack workspace: the installation (its bot token, encrypted), its settings and OpenRouter key (the key encrypted), and each meeting's transcript and decision. Questions, thread replies and the table's answers are sent to OpenRouter and to the model providers the workspace picked, under their terms. Uninstalling the app deletes the workspace's installation, settings, key and transcripts.</p>
<p>Contact: <i>you@example.com</i></p>`

// ---------- the server ----------

export async function serveHosted(): Promise<App> {
  const e = process.env
  const secret = e.CONSORTIUM_SECRET ?? ''
  const base = (e.PUBLIC_URL ?? '').replace(/\/+$/, '')
  if (secret.length < 32)
    throw new Error(
      'Set CONSORTIUM_SECRET to 32+ random characters (openssl rand -base64 32): it encrypts the keys and tokens at rest'
    )
  if (!/^https?:\/\//.test(base))
    throw new Error(
      'Set PUBLIC_URL to where Slack reaches this server, like https://consortium.example.com'
    )
  const store = await openStore(e.DATABASE_URL!)
  debate.configure(dataDir())
  void listModels('harness') // warm the catalogue: the Edit table modal's model selects list it

  const load = async (team: string): Promise<Settings> =>
    fromStore(await store.get<Partial<Settings>>('settings', team))
  const save = (team: string, s: Settings): Promise<void> => store.put('settings', team, s)
  const teamDir = (team: string): string => {
    if (!/^[A-Z0-9]+$/.test(team)) throw new Error(`not a workspace id: ${team}`)
    return join(dataDir(), 'teams', team)
  }
  const isAdmin = async (client: Client, user: string, s: Settings): Promise<boolean> => {
    if (user === s.installer) return true
    try {
      const { user: u } = await client.users.info({ user })
      return !!(u?.is_admin || u?.is_owner)
    } catch {
      return false
    }
  }
  const installStore = installations(store, secret, async (team, i) => {
    if (i.user?.id) await save(team, { ...(await load(team)), installer: i.user.id })
  })
  // ponytail: OpenRouter's list is fetched once per process (cli.ts), so models released since
  // show up after a restart; a TTL there if the server runs for weeks between deploys
  const catalogue = (): Promise<string[]> =>
    Promise.race([
      listModels('harness').then((ids) =>
        ids.filter((id) => id.startsWith('openrouter:')).map((id) => id.slice(11))
      ),
      // a modal must open within 3 s of the click: without the catalogue, the seats' own models
      new Promise<string[]>((r) => setTimeout(() => r([]), 1500))
    ])

  const tenancy: Tenancy = {
    refuse: async (team, user, client) => {
      const s = await load(team)
      if (s.who === 'everyone' || (await isAdmin(client, user, s))) return undefined
      return 'Only workspace admins can use Consortium here. An admin can open it to everyone in its Home tab.'
    },
    maxMeetings: async (team) => (await load(team)).maxMeetings,
    convene: async (team, _channel, question) => {
      const s = await load(team)
      if (!s.key)
        throw new Error(
          "this workspace has no OpenRouter key yet. An admin adds one in Consortium's Home tab."
        )
      let key: string
      try {
        key = unseal(s.key, secret, team)
      } catch {
        throw new Error(
          "the saved OpenRouter key can't be read (was CONSORTIUM_SECRET changed?). An admin can add it again in the Home tab."
        )
      }
      if (refusedKey(await keyStatus(key, 5000)))
        throw new Error(
          "OpenRouter refused this workspace's key. An admin can replace it in Consortium's Home tab."
        )
      const dir = teamDir(team)
      return { brief: settingsBrief(s, question), run: keyed(key, dir), dir }
    },
    forget: async (team) => {
      await store.del('installation', team)
      await store.del('settings', team)
      rmSync(teamDir(team), { recursive: true, force: true })
    }
  }

  // ponytail: PKCE flows in memory, so one instance; a restart mid-flow means connecting again
  const pending = new Map<string, { team: string; user: string; verifier: string; exp: number }>()
  const routes: CustomRoute[] = [
    {
      path: '/',
      method: 'GET',
      handler: (_req, res) => page(res, 200, 'Consortium for Slack', LANDING)
    },
    { path: '/privacy', method: 'GET', handler: (_req, res) => page(res, 200, 'Privacy', PRIVACY) },
    { path: '/health', method: 'GET', handler: (_req, res) => void res.writeHead(200).end('ok') },
    {
      // OpenRouter's OAuth with PKCE: openrouter.ai/docs/use-cases/oauth-pkce
      path: '/openrouter/connect',
      method: 'GET',
      handler: (req, res) => {
        const who = readLink(secret, new URL(req.url ?? '', base).searchParams.get('t') ?? '')
        if (!who)
          return page(
            res,
            400,
            'Link expired',
            "<p>Open Consortium's Home tab in Slack and press Connect OpenRouter again.</p>"
          )
        const now = Date.now()
        for (const [k, p] of pending) if (p.exp < now) pending.delete(k)
        const verifier = randomBytes(32).toString('base64url')
        const state = randomBytes(16).toString('hex')
        pending.set(state, { ...who, verifier, exp: now + 10 * 60_000 })
        const to = new URL('https://openrouter.ai/auth')
        to.searchParams.set('callback_url', `${base}/openrouter/callback/${state}`)
        to.searchParams.set(
          'code_challenge',
          createHash('sha256').update(verifier).digest('base64url')
        )
        to.searchParams.set('code_challenge_method', 'S256')
        to.searchParams.set('key_label', 'Consortium for Slack')
        res.writeHead(302, { location: to.href }).end()
      }
    },
    {
      path: '/openrouter/callback/:state',
      method: 'GET',
      handler: async (req, res) => {
        const state = String(req.params?.state ?? '')
        const p = pending.get(state)
        pending.delete(state)
        const code = new URL(req.url ?? '', base).searchParams.get('code')
        if (!p || p.exp < Date.now() || !code)
          return page(
            res,
            400,
            'Link expired',
            "<p>Open Consortium's Home tab in Slack and press Connect OpenRouter again.</p>"
          )
        try {
          const r = await fetch('https://openrouter.ai/api/v1/auth/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              code,
              code_verifier: p.verifier,
              code_challenge_method: 'S256'
            }),
            signal: AbortSignal.timeout(15_000)
          })
          const { key } = (await r.json().catch(() => ({}))) as { key?: string }
          if (!r.ok || !key) throw new Error(`OpenRouter answered ${r.status} without a key`)
          await save(p.team, {
            ...(await load(p.team)),
            key: seal(key, secret, p.team),
            keyHint: hint(key)
          })
          const { bot } = await installStore.fetchInstallation({
            teamId: p.team,
            enterpriseId: undefined,
            isEnterpriseInstall: false
          })
          await publishHome(new webApi.WebClient(bot?.token), p.team, p.user).catch(() => {})
          page(
            res,
            200,
            'Connected',
            '<p>OpenRouter is connected. Back in Slack, the Home tab shows the key.</p>'
          )
        } catch (err) {
          page(
            res,
            502,
            "Couldn't connect",
            `<p>${escHtml(err instanceof Error ? err.message : String(err))}. Try again from the Home tab, or paste a key there.</p>`
          )
        }
      }
    }
  ]

  const app = new App({
    signingSecret: e.SLACK_SIGNING_SECRET,
    clientId: e.SLACK_CLIENT_ID,
    clientSecret: e.SLACK_CLIENT_SECRET,
    stateSecret: derive(secret, 'slack-state').toString('base64url'),
    scopes: SCOPES,
    installationStore: installStore,
    redirectUri: `${base}/slack/oauth_redirect`,
    installerOptions: { directInstall: true, redirectUriPath: '/slack/oauth_redirect' },
    customRoutes: routes
  })
  bridge(app, tenancy)

  async function publishHome(client: Client, team: string, user: string): Promise<void> {
    const s = await load(team)
    const admin = await isAdmin(client, user, s)
    const connect = admin
      ? `${base}/openrouter/connect?t=${signLink(secret, team, user)}`
      : undefined
    await client.views.publish({ user_id: user, view: homeView(s, admin, connect) })
  }
  // an admin's settings action: the settings, or nothing for anyone else
  const asAdmin = async (
    client: Client,
    team: string,
    user: string
  ): Promise<Settings | undefined> => {
    const s = await load(team)
    return (await isAdmin(client, user, s)) ? s : undefined
  }

  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab === 'home') await publishHome(client, tenantOf(context), event.user)
  })
  app.action('home_connect', async ({ ack }) => ack()) // a link: the browser does the rest
  app.action<BlockAction>('home_key', async ({ ack, body, client, context }) => {
    await ack()
    if (await asAdmin(client, tenantOf(context), body.user.id))
      await client.views.open({ trigger_id: body.trigger_id, view: keyModal() })
  })
  app.action<BlockAction>('home_table', async ({ ack, body, client, context }) => {
    await ack()
    const s = await asAdmin(client, tenantOf(context), body.user.id)
    if (s)
      await client.views.open({
        trigger_id: body.trigger_id,
        view: tableModal(s, await catalogue())
      })
  })
  // the seat rows' selects report each pick; the modal's Save reads them all
  app.action({ block_id: /^seat\d$/ }, async ({ ack }) => ack())
  app.action<BlockAction>('home_forget', async ({ ack, body, client, context }) => {
    await ack()
    const team = tenantOf(context)
    const s = await asAdmin(client, team, body.user.id)
    if (!s) return
    delete s.key
    delete s.keyHint
    await save(team, s)
    await publishHome(client, team, body.user.id)
  })
  app.view('key_modal', async ({ ack, body, view, client, context }) => {
    const team = tenantOf(context)
    const s = await asAdmin(client, team, body.user.id)
    if (!s)
      return void (await ack({
        response_action: 'errors',
        errors: { key: 'Only workspace admins can change the key.' }
      }))
    const key = (view.state.values.key?.key?.value ?? '').trim()
    const status = await keyStatus(key)
    if (status !== 200)
      return void (await ack({
        response_action: 'errors',
        errors: {
          key: refusedKey(status)
            ? "OpenRouter doesn't recognise this key."
            : "OpenRouter didn't answer in time; try again in a moment."
        }
      }))
    await ack()
    await save(team, { ...s, key: seal(key, secret, team), keyHint: hint(key) })
    await publishHome(client, team, body.user.id)
  })
  app.view('table_modal', async ({ ack, body, view, client, context }) => {
    const team = tenantOf(context)
    const s = await asAdmin(client, team, body.user.id)
    if (!s)
      return void (await ack({
        response_action: 'errors',
        errors: { chair: 'Only workspace admins can change the table.' }
      }))
    const r = readTable(view.state.values as Values)
    if ('errors' in r) return void (await ack({ response_action: 'errors', errors: r.errors }))
    await ack()
    await save(team, { ...s, ...r.table })
    await publishHome(client, team, body.user.id)
  })

  const port = Number(e.PORT ?? 3000)
  await app.start(port)
  console.log(`Consortium for Slack, hosted at ${base} (port ${port}; data: ${dataDir()})`)
  return app
}
