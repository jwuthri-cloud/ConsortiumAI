import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  App,
  webApi,
  type BlockAction,
  type ButtonAction,
  type CustomRoute,
  type StaticSelectAction,
  type types
} from '@slack/bolt'
import type { StructuredToolInterface } from '@langchain/core/tools'
import * as debate from './debate'
import { toBrief } from './api'
import { imageModels, listModels, runMember } from './cli'
import {
  MAX_FILES,
  attachedLine,
  gather,
  inline,
  kindOf,
  pixels,
  withImages,
  type SlackFile
} from './files'
import {
  MAX_REPO_KB,
  appManifest,
  clone,
  convertManifest,
  getRepo,
  githubApp,
  installationToken,
  installationsOf,
  listRepos,
  type Repo
} from './github'
import {
  CATALOG,
  DATADOG_SITES,
  LIMITS,
  beginOAuth,
  datadogUrl,
  finishOAuth,
  headersOf,
  hide,
  openState,
  openToolbox,
  parseHeaders,
  probe,
  publicHttps,
  refreshed,
  type Connection,
  type Open,
  type Secret,
  type Toolbox
} from './mcp'
import { dataDir } from './paths'
import { bridge, noticeView, openLoading, type Tenancy } from './slack'
import { derive, installations, openStore, seal, tenantOf, unseal } from './store'
import * as pages from './pages'
import { PERSONAS, PERSONA_IDS, makeLabels } from '../shared/personas'
import { splitModel, type Brief, type PersonaId } from '../shared/types'

// The Slack app anyone can add to their workspace ("Add to Slack"), hosted: many workspaces in one
// process, over HTTP, each on its own OpenRouter key. Installs and settings live in the database
// (store.ts); a workspace's admins edit its settings in the app's Home tab. Deep-agent seats only
// (the CLIs are signed in on someone's machine, not shareable). The agents read only what came
// with the question: the files attached in Slack and a GitHub repository, each in a folder made
// for that meeting and deleted when it ends; nothing else of this server's disk.

type Client = App['client']
type Values = Record<
  string,
  Record<
    string,
    {
      value?: string | null
      selected_option?: { value: string } | null
      selected_options?: { value: string }[] | null
      selected_conversation?: string | null
      files?: SlackFile[]
    }
  >
>
// model: an OpenRouter id. tools: the connected servers (ids) it may call; unset = all of them,
// whatever gets connected later (rows saved before tools existed, and the default)
export type Seat = { model: string; persona: PersonaId; tools?: string[] }

export const SCOPES = [
  'app_mentions:read',
  'canvases:write',
  'channels:history',
  'chat:write',
  'chat:write.customize',
  'commands',
  'files:read', // files attached to a question
  'files:write',
  'groups:history',
  'users:read' // who is an admin: they edit the settings
]

export type Settings = {
  key?: string // the OpenRouter key, sealed; never shown again, never logged
  keyHint?: string // "sk-or-v1-…3f9a", enough to recognise it
  seats: Seat[] // 2–6, in seat order
  chair: number // the seat that writes the decision
  clerk: string // the OpenRouter id that writes the live whiteboard
  maxTurns: number
  who: 'admins' | 'everyone' // who may convene, steer and press the buttons
  maxMeetings: number // running at once in this workspace
  installer?: string // who installed it: an admin here whatever Slack says
}

// The clerk when OpenRouter's catalogue can't be had: Anthropic's newest Haiku, small and cheap.
const HAIKU = 'anthropic/claude-haiku-5.5'
// The newest Haiku in a catalogue (OpenRouter ids, newest first), or `fallback`.
export const newestHaiku = (catalogue: string[], fallback = HAIKU): string =>
  catalogue.find((id) => /^anthropic\/claude-haiku-[\d.]+$/.test(id)) ?? fallback

// ponytail: a capable, mid-priced trio from three labs; admins change it in the Home tab
export const DEFAULTS: Settings = {
  seats: [
    { model: 'anthropic/claude-sonnet-5.5', persona: 'strategist' },
    { model: 'openai/gpt-6.1-sol', persona: 'engineer' },
    { model: 'google/gemini-3.8-flash', persona: 'researcher' }
  ],
  chair: 0,
  clerk: HAIKU,
  maxTurns: 12,
  who: 'everyone',
  maxMeetings: 3
}
const MAX_MEETINGS = 10 // the most a workspace may run at once

// A workspace's row → settings. Rows saved before seats had a persona hold model ids; those seats
// get the personas toBrief used to hand out, in seat order. Rows saved before the clerk get `clerk`.
export function fromStore(row: Partial<Settings> | undefined, clerk = HAIKU): Settings {
  const s = { ...DEFAULTS, clerk, ...row }
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
    maxTurns: s.maxTurns,
    board: { cli: 'harness', model: `openrouter:${s.clerk}` }
  })
}

// `d` is one of `roots` or inside one
const inside = (d: string, roots: string[]): boolean =>
  roots.some((r) => {
    const rel = relative(r, resolve(d))
    return !rel.startsWith('..') && !isAbsolute(rel)
  })

// What a meeting's runner may show its seats: the folders convene made for it (`mine`; any other
// folder is refused), and the attached images for the models that see (`sees`).
// `tools`: a seat's connected tools for one turn, by who calls: m1…m6, chair or whiteboard.
export type Showing = {
  mine?: string[]
  images?: string[]
  sees?: (model: string) => boolean
  tools?: (who: string) => StructuredToolInterface[]
}

// Who a runner call is for → that seat's servers: undefined = all, [] = none (the clerk).
export function seatTools(s: Settings, who: string): string[] | undefined {
  const seat = who === 'chair' ? s.seats[s.chair] : s.seats[Number(who.match(/^m(\d+)$/)?.[1]) - 1]
  return seat ? seat.tools : []
}

// The runner for one workspace's meetings: its key on every call (whiteboard and chair too), its
// folder for the agents' memory, and anything but an OpenRouter Deep-agent refused.
// Never process.env: every workspace's meetings run side by side in this one process.
export const keyed =
  (
    apiKey: string,
    home: string,
    run: typeof runMember = runMember,
    o: Showing = {}
  ): typeof runMember =>
  async (cli, a, ...rest) => {
    if (cli !== 'harness' || splitModel(a.model).provider !== 'openrouter')
      throw new Error('Only OpenRouter Deep-agent seats run on the hosted table.')
    const foreign = [a.cwd, ...(a.dirs ?? [])].find((d) => d && !inside(d, o.mine ?? []))
    if (foreign)
      throw new Error(`The hosted table reads only what was attached in Slack, not ${foreign}.`)
    // the images go with a seat's first turn (its memory keeps them) and the chair's, never the clerk's
    const show =
      !!o.images?.length &&
      !a.resume &&
      !rest[1].endsWith(':whiteboard') &&
      !!o.sees?.(splitModel(a.model).model)
    const tools = o.tools?.(rest[1].slice(rest[1].indexOf(':') + 1))
    try {
      return await run(
        cli,
        { ...a, apiKey, home, ...(show && { images: o.images }), ...(tools?.length && { tools }) },
        ...rest
      )
    } catch (e) {
      throw explain(e)
    }
  }

// The scopes an installation lacks: one made before Consortium read files has to be reinstalled.
export const missingScopes = (
  i?: { bot?: { scopes?: string[] } },
  need = ['files:read']
): string[] => need.filter((x) => !i?.bot?.scopes?.includes(x))

export const reinstallNeeded = (url: string): string =>
  `Consortium can't read files in this workspace yet: it was installed before it could. Someone allowed to install apps can <${url}|Reinstall to enable files>, then try again.`

// "repo:owner/name question" or "repo:none question": the repository for this one question. A
// power user's shortcut, said nowhere: everyone else confirms the one picked for them (repoIn).
export function repoPrefix(text: string): { repo?: string | null; text: string } {
  const [, r, rest] = text.match(/^\s*repo:\s*(none|[\w.-]+\/[\w.-]+)\s+([\s\S]+)$/i) ?? []
  return r
    ? { repo: r.toLowerCase() === 'none' ? null : r, text: rest.trim() }
    : { text: text.trim() }
}
const REPO = /^[\w.-]+\/[\w.-]+$/

// Words that name no repository, however many repositories they name a part of.
const STOP = new Set(
  `a about after all also an and any are as at be been but by can could did do does doing done each
  even ever every first for from get got had has have how i if in into is it its just last like make
  may me might more most must my need new next no not now of off old on one only or our out over same
  set should so some still than that the their them then there these they thing this those to too
  two under up us use very want was way we were what when where which who why will with would yes you
  your main master test testing repo repository project code data app`.split(/\s+/)
)
// Parts a repository's name may carry that a question doesn't say: "backend" is connectly-backend.
const GENERIC = new Set(
  'app api service server web sdk lib core js ts py go cli tool doc dev prod'.split(' ')
)
const singular = (w: string): string =>
  w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
// "ConnectlyBackend", "connectly-backend", "backend.claude" → their words, lower case, singular
const words = (s: string): string[] =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)

// How `text` names each repository (full names): `exact` when it says the whole name; else the
// parts of the name it says (`said`) of the ones that count (`of`: not the owner's, not generic).
// `loose` counts a part a word starts (or is started by), for "did you mean".
function said(
  text: string,
  repos: string[],
  loose = false
): { repo: string; exact: boolean; said: number; of: number }[] {
  const tokens = new Set(text.toLowerCase().match(/[a-z0-9][\w./-]*[a-z0-9]|[a-z0-9]/g))
  const heard = words(text).filter((w) => w.length > 2 && !STOP.has(w))
  return repos.map((repo) => {
    const [owner, name = ''] = repo.toLowerCase().split('/')
    const exact = !STOP.has(name) && (tokens.has(name) || tokens.has(repo.toLowerCase()))
    const parts = words(name).filter((p) => !owner.includes(p) && !GENERIC.has(p))
    const hit = (p: string): boolean =>
      heard.some(
        (w) =>
          w === p ||
          (loose && Math.min(w.length, p.length) > 3 && (w.startsWith(p) || p.startsWith(w)))
      )
    return { repo, exact, said: parts.filter(hit).length, of: parts.length }
  })
}

// The repository a question names: the whole name before part of one, the most parts said, then
// the most recently pushed (`repos` comes newest first). Every part that counts must be said, so
// "backend" picks connectly-backend and not backend.claude.
// ponytail: words only, no typo tolerance; the select is right there to fix a wrong pick
export function repoIn(question: string, repos: string[]): string | undefined {
  const all = said(question, repos)
  const exact = all.filter((x) => x.exact).sort((a, b) => b.repo.length - a.repo.length)[0]
  const full = all.filter((x) => x.of && x.said === x.of).sort((a, b) => b.said - a.said)[0]
  return (exact ?? full)?.repo
}

// The repository a question starts with: the one it names, else the channel's last, else none.
export const preselect = (
  question: string | undefined,
  repos: string[],
  last?: string
): string | null => (question && repoIn(question, repos)) || last || null

// The repositories closest to a name the installation can't read, best first.
export function closest(full: string, repos: string[], n = 3): string[] {
  const score = (x: ReturnType<typeof said>[number]): number =>
    x.exact ? 2 : x.said / Math.max(1, x.of)
  return said(full, repos, true)
    .filter((x) => x.exact || x.said)
    .sort((a, b) => score(b) - score(a))
    .slice(0, n)
    .map((x) => x.repo)
}

// A repository the installation can't read, in plain words: the near names it has, and who adds it.
export function unreadable(full: string, repos: string[]): string {
  const near = closest(full, repos).map((r) => `\`${r.split('/')[1]}\``)
  const mean = near.length
    ? ` Did you mean ${near.length > 1 ? `${near.slice(0, -1).join(', ')} or ${near.at(-1)}` : near[0]}?`
    : ''
  return `\`${full}\` isn't one of the repositories Consortium can read in this workspace.${mean} An admin can add repositories in Consortium's Home tab → Change repositories.`
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
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i // an OpenRouter id

// The Edit table modal's answers → settings, or what's wrong by block. Seat rows are actions
// blocks (two selects side by side) and Slack shows errors on input blocks only, so the seats'
// errors go on the chair, right below them.
// `servers`: the connected servers' ids, the Tools selects' options; a seat with all of them picked
// gets them all, later ones too.
export function readTable(
  values: Values,
  servers: string[] = []
): { table: Omit<Settings, 'key' | 'keyHint' | 'installer'> } | { errors: Record<string, string> } {
  const v = (block: string): Values[string][string] | undefined => values[block]?.[block]
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const pick = (a: string): string | undefined => values[`seat${i}`]?.[a]?.selected_option?.value
    const persona = pick('persona') as PersonaId
    const model = pick('model') ?? EMPTY
    const chose = values[`tools${i}`]?.tools?.selected_options?.map((o) => o.value)
    const tools = chose && !servers.every((id) => chose.includes(id)) ? chose : undefined
    return model === EMPTY
      ? undefined
      : {
          model,
          persona: PERSONA_IDS.includes(persona) ? persona : PERSONA_IDS[i],
          ...(tools && { tools })
        }
  })
  const seats = rows.filter((r): r is Seat => !!r)
  const row = Number(v('chair')?.selected_option?.value ?? 0)
  const chair = rows.slice(0, row).filter(Boolean).length // its place once empty rows are dropped
  const clerk = v('clerk')?.selected_option?.value ?? ''
  const maxTurns = Number(v('turns')?.value)
  const maxMeetings = Number(v('max')?.value)
  const who = v('who')?.selected_option?.value === 'admins' ? 'admins' : 'everyone'
  const errors: Record<string, string> = {}
  const bad = seats.find(({ model }) => !MODEL_ID.test(model))
  if (seats.length < 2) errors.chair = 'Pick a model for at least two seats.'
  else if (bad) errors.chair = `${bad.model} isn't an OpenRouter model id.`
  else if (!rows[row]) errors.chair = `Seat ${row + 1} is empty: the chair needs a model.`
  if (!MODEL_ID.test(clerk)) errors.clerk = 'Pick an OpenRouter model for the clerk.'
  if (!Number.isInteger(maxTurns) || maxTurns < seats.length * 2 || maxTurns > 100)
    errors.turns = `A whole number from ${Math.max(4, seats.length * 2)} to 100.`
  if (!Number.isInteger(maxMeetings) || maxMeetings < 1 || maxMeetings > MAX_MEETINGS)
    errors.max = `1 to ${MAX_MEETINGS}.`
  return Object.keys(errors).length
    ? { errors }
    : { table: { seats, chair, clerk, maxTurns, who, maxMeetings } }
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

// The rest of the Home tab: whether the install reads files (else `install`, where to reinstall),
// and GitHub when this server has it: the account connected, its repositories, admins' link.
// `tools`: the workspace's MCP connections, and (admins) each OAuth server's sign-in link by id.
export type HomeMore = {
  files?: boolean
  install?: string
  github?: { connect?: string; account?: string; repos?: number }
  tools?: { conns: Connection[]; links?: Record<string, string> }
}

const mrk = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The root message's line on the meeting's tools: what the seats can call, and what didn't open.
export function toolsAttached(box: Pick<Toolbox, 'opened' | 'failed'>): string {
  return [
    box.opened.length
      ? `:hammer_and_wrench: *Tools* ${box.opened.map((o) => `${mrk(o.name)} (${o.tools})`).join(', ')} · read-only, up to ${LIMITS.perTurn} calls a turn`
      : '',
    box.failed.length
      ? `_Tools left out: ${box.failed.map((f) => `${mrk(f.name)} (${mrk(f.why)})`).join('; ')}_`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// A connection's line in the Home tab.
export function toolStatus(c: Connection): string {
  if (!c.secret) return ':hourglass_flowing_sand: Not authorized yet'
  if (c.error) return `:warning: Didn't connect last time: ${mrk(c.error)}`
  const all = c.tools ?? []
  const n = all.filter((t) => t.readOnly || c.allow?.includes(t.name)).length
  const allowed = c.allow?.length ? `, ${c.allow.length} of them allowed by an admin` : ''
  return `:white_check_mark: ${n} of ${all.length} tools usable${allowed}`
}

// The servers a seat calls, by name: all connected ones unless it has its own list.
const seatServers = (seat: Seat, conns: Connection[]): string[] =>
  conns.filter((c) => !seat.tools || seat.tools.includes(c.id)).map((c) => c.name)

const MAX_CONNECTIONS = 10 // a workspace's MCP servers (the Home tab's blocks are capped at 100)

function toolsBlocks(t: NonNullable<HomeMore['tools']>, admin: boolean): types.KnownBlock[] {
  const links = t.links ?? {}
  const rows = t.conns.flatMap((c): types.KnownBlock[] => {
    const buttons: types.Button[] = [
      ...(c.auth === 'oauth' && links[c.id]
        ? [
            button('mcp_oauth', c.secret ? 'Reconnect' : 'Authorize', {
              url: links[c.id],
              ...(!c.secret && { style: 'primary' as const })
            })
          ]
        : []),
      ...(c.tools?.some((x) => !x.readOnly)
        ? [button('mcp_allow', 'Allowed tools', { value: c.id })]
        : []),
      button('mcp_off', 'Disconnect', {
        value: c.id,
        style: 'danger',
        confirm: {
          title: plain(`Disconnect ${c.name.slice(0, 80)}?`),
          text: plain("The table's seats stop calling its tools, and its credentials are deleted."),
          confirm: plain('Disconnect'),
          deny: plain('Keep it')
        }
      })
    ]
    return [
      section(`*${c.name}* · ${toolStatus(c)}`),
      ...(admin ? [{ type: 'actions' as const, block_id: `mcp_${c.id}`, elements: buttons }] : [])
    ]
  })
  const add = [
    ...CATALOG.filter((x) => !t.conns.some((c) => c.id === x.id)).map((x) =>
      button(`mcp_add_${x.id}`, `Connect ${x.name}`, {
        value: x.id,
        ...(x.auth === 'oauth' && links[x.id] && { url: links[x.id] })
      })
    ),
    button('mcp_add_custom', 'Custom MCP server', { value: 'custom' })
  ]
  return [
    { type: 'divider' },
    section(
      `*Tools*\n${t.conns.length ? 'Seats can look things up in these services during a meeting, with their read-only tools (and any an admin allows). Each is connected once for the whole workspace; pick which seats use which in *The table → Edit*.' : admin ? 'Connect services like Linear or Datadog, and seats can look things up in them during a meeting, read-only.' : 'No services connected. A workspace admin can connect Linear, Datadog and more here.'}`
    ),
    ...rows,
    ...(admin && t.conns.length < MAX_CONNECTIONS
      ? [{ type: 'actions' as const, block_id: 'mcp_connect', elements: add }]
      : [])
  ]
}

// What everyone sees; an admin also gets the buttons. `connect` = the "Connect OpenRouter" link.
export function homeView(
  s: Settings,
  admin: boolean,
  connect?: string,
  more: HomeMore = {}
): types.HomeView {
  const labels = makeLabels(s.seats.map((x, i) => ({ id: String(i), persona: x.persona })))
  const conns = more.tools?.conns.filter((c) => c.secret) ?? []
  const uses = (x: Seat): string => {
    if (!conns.length) return ''
    const names = seatServers(x, conns)
    return ` · :hammer_and_wrench: ${names.length ? names.join(', ') : 'no tools'}`
  }
  const seats = s.seats
    .map(
      (x, i) =>
        `${i + 1}. ${labels[i]} · \`${x.model}\`${i === s.chair ? ' · *chair*' : ''}${uses(x)}`
    )
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
  const g = more.github
  const repos =
    g?.repos === undefined ? '' : ` · ${g.repos} ${g.repos === 1 ? 'repository' : 'repositories'}`
  const githubBlocks: types.KnownBlock[] = g
    ? [
        { type: 'divider' },
        section(
          `*GitHub*\n${g.account ? `:white_check_mark: Connected to \`${g.account}\`${repos}. When you ask, Consortium picks the one your question names (or the channel's last) and you confirm it; the table reads it, read-only.` : 'Not connected. Connect a GitHub account or org, and the table can read one of its repositories, read-only, when you ask.'}`
        ),
        ...(admin && g.connect
          ? [
              {
                type: 'actions' as const,
                elements: [
                  button('home_github', g.account ? 'Change repositories' : 'Connect GitHub', {
                    url: g.connect,
                    ...(!g.account && { style: 'primary' as const })
                  }),
                  ...(g.account
                    ? [
                        button('home_github_off', 'Disconnect', {
                          style: 'danger',
                          confirm: {
                            title: plain('Disconnect GitHub?'),
                            text: plain(
                              'The table stops reading its repositories. Consortium stays installed on GitHub until you remove it there.'
                            ),
                            confirm: plain('Disconnect'),
                            deny: plain('Keep it')
                          }
                        })
                      ]
                    : [])
                ]
              }
            ]
          : [])
      ]
    : []
  return {
    type: 'home',
    blocks: [
      { type: 'header', text: plain('Consortium') },
      section(
        'A table of AI models that debates your question in a thread and writes the decision. Invite me to a channel, then `/consortium <question>` or mention @Consortium there (attach files to the mention, or use `/consortium` alone for a form). Reply in the thread to steer the meeting.'
      ),
      {
        type: 'actions',
        elements: [button('home_ask', 'New question', { style: 'primary' })]
      },
      ...(more.files === false
        ? [
            section(
              `:warning: *Files need a reinstall.* Consortium was installed before it could read files, so it can't read the ones attached to questions. <${more.install}|Reinstall to enable files>`
            )
          ]
        : []),
      { type: 'divider' },
      section(
        `*OpenRouter key*\n${s.key ? `:white_check_mark: Connected (\`${s.keyHint}\`). Meetings here run on it; each one's cost is in its footer.` : ":warning: Not set: meetings can't start until an admin adds one."}`
      ),
      ...(admin ? [{ type: 'actions' as const, elements: keyButtons }] : []),
      ...githubBlocks,
      ...(more.tools ? toolsBlocks(more.tools, admin) : []),
      { type: 'divider' },
      section(
        `*The table*\n${seats}\nClerk · \`${s.clerk}\` · writes the whiteboard\n\nTurn budget ${s.maxTurns} · up to ${s.maxMeetings} meetings at once · ${s.who === 'admins' ? 'workspace admins' : "everyone in channels I'm in"} can convene`,
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
// `servers`: the connected MCP servers, each seat's Tools select (none: no select).
export function tableModal(
  s: Settings,
  catalogue: string[],
  servers: { id: string; name: string }[] = []
): types.ModalView {
  const serverOptions = servers.map((x) => option(x.id, x.name))
  const personas = PERSONA_IDS.map((p) => option(p, PERSONAS[p].label))
  const groups = modelGroups(catalogue, [...s.seats.map((x) => x.model), s.clerk])
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
      },
      ...(serverOptions.length ? [toolsInput(i, serverOptions, seat?.tools)] : [])
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
        block_id: 'clerk',
        label: plain('Clerk (writes the whiteboard)'),
        element: {
          type: 'static_select',
          action_id: 'clerk',
          option_groups: groups.slice(1), // no "— empty —": a meeting always has a clerk
          initial_option: models.find((o) => o.value === s.clerk)
        },
        hint: plain(
          'Keeps the live whiteboard as the seats talk. A small, cheap model does it well.'
        )
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

// A seat's Tools select: its servers picked, or all of them (unset).
function toolsInput(
  i: number,
  options: types.PlainTextOption[],
  tools?: string[]
): types.KnownBlock {
  const initial = options.filter((o) => !tools || tools.includes(o.value ?? ''))
  return {
    type: 'input',
    block_id: `tools${i}`,
    optional: true,
    label: plain('Tools'),
    element: {
      type: 'multi_static_select',
      action_id: 'tools',
      placeholder: plain('No tools'),
      options,
      ...(initial.length && { initial_options: initial })
    }
  }
}

// Connecting Datadog (its site; then a sign-in, or a token) or a custom server (a name, its URL,
// headers). `callback`: the OAuth redirect a Datadog admin allow-lists once.
export function connectModal(id: string, callback = '/mcp/callback'): types.ModalView {
  const input = (
    block_id: string,
    label: string,
    hint?: string,
    extra: Partial<types.PlainTextInput> = {},
    optional = false
  ): types.KnownBlock => ({
    type: 'input',
    block_id,
    optional,
    label: plain(label),
    element: { type: 'plain_text_input', action_id: block_id, ...extra },
    ...(hint && { hint: plain(hint) })
  })
  const sites = DATADOG_SITES.map((x) => option(x, x))
  const blocks: types.KnownBlock[] =
    id === 'datadog'
      ? [
          {
            type: 'input',
            block_id: 'site',
            label: plain('Datadog site'),
            element: {
              type: 'static_select',
              action_id: 'site',
              options: sites,
              initial_option: sites[0]
            },
            hint: plain('Where your Datadog lives: the address you sign in at.')
          },
          input(
            'token',
            'Access token (optional)',
            'Leave empty to sign in with your Datadog account, like Linear. Or paste a personal or service access token: the table reads what its owner can.',
            {},
            true
          ),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Once per Datadog org, an admin turns on *MCP Access* and adds \`${callback}\` under *Organization Settings → MCP OAuth Redirect URLs*.`
              }
            ]
          }
        ]
      : [
          input('name', 'Name', 'Shown in the Home tab and before its tools, like "Sourcegraph".', {
            max_length: 24
          }),
          input('url', 'URL', "The server's remote (streamable HTTP) address, https.", {
            placeholder: plain('https://mcp.example.com/mcp')
          }),
          input(
            'headers',
            'Headers',
            'One per line, like Authorization: Bearer <token>. Leave empty for a server you sign in to (OAuth).',
            { multiline: true },
            true
          )
        ]
  return {
    type: 'modal',
    callback_id: 'mcp_modal',
    private_metadata: id,
    title: plain(id === 'datadog' ? 'Connect Datadog' : 'Custom MCP server'),
    submit: plain('Connect'),
    close: plain('Cancel'),
    blocks: [
      ...blocks,
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: "Stored encrypted, used only by this workspace's meetings. Seats call only the tools that are marked read-only, unless an admin allows more."
          }
        ]
      }
    ]
  }
}

// The connect form's answers → a connection to try, or what's wrong by block. `taken`: ids in use.
export function readConnect(
  id: string,
  values: Values,
  taken: string[] = []
):
  | { conn: Pick<Connection, 'id' | 'name' | 'url' | 'auth'>; headers: Record<string, string> }
  | { errors: Record<string, string> } {
  const v = (block: string): string => (values[block]?.[block]?.value ?? '').trim()
  if (id === 'datadog') {
    const site = values.site?.site?.selected_option?.value ?? ''
    const errors: Record<string, string> = {}
    if (!DATADOG_SITES.includes(site)) errors.site = 'Pick a site.'
    // no token: a server you sign in to, authorized from the Home tab like Linear
    const token = v('token').replace(/^Bearer\s+/i, '')
    return Object.keys(errors).length
      ? { errors }
      : {
          conn: { id, name: 'Datadog', url: datadogUrl(site), auth: token ? 'headers' : 'oauth' },
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        }
  }
  const name = v('name')
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'mcp'
  let cid = slug
  for (let n = 2; taken.includes(cid) || CATALOG.some((x) => x.id === cid); n++)
    cid = `${slug}-${n}`
  const headers = parseHeaders(v('headers'))
  const errors: Record<string, string> = {}
  if (!name) errors.name = 'Name it.'
  try {
    if (new URL(v('url')).protocol !== 'https:') errors.url = 'An https address.'
  } catch {
    errors.url = 'A full address, like https://mcp.example.com/mcp.'
  }
  if (typeof headers === 'string') errors.headers = headers
  return Object.keys(errors).length || typeof headers === 'string'
    ? { errors }
    : {
        conn: {
          id: cid,
          name,
          url: v('url'),
          auth: Object.keys(headers).length ? 'headers' : 'oauth'
        },
        headers
      }
}

// An admin's pick of a server's tools that aren't marked read-only, for the seats to call too.
export function allowModal(c: Connection): types.ModalView {
  const writes = (c.tools ?? []).filter((t) => !t.readOnly).slice(0, MAX_OPTIONS)
  const options = writes.map((t) => option(t.name, t.name))
  const initial = options.filter((o) => c.allow?.includes(o.value ?? ''))
  const reads = (c.tools ?? []).filter((t) => t.readOnly).length
  return {
    type: 'modal',
    callback_id: 'mcp_allow_modal',
    private_metadata: c.id,
    title: plain('Allowed tools'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      section(
        `*${c.name}* marks ${reads} of its tools read-only: seats can always call those. These ${writes.length} aren't marked, so they might change something in ${c.name}. Allow only the ones you're sure just read.`
      ),
      {
        type: 'input',
        block_id: 'allow',
        optional: true,
        label: plain('Also allow'),
        element: {
          type: 'multi_static_select',
          action_id: 'allow',
          placeholder: plain('None'),
          options,
          ...(initial.length && { initial_options: initial })
        }
      }
    ]
  }
}

const NONE = 'none' // the repository select's "No repository"

// The repository select's options: "No repository", then the repositories by name (the owner
// under it), newest first, within Slack's 100 and `repo` always among them; and its first pick.
export function repoOptions(
  repos: string[],
  repo?: string | null
): { options: types.PlainTextOption[]; initial: types.PlainTextOption } {
  const list = repo && !repos.includes(repo) ? [repo, ...repos] : repos
  const options = [
    option(NONE, 'No repository'),
    ...list.slice(0, MAX_OPTIONS - 1).map((r) => {
      const [owner, name] = r.split('/')
      return { ...option(r, name ?? r), description: plain(owner.slice(0, 75)) }
    })
  ]
  return { options, initial: options.find((x) => x.value === (repo ?? NONE)) ?? options[0] }
}

// The form `/consortium` opens (alone, or with a question when GitHub is connected; the Home
// tab's New question too). `question`: what they typed; `repos`: what the repository select lists
// (unset = no select), `repo` its first pick; `files`: the install reads files (else `install`,
// the reinstall link); `note`: a line under the repository.
export function askModal(o: {
  channel?: string
  question?: string
  repos?: string[]
  repo?: string | null
  files: boolean
  install: string
  note?: string
}): types.ModalView {
  const repos = o.repos && repoOptions(o.repos, o.repo)
  return {
    type: 'modal',
    callback_id: 'ask_modal',
    title: plain('Ask the table'),
    submit: plain('Start'),
    close: plain('Cancel'),
    blocks: [
      {
        type: 'input',
        block_id: 'question',
        label: plain('Question'),
        element: {
          type: 'plain_text_input',
          action_id: 'question',
          multiline: true,
          placeholder: plain('What should the table decide?'),
          ...(o.question && { initial_value: o.question.slice(0, 3000) })
        }
      },
      {
        type: 'input',
        block_id: 'channel',
        label: plain('Channel'),
        element: {
          type: 'conversations_select',
          action_id: 'channel',
          response_url_enabled: true, // where to say what went wrong, even if I'm not in it
          filter: { include: ['public', 'private'], exclude_bot_users: true },
          ...(o.channel && { initial_conversation: o.channel })
        },
        hint: plain('The meeting runs in a thread there. Invite me to it first.')
      },
      ...(repos
        ? [
            {
              type: 'input' as const,
              block_id: 'repo',
              optional: true,
              label: plain('Repository'),
              element: {
                type: 'static_select' as const,
                action_id: 'repo',
                options: repos.options,
                initial_option: repos.initial
              },
              hint: plain('The table reads it, read-only, for this meeting. Type to search.')
            }
          ]
        : []),
      ...(o.note
        ? [{ type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: o.note }] }]
        : []),
      o.files
        ? {
            type: 'input',
            block_id: 'files',
            optional: true,
            label: plain('Files'),
            element: { type: 'file_input', action_id: 'files', max_files: MAX_FILES },
            hint: plain('Text, code, PDFs and images: up to 20 MB each, images up to 5 MB.')
          }
        : section(
            `*Files*\nConsortium has to be reinstalled before it can read files. <${o.install}|Reinstall to enable files>`
          )
    ]
  }
}

// The form's answers, or what's missing by block. repo: a full name, null for none, unset when the
// form had no repository select.
export function readAsk(
  values: Values
):
  | { question: string; channel: string; repo?: string | null; files: SlackFile[] }
  | { errors: Record<string, string> } {
  const question = (values.question?.question?.value ?? '').trim()
  const channel = values.channel?.channel?.selected_conversation ?? ''
  const picked = values.repo?.repo?.selected_option?.value
  const repo = values.repo ? (picked && picked !== NONE ? picked : null) : undefined
  const errors: Record<string, string> = {}
  if (!question) errors.question = 'Ask a question.'
  if (!channel) errors.channel = 'Pick a channel.'
  return Object.keys(errors).length
    ? { errors }
    : { question, channel, repo, files: values.files?.files?.files ?? [] }
}

// What an @mention gets, only for them, when GitHub is connected: the repository select (`repo`
// first) and Start, one click when the pick is right. `id`: the question waiting on it.
export function repoPicker(o: {
  id: string
  question: string
  repos: string[]
  repo?: string | null
  files?: number
}): types.KnownBlock[] {
  const { options, initial } = repoOptions(o.repos, o.repo)
  const quoted = o.question.length > 200 ? `${o.question.slice(0, 199)}…` : o.question
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const files = o.files ? ` · ${o.files} file${o.files > 1 ? 's' : ''}` : ''
  return [
    section(
      `*Which repository should the table read?*${files}\n>${esc(quoted).replace(/\n/g, '\n>')}`
    ),
    {
      type: 'actions',
      block_id: `pick_${o.id}`,
      elements: [
        { type: 'static_select', action_id: 'pick_repo', options, initial_option: initial },
        button('pick_start', 'Start', { style: 'primary', value: o.id })
      ]
    }
  ]
}

// ---------- signed links ----------

// "This admin of this workspace", signed, for an hour: the Connect OpenRouter link carries it
// (`use` "link"), the Connect GitHub one too ("github"), each signed with a key of its own.
export function signLink(
  secret: string,
  team: string,
  user: string,
  now = Date.now(),
  use = 'link'
): string {
  const body = Buffer.from(JSON.stringify({ team, user, exp: now + 3_600_000 })).toString(
    'base64url'
  )
  return `${body}.${createHmac('sha256', derive(secret, use)).update(body).digest('base64url')}`
}

export function readLink(
  secret: string,
  token: string,
  now = Date.now(),
  use = 'link'
): { team: string; user: string } | undefined {
  const [body, sig] = token.split('.')
  if (!body || !sig) return undefined
  const want = createHmac('sha256', derive(secret, use)).update(body).digest()
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  return p.exp > now ? { team: p.team, user: p.user } : undefined
}

// ---------- pages ----------

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

const GH_COOKIE = 'consortium_gh' // the Connect GitHub link, for the trip through GitHub
const cookie = (req: IncomingMessage, name: string): string | undefined =>
  req.headers.cookie
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1)

// ---------- the server ----------

export async function serveHosted(): Promise<App> {
  const e = process.env
  const secret = e.CONSORTIUM_SECRET ?? ''
  // Render sets RENDER_EXTERNAL_URL itself, so a Render deploy needs no PUBLIC_URL
  const base = (e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '')
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
  // ponytail: OpenRouter's list is fetched once per process (cli.ts), so models released since
  // show up after a restart; a TTL there if the server runs for weeks between deploys
  let haiku = newestHaiku([]) // the clerk of rows saved before it, once the catalogue is in
  const openrouterIds = (): Promise<string[]> =>
    listModels('harness').then((ids) => {
      const c = ids.filter((id) => id.startsWith('openrouter:')).map((id) => id.slice(11))
      haiku = newestHaiku(c, haiku)
      return c
    })
  void openrouterIds() // warm the catalogue: the Edit table modal's model selects list it

  const load = async (team: string): Promise<Settings> =>
    fromStore(await store.get<Partial<Settings>>('settings', team), haiku)
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
  const catalogue = (): Promise<string[]> =>
    Promise.race([
      openrouterIds(),
      // a modal must open within 3 s of the click: without the catalogue, the seats' own models
      new Promise<string[]>((r) => setTimeout(() => r([]), 1500))
    ])
  const reinstall = `${base}/slack/install`
  const installOf = (
    team: string
  ): Promise<{ bot?: { token?: string; scopes?: string[] }; appId?: string } | undefined> =>
    installStore
      .fetchInstallation({ teamId: team, enterpriseId: undefined, isEnterpriseInstall: false })
      .catch(() => undefined)
  const readsFiles = async (team: string): Promise<boolean> =>
    !missingScopes(await installOf(team)).length
  // the workspace's OpenRouter key, checked: or what to tell them
  const liveKey = async (team: string, s: Settings): Promise<string> => {
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
    return key
  }
  // who writes the images' descriptions: the table's own model that sees, else a cheap Gemini
  const describerOf = (s: Settings, vision: string[]): string | undefined =>
    [s.clerk, ...s.seats.map((x) => x.model)].find((m) => vision.includes(m)) ??
    vision.find((m) => /^google\/gemini-[\d.]+-flash$/.test(m))
  const visionFor = async (files: SlackFile[]): Promise<string[]> =>
    files.some((f) => kindOf(f) === 'image') ? imageModels() : []

  // MCP servers (mcp.ts): the workspace's list; each secret sealed for that workspace and server
  const connsOf = async (team: string): Promise<Connection[]> =>
    (await store.get<Connection[]>('mcp', team)) ?? []
  // ponytail: read, change, write; an admin's edit and a meeting's update at the same instant: last wins
  const editConns = async (team: string, f: (l: Connection[]) => Connection[]): Promise<void> =>
    store.put('mcp', team, f(await connsOf(team)))
  const putConn = (team: string, c: Connection): Promise<void> =>
    editConns(team, (l) =>
      l.some((x) => x.id === c.id) ? l.map((x) => (x.id === c.id ? c : x)) : [...l, c]
    )
  // the servers the Edit table offers each seat: the authorized ones
  const serversOf = async (team: string): Promise<{ id: string; name: string }[]> =>
    (await connsOf(team)).filter((c) => c.secret).map(({ id, name }) => ({ id, name }))
  const sealFor = (team: string, id: string, x: Secret): string =>
    seal(JSON.stringify(x), secret, `${team}:${id}`)
  const openFor = (team: string, c: Connection): Secret =>
    JSON.parse(unseal(c.secret ?? '', secret, `${team}:${c.id}`))
  // A server's credentials for a meeting, an OAuth token about to expire refreshed first. One
  // refresh per server at a time: Notion's refresh tokens work once, and a reuse revokes the grant.
  const refreshing = new Map<string, Promise<Secret>>()
  const credentials = (team: string, c: Connection): Promise<Secret> => {
    const k = `${team}:${c.id}`
    const running = refreshing.get(k)
    if (running) return running
    const p = (async () => {
      const now = (await connsOf(team)).find((x) => x.id === c.id) ?? c // another meeting may have refreshed it
      const sec = openFor(team, now)
      const g = sec.oauth && (await refreshed(now.url, sec.oauth))
      if (!g) return sec
      await editConns(team, (l) =>
        l.map((x) => (x.id === c.id ? { ...x, secret: sealFor(team, c.id, { oauth: g }) } : x))
      )
      return { oauth: g }
    })().finally(() => refreshing.delete(k))
    refreshing.set(k, p)
    return p
  }
  // The servers a meeting's seats call, opened; what each listed (or why it didn't open) saved
  // for the Home tab. Undefined: none to open.
  const toolboxFor = async (team: string, s: Settings): Promise<Toolbox | undefined> => {
    const conns = (await connsOf(team)).filter(
      (c) => c.secret && s.seats.some((x) => !x.tools || x.tools.includes(c.id))
    )
    if (!conns.length) return undefined
    const ready = await Promise.allSettled(conns.map((c) => credentials(team, c)))
    const open: Open[] = conns.flatMap((c, i) => {
      const r = ready[i]
      return r.status === 'fulfilled'
        ? [{ id: c.id, name: c.name, url: c.url, headers: headersOf(r.value), allow: c.allow }]
        : []
    })
    const box = await openToolbox(open)
    conns.forEach((c, i) => {
      const r = ready[i]
      if (r.status === 'rejected') {
        console.error(`mcp: ${c.name}'s sign-in didn't refresh: ${msg(r.reason)}`)
        box.failed.push({
          id: c.id,
          name: c.name,
          why: `sign-in expired: ${msg(r.reason)}`.slice(0, 200)
        })
      }
    })
    await editConns(team, (l) =>
      l.map((c) => {
        const failed = box.failed.find((f) => f.id === c.id)
        if (box.listed[c.id]) return { ...c, tools: box.listed[c.id], error: undefined }
        return failed ? { ...c, error: failed.why } : c
      })
    )
    return box
  }

  // GitHub, when this server has its app (README, "Hosted")
  const github = githubApp(e)
  type Link = { installation: number; account: string } // a workspace's GitHub connection
  const linkOf = async (team: string): Promise<Link | undefined> =>
    github ? store.get<Link>('github', team) : undefined
  // ponytail: in memory for 5 minutes; repositories added since show up after that
  const listed = new Map<number, { at: number; list: Promise<{ total: number; repos: Repo[] }> }>()
  const reposOf = (installation: number): Promise<{ total: number; repos: Repo[] }> => {
    const hit = listed.get(installation)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list
    const list = installationToken(github!, installation).then(listRepos)
    list.catch(() => listed.delete(installation))
    listed.set(installation, { at: Date.now(), list })
    return list
  }
  const namesOf = (installation: number): Promise<string[]> =>
    reposOf(installation).then((r) => r.repos.map((x) => x.full_name))
  // the repository each channel asked with last, per workspace
  const lastRepos = async (team: string): Promise<Record<string, string>> =>
    (await store.get<Record<string, string>>('channel-repos', team)) ?? {}
  // the repository, cloned into `work` with a token for it alone: its folder
  const fetchRepo = async (installation: number, full: string, work: string): Promise<string> => {
    if (!REPO.test(full)) throw new Error(`\`${full}\` isn't a repository name (owner/name).`)
    let token: string
    let r: Repo
    // GitHub's own words go to the log; the person gets plain ones
    const later = (err: unknown): Error => {
      console.error(`github: ${full}:`, err instanceof Error ? err.message : err)
      return new Error(`GitHub didn't hand over \`${full}\` just now; try again in a moment.`)
    }
    try {
      token = await installationToken(github!, installation, [full.split('/')[1]])
      r = await getRepo(token, full)
    } catch (err) {
      const e = later(err)
      if (!/GitHub answered (403|404|422)\b/.test(String(err))) throw e // not a "no": try again
      throw new Error(unreadable(full, await namesOf(installation).catch(() => [])))
    }
    if (r.size > MAX_REPO_KB)
      throw new Error(
        `\`${full}\` is about ${Math.round(r.size / 1024)} MB; the table reads repositories up to 300 MB.`
      )
    const into = join(work, r.name)
    await clone(token, `https://github.com/${r.full_name}.git`, into).catch((err) => {
      throw later(err)
    })
    return into
  }

  // mentions waiting on their repository picker's Start, by the id on the button
  // ponytail: in memory, like `pending` below; a restart before Start means mentioning again
  type Waiting = {
    team: string
    user: string
    channel: string
    thread?: string
    question: string
    files?: SlackFile[]
    repo: string | null // the pick so far
    exp: number
  }
  const picks = new Map<string, Waiting>()

  const tenancy: Tenancy = {
    refuse: async (team, user, client) => {
      const s = await load(team)
      if (s.who === 'everyone' || (await isAdmin(client, user, s))) return undefined
      return 'Only workspace admins can use Consortium here. An admin can open it to everyone in its Home tab.'
    },
    maxMeetings: async (team) => (await load(team)).maxMeetings,
    // The brief with what came with the question: the files, saved in the folder the engine keeps
    // the meeting's attachments in, and the repository, cloned into a temporary folder. Both go
    // when the meeting ends (done).
    convene: async (team, channel, question, x) => {
      const s = await load(team)
      const key = await liveKey(team, s)
      const asked = repoPrefix(question)
      const files = x.files ?? []
      if (files.length && !(await readsFiles(team))) throw new Error(reinstallNeeded(reinstall))
      const link = await linkOf(team)
      const named = x.repo !== undefined ? x.repo : asked.repo // undefined: the channel's usual
      let repo =
        named !== undefined ? named : link ? ((await lastRepos(team))[channel] ?? null) : null
      if (repo && !link)
        throw new Error(
          github
            ? "this workspace hasn't connected GitHub. An admin connects it in Consortium's Home tab."
            : "this server isn't set up to read GitHub repositories."
        )
      const folder = join(dataDir(), 'attachments', x.id)
      let work: string | undefined
      // the seats' tools open while the files and the repository get ready; a failure leaves them out
      const boxing = toolboxFor(team, s).catch((err) => {
        console.error(`mcp: no tools for ${team}: ${msg(err)}`)
        return undefined
      })
      const done = (): void => {
        for (const d of [folder, work]) if (d) rmSync(d, { recursive: true, force: true })
        void boxing.then((b) => b?.close())
      }
      try {
        const what = [
          repo && `\`${repo}\``,
          files.length && `${files.length} file${files.length > 1 ? 's' : ''}`
        ].filter(Boolean)
        if (what.length)
          await x.say(`:hourglass_flowing_sand: Getting ${what.join(' and ')} ready…`)
        const vision = await visionFor(files)
        const { got, skipped } = files.length
          ? await gather(files, {
              token: x.client.token ?? '',
              key,
              reader: s.clerk,
              describer: describerOf(s, vision),
              question: asked.text
            })
          : { got: [], skipped: [] }
        const attachments = got
          .filter((g) => g.text !== undefined)
          .map((g) => {
            mkdirSync(folder, { recursive: true })
            writeFileSync(join(folder, g.file!), g.text!)
            return join(folder, g.file!)
          })
        // an image no seat sees and no model could describe reaches no one
        const blind = got.filter(
          (g) => g.image && !g.description && !s.seats.some((x) => vision.includes(x.model))
        )
        skipped.push(...blind.map((g) => `${g.name} (no model at this table could see it)`))
        let projectPath: string | undefined
        if (repo && link) {
          work = mkdtempSync(join(tmpdir(), 'consortium-'))
          try {
            projectPath = await fetchRepo(link.installation, repo, work)
          } catch (err) {
            if (named !== undefined) throw err
            // the channel's usual repository is gone: ask without it rather than not at all
            skipped.push(`${repo} (${err instanceof Error ? err.message : err})`)
            repo = null
          }
        }
        if (named !== undefined)
          await store.put('channel-repos', team, {
            ...(await lastRepos(team)),
            [channel]: named ?? undefined
          })
        const dir = teamDir(team)
        const brief: Brief = {
          ...settingsBrief(s, withImages(asked.text, got)),
          attachments: attachments.length ? attachments : undefined,
          projectPath
        }
        const box = await boxing
        const run = keyed(key, dir, runMember, {
          mine: [folder, work].filter((d): d is string => !!d),
          images: pixels(got),
          sees: (m) => vision.includes(m),
          tools: (who) => box?.forSeat(seatTools(s, who)) ?? []
        })
        const attached = [
          attachedLine(
            repo,
            got.filter((g) => !blind.includes(g)).map((g) => g.name),
            skipped
          ),
          box ? toolsAttached(box) : ''
        ]
          .filter(Boolean)
          .join('\n')
        return { brief, run, dir, question: asked.text, attached, done }
      } catch (err) {
        done()
        throw err
      }
    },
    ask: async ({ team, client, user, channel, view, question, files, thread }) => {
      const link = await linkOf(team)
      const pre = question === undefined ? undefined : repoPrefix(question)
      // a mention with no repository to pick, or one picked with repo:, starts at once
      if (!view && pre && (!link || pre.repo !== undefined)) return false
      const [last, reads] = await Promise.all([
        channel ? lastRepos(team).then((r) => r[channel]) : undefined,
        readsFiles(team)
      ])
      let repos: string[] | undefined
      let note: string | undefined
      if (github && !link)
        note = "Connect GitHub in Consortium's Home tab, and the table can read a repository."
      if (link) {
        const names = await namesOf(link.installation).catch(() => undefined)
        repos = names ?? (last ? [last] : [])
        if (!names)
          note =
            "GitHub didn't answer with the repository list: run /consortium again to see it all."
        else if (pre?.repo && !names.includes(pre.repo)) note = unreadable(pre.repo, names)
      }
      const repo = !link
        ? null
        : pre?.repo !== undefined
          ? pre.repo
          : preselect(question, repos ?? [], last)
      if (view) {
        // the loading form, opened in time by the caller, becomes the real one (no deadline now)
        const fill = (files: boolean): Promise<unknown> =>
          client.views.update({
            view_id: view,
            view: askModal({
              channel,
              question: pre?.text,
              repos,
              repo,
              files,
              install: reinstall,
              note
            })
          })
        try {
          await fill(reads)
        } catch (e) {
          // Slack has the last word on files:read: the saved scopes can say yes while the app's
          // settings never asked for it. The form without files, and the reinstall link instead.
          if (!reads || !/files:read/.test(JSON.stringify((e as { data?: unknown }).data ?? '')))
            throw e
          console.error(`slack: ${team} has no files:read after all; the form without files`)
          await fill(false)
        }
        return true
      }
      if (!channel) throw new Error('no channel to ask in')
      const now = Date.now()
      for (const [k, p] of picks) if (p.exp < now) picks.delete(k)
      const id = randomBytes(12).toString('base64url')
      picks.set(id, {
        team,
        user,
        channel: channel!,
        thread,
        question: question ?? '',
        files,
        repo,
        exp: now + 30 * 60_000 // the life of the message's response_url
      })
      await client.chat.postEphemeral({
        channel: channel!,
        user,
        thread_ts: thread,
        text: 'Which repository should the table read?',
        blocks: repoPicker({
          id,
          question: question ?? '',
          repos: repos ?? [],
          repo,
          files: files?.length
        })
      })
      return true
    },
    attach: async (team, client, files, question) => {
      if (!(await readsFiles(team))) throw new Error(reinstallNeeded(reinstall))
      const s = await load(team)
      const key = await liveKey(team, s)
      const vision = await visionFor(files)
      const { got, skipped } = await gather(files, {
        token: client.token ?? '',
        key,
        reader: s.clerk,
        describer: describerOf(s, vision),
        question
      })
      return inline(got, skipped)
    },
    forget: async (team) => {
      for (const kind of ['installation', 'settings', 'github', 'channel-repos', 'mcp'])
        await store.del(kind, team)
      rmSync(teamDir(team), { recursive: true, force: true })
    }
  }

  // ponytail: PKCE flows in memory, so one instance; a restart mid-flow means connecting again
  const pending = new Map<string, { team: string; user: string; verifier: string; exp: number }>()
  const routes: CustomRoute[] = [
    {
      path: '/',
      method: 'GET',
      handler: (_req, res) => send(res, 200, pages.landing())
    },
    { path: '/privacy', method: 'GET', handler: (_req, res) => send(res, 200, pages.privacy()) },
    { path: '/health', method: 'GET', handler: (_req, res) => void res.writeHead(200).end('ok') },
    {
      // OpenRouter's OAuth with PKCE: openrouter.ai/docs/use-cases/oauth-pkce
      path: '/openrouter/connect',
      method: 'GET',
      handler: (req, res) => {
        const who = readLink(secret, new URL(req.url ?? '', base).searchParams.get('t') ?? '')
        if (!who) return send(res, 400, pages.expired())
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
        if (!p || p.exp < Date.now() || !code) return send(res, 400, pages.expired())
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
          const { bot, appId } = await installStore.fetchInstallation({
            teamId: p.team,
            enterpriseId: undefined,
            isEnterpriseInstall: false
          })
          await publishHome(new webApi.WebClient(bot?.token), p.team, p.user).catch(() => {})
          send(res, 200, pages.connected(p.team, appId))
        } catch (err) {
          send(res, 502, pages.connectFailed(err instanceof Error ? err.message : String(err)))
        }
      }
    },
    {
      // creating the GitHub App, once, through GitHub's app-manifest flow
      path: '/github/setup',
      method: 'GET',
      handler: (_req, res) => {
        if (github) return send(res, 200, pages.githubReady(github.slug))
        const state = signLink(secret, 'setup', 'setup', Date.now(), 'github-setup')
        send(
          res,
          200,
          pages.githubSetup(
            JSON.stringify(appManifest(base)),
            `https://github.com/settings/apps/new?state=${state}`
          )
        )
      }
    },
    {
      path: '/github/created',
      method: 'GET',
      handler: async (req, res) => {
        if (github) return send(res, 200, pages.githubReady(github.slug))
        const q = new URL(req.url ?? '', base).searchParams
        const code = q.get('code')
        if (!code || !readLink(secret, q.get('state') ?? '', Date.now(), 'github-setup'))
          return send(
            res,
            400,
            pages.githubFailed('This setup link expired: open /github/setup again.')
          )
        try {
          const created = await convertManifest(code)
          // the private key and client secret, shown this once
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store'
          })
          res.end(pages.githubCreated(created))
        } catch (err) {
          send(res, 502, pages.githubFailed(err instanceof Error ? err.message : String(err)))
        }
      }
    },
    {
      // the Home tab's Connect GitHub: keep the signed link in a cookie for the trip through GitHub
      path: '/github/connect',
      method: 'GET',
      handler: (req, res) => {
        const t = new URL(req.url ?? '', base).searchParams.get('t') ?? ''
        if (!github || !readLink(secret, t, Date.now(), 'github'))
          return send(res, 400, pages.expired('Connect GitHub'))
        res
          .writeHead(302, {
            location: `https://github.com/apps/${github.slug}/installations/new?state=${encodeURIComponent(t)}`,
            'set-cookie': `${GH_COOKIE}=${t}; Path=/github; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
          })
          .end()
      }
    },
    {
      // Back from GitHub. installation_id can be forged, so the installation counts only if the
      // person who signed in to GitHub can reach it (GitHub's advice for the setup URL).
      path: '/github/callback',
      method: 'GET',
      handler: async (req, res) => {
        const q = new URL(req.url ?? '', base).searchParams
        const now = Date.now()
        const who = [q.get('state'), cookie(req, GH_COOKIE)]
          .map((t) => (t ? readLink(secret, t, now, 'github') : undefined))
          .find(Boolean)
        if (!github || !who) return send(res, 400, pages.expired('Connect GitHub'))
        if (q.get('setup_action') === 'request') return send(res, 200, pages.githubRequested())
        const inst =
          Number(q.get('installation_id') ?? q.get('state')?.match(/^i(\d+)$/)?.[1]) || undefined
        const code = q.get('code')
        if (!code) {
          // installed without signing in: sign in, and come back here with the installation
          const to = new URL('https://github.com/login/oauth/authorize')
          to.searchParams.set('client_id', github.clientId)
          to.searchParams.set('redirect_uri', `${base}/github/callback`)
          to.searchParams.set('state', `i${inst ?? ''}`)
          return void res.writeHead(302, { location: to.href }).end()
        }
        try {
          const theirs = await installationsOf(github, code)
          const pick = inst
            ? theirs.find((i) => i.id === inst)
            : theirs.length === 1
              ? theirs[0]
              : undefined
          if (!pick)
            throw new Error(
              inst
                ? "your GitHub account can't reach that installation."
                : "GitHub didn't say which installation; press Connect GitHub again."
            )
          await store.put('github', who.team, { installation: pick.id, account: pick.account })
          listed.delete(pick.id)
          const i = await installOf(who.team)
          if (i?.bot?.token)
            void publishHome(new webApi.WebClient(i.bot.token), who.team, who.user).catch(() => {})
          res.setHeader(
            'set-cookie',
            `${GH_COOKIE}=; Path=/github; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
          )
          send(res, 200, pages.githubConnected(pick.account, who.team, i?.appId))
        } catch (err) {
          send(res, 502, pages.githubFailed(err instanceof Error ? err.message : String(err)))
        }
      }
    },
    {
      // MCP OAuth (the Home tab's Connect or Authorize): the server's sign-in, then back here
      path: '/mcp/connect',
      method: 'GET',
      handler: async (req, res) => {
        const q = new URL(req.url ?? '', base).searchParams
        const who = readLink(secret, q.get('t') ?? '', Date.now(), 'mcp')
        if (!who) return send(res, 400, pages.expired('Connect'))
        const id = q.get('s') ?? ''
        const c =
          (await connsOf(who.team)).find((x) => x.id === id) ?? CATALOG.find((x) => x.id === id)
        if (c?.auth !== 'oauth')
          return send(
            res,
            400,
            pages.toolFailed('That server', "it doesn't connect with a sign-in.")
          )
        try {
          const to = await beginOAuth({
            url: c.url,
            redirect: `${base}/mcp/callback`,
            secret,
            team: who.team,
            user: who.user,
            server: c.id
          })
          res.writeHead(302, { location: to }).end()
        } catch (err) {
          send(res, 502, pages.toolFailed(c.name, msg(err)))
        }
      }
    },
    {
      path: '/mcp/callback',
      method: 'GET',
      handler: async (req, res) => {
        const q = new URL(req.url ?? '', base).searchParams
        const st = openState(secret, q.get('state') ?? '')
        if (!st) return send(res, 400, pages.expired('Connect'))
        const had = (await connsOf(st.team)).find((x) => x.id === st.server)
        const c = had ?? CATALOG.find((x) => x.id === st.server)
        if (!c) return send(res, 400, pages.expired('Connect'))
        const code = q.get('code')
        if (!code)
          return send(
            res,
            400,
            pages.toolFailed(
              c.name,
              q.get('error_description') ?? q.get('error') ?? 'no sign-in came back.'
            )
          )
        try {
          const redirect = `${base}/mcp/callback`
          const grant = await finishOAuth({
            url: c.url,
            redirect,
            code,
            iss: q.get('iss') ?? undefined,
            state: st
          })
          const sec: Secret = { oauth: grant }
          let tools: Connection['tools']
          let error: string | undefined
          try {
            tools = await probe({ url: c.url, headers: headersOf(sec) })
          } catch (err) {
            error = hide(msg(err), [grant.tokens.access_token]).slice(0, 200)
          }
          await putConn(st.team, {
            ...had,
            id: c.id,
            name: c.name,
            url: c.url,
            auth: 'oauth',
            secret: sealFor(st.team, c.id, sec),
            tools: tools ?? had?.tools,
            error
          })
          const i = await installOf(st.team)
          if (i?.bot?.token)
            void publishHome(new webApi.WebClient(i.bot.token), st.team, st.user).catch(() => {})
          send(res, 200, pages.toolConnected(c.name, st.team, i?.appId))
        } catch (err) {
          send(res, 502, pages.toolFailed(c.name, msg(err)))
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
    installerOptions: {
      directInstall: true,
      redirectUriPath: '/slack/oauth_redirect',
      // Bolt calls these after it has stored the installation (or failed to): our pages, not its
      callbackOptions: {
        success: (i, _o, _req, res) => send(res, 200, pages.installed(i.team?.id, i.appId)),
        failure: (err, _o, req, res) => {
          const sent = new URL(req.url ?? '', base).searchParams.get('error')
          const byClient = /missing_state|invalid_state|missing_code|authorization_error/.test(
            err.code
          )
          send(res, byClient ? 400 : 500, pages.installFailed(err.code, sent))
        }
      }
    },
    customRoutes: routes
  })
  const { start } = bridge(app, tenancy)

  async function publishHome(client: Client, team: string, user: string): Promise<void> {
    const s = await load(team)
    const admin = await isAdmin(client, user, s)
    const now = Date.now()
    const connect = admin
      ? `${base}/openrouter/connect?t=${signLink(secret, team, user)}`
      : undefined
    const [install, link, conns] = await Promise.all([installOf(team), linkOf(team), connsOf(team)])
    const mcp = admin ? signLink(secret, team, user, now, 'mcp') : ''
    const signIns = [...CATALOG, ...conns].filter((c) => c.auth === 'oauth').map((c) => c.id)
    const repos = link
      ? await reposOf(link.installation).then(
          (r) => r.total,
          () => undefined
        )
      : undefined
    const more: HomeMore = {
      files: !missingScopes(install).length,
      install: reinstall,
      github: github && {
        connect: admin
          ? `${base}/github/connect?t=${signLink(secret, team, user, now, 'github')}`
          : undefined,
        account: link?.account,
        repos
      },
      tools: {
        conns,
        links: admin
          ? Object.fromEntries(
              signIns.map((id) => [id, `${base}/mcp/connect?t=${mcp}&s=${encodeURIComponent(id)}`])
            )
          : undefined
      }
    }
    await client.views.publish({ user_id: user, view: homeView(s, admin, connect, more) })
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
  app.action('home_github', async ({ ack }) => ack()) // a link too
  app.action<BlockAction>('home_github_off', async ({ ack, body, client, context }) => {
    await ack()
    const team = tenantOf(context)
    if (!(await asAdmin(client, team, body.user.id))) return
    await store.del('github', team)
    await publishHome(client, team, body.user.id)
  })
  app.action<BlockAction>('home_ask', async ({ ack, body, client, context }) => {
    await ack()
    const team = tenantOf(context)
    const user = body.user.id
    // the form opens first, inside Slack's 3 s; the checks and the repository list fill it in
    const view = await openLoading(client, body.trigger_id)
    if (!view) return
    const no = await tenancy.refuse(team, user, client)
    if (no) return void (await client.views.update({ view_id: view, view: noticeView(no) }))
    await tenancy.ask!({ team, client, user, view })
  })
  // the repository select reports each pick; Start reads it
  app.action({ block_id: 'repo' }, async ({ ack }) => ack())
  // the mention's picker: each pick kept, then Start convenes with it and the mention's files
  app.action<BlockAction>('pick_repo', async ({ ack, body, action }) => {
    await ack()
    const a = action as StaticSelectAction
    const p = picks.get(a.block_id.slice(5))
    if (p && p.user === body.user.id)
      p.repo = a.selected_option.value === NONE ? null : a.selected_option.value
  })
  app.action<BlockAction>('pick_start', async ({ ack, body, action, client, context, respond }) => {
    await ack()
    const id = (action as ButtonAction).value ?? ''
    const p = picks.get(id)
    if (!p || p.exp < Date.now() || p.user !== body.user.id || p.team !== tenantOf(context))
      return void (await respond({
        replace_original: true,
        text: 'This question expired: mention me again.'
      }))
    picks.delete(id)
    const picked = (body.state?.values as Values | undefined)?.[`pick_${id}`]?.pick_repo
      ?.selected_option?.value
    const repo = picked === undefined ? p.repo : picked === NONE ? null : picked
    await respond({ delete_original: true })
    const say = (text: string): Promise<unknown> =>
      client.chat.postEphemeral({ channel: p.channel, user: p.user, thread_ts: p.thread, text })
    await start(p.team, client, p.channel, p.user, p.question, say, { files: p.files, repo })
  })
  app.view('ask_modal', async ({ ack, body, view, client, context, respond }) => {
    const r = readAsk(view.state.values as Values)
    if ('errors' in r) return void (await ack({ response_action: 'errors', errors: r.errors }))
    await ack()
    const user = body.user.id
    // the channel select's response_url reaches them there, even where I'm not invited yet
    const say = (text: string): Promise<unknown> =>
      respond
        ? respond({ response_type: 'ephemeral', text })
        : client.chat.postMessage({ channel: user, text })
    await start(tenantOf(context), client, r.channel, user, r.question, say, {
      files: r.files,
      repo: r.repo
    })
  })
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
        view: tableModal(s, await catalogue(), await serversOf(tenantOf(context)))
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
    const servers = (await serversOf(team)).map((x) => x.id)
    const r = readTable(view.state.values as Values, servers)
    if ('errors' in r) return void (await ack({ response_action: 'errors', errors: r.errors }))
    await ack()
    await save(team, { ...s, ...r.table })
    await publishHome(client, team, body.user.id)
  })

  // ---- MCP servers in the Home tab ----
  app.action('mcp_oauth', async ({ ack }) => ack()) // a link: the browser does the rest
  app.action<BlockAction>(/^mcp_add_/, async ({ ack, body, action, client, context }) => {
    await ack()
    const id = (action as ButtonAction).value ?? ''
    if (CATALOG.find((x) => x.id === id)?.auth === 'oauth') return // a link too
    if (await asAdmin(client, tenantOf(context), body.user.id))
      await client.views.open({
        trigger_id: body.trigger_id,
        view: connectModal(id, `${base}/mcp/callback`)
      })
  })
  app.action<BlockAction>('mcp_allow', async ({ ack, body, action, client, context }) => {
    await ack()
    const team = tenantOf(context)
    const c = (await connsOf(team)).find((x) => x.id === (action as ButtonAction).value)
    if (c && (await asAdmin(client, team, body.user.id)))
      await client.views.open({ trigger_id: body.trigger_id, view: allowModal(c) })
  })
  app.action<BlockAction>('mcp_off', async ({ ack, body, action, client, context }) => {
    await ack()
    const team = tenantOf(context)
    if (!(await asAdmin(client, team, body.user.id))) return
    const id = (action as ButtonAction).value
    await editConns(team, (l) => l.filter((x) => x.id !== id))
    await publishHome(client, team, body.user.id)
  })
  app.view('mcp_modal', async ({ ack, body, view, client, context }) => {
    const team = tenantOf(context)
    const where = view.private_metadata === 'datadog' ? 'site' : 'url'
    const no = (why: string): Promise<void> =>
      ack({ response_action: 'errors', errors: { [where]: why } })
    if (!(await asAdmin(client, team, body.user.id)))
      return void (await no('Only workspace admins can connect tools.'))
    const conns = await connsOf(team)
    if (conns.length >= MAX_CONNECTIONS)
      return void (await no(
        `This workspace has ${MAX_CONNECTIONS} servers connected, the most it can.`
      ))
    const r = readConnect(
      view.private_metadata,
      view.state.values as Values,
      conns.map((c) => c.id)
    )
    if ('errors' in r) return void (await ack({ response_action: 'errors', errors: r.errors }))
    try {
      await publicHttps(r.conn.url)
    } catch (err) {
      return void (await no(msg(err)))
    }
    await ack()
    // tried now: its tools, or why not. No headers: a server you sign in to, authorized from the Home tab.
    const c: Connection = { ...r.conn }
    if (c.auth === 'headers') {
      c.secret = sealFor(team, c.id, { headers: r.headers })
      try {
        c.tools = await probe({ url: c.url, headers: r.headers })
      } catch (err) {
        c.error = hide(msg(err), Object.values(r.headers)).slice(0, 200)
      }
    }
    await putConn(team, c)
    await publishHome(client, team, body.user.id)
  })
  app.view('mcp_allow_modal', async ({ ack, body, view, client, context }) => {
    const team = tenantOf(context)
    if (!(await asAdmin(client, team, body.user.id)))
      return void (await ack({
        response_action: 'errors',
        errors: { allow: 'Only workspace admins can change this.' }
      }))
    await ack()
    const picked = ((view.state.values as Values).allow?.allow?.selected_options ?? []).map(
      (o) => o.value
    )
    await editConns(team, (l) =>
      l.map((c) =>
        c.id === view.private_metadata
          ? { ...c, allow: picked.filter((n) => c.tools?.some((t) => t.name === n && !t.readOnly)) }
          : c
      )
    )
    await publishHome(client, team, body.user.id)
  })

  const port = Number(e.PORT ?? 3000)
  await app.start(port)
  console.log(`Consortium for Slack, hosted at ${base} (port ${port}; data: ${dataDir()})`)
  return app
}
