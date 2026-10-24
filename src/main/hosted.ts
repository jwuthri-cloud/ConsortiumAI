import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { App, webApi, type BlockAction, type CustomRoute, type types } from '@slack/bolt'
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
import { dataDir } from './paths'
import { bridge, type Tenancy } from './slack'
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
      selected_conversation?: string | null
      files?: SlackFile[]
    }
  >
>
export type Seat = { model: string; persona: PersonaId } // model: an OpenRouter id

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
export type Showing = { mine?: string[]; images?: string[]; sees?: (model: string) => boolean }

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
    try {
      return await run(cli, { ...a, apiKey, home, ...(show && { images: o.images }) }, ...rest)
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

// "repo:owner/name question" or "repo:none question": the repository for this one question.
export function repoPrefix(text: string): { repo?: string | null; text: string } {
  const [, r, rest] = text.match(/^\s*repo:\s*(none|[\w.-]+\/[\w.-]+)\s+([\s\S]+)$/i) ?? []
  return r
    ? { repo: r.toLowerCase() === 'none' ? null : r, text: rest.trim() }
    : { text: text.trim() }
}
const REPO = /^[\w.-]+\/[\w.-]+$/

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
export type HomeMore = {
  files?: boolean
  install?: string
  github?: { connect?: string; account?: string; repos?: number }
}

// What everyone sees; an admin also gets the buttons. `connect` = the "Connect OpenRouter" link.
export function homeView(
  s: Settings,
  admin: boolean,
  connect?: string,
  more: HomeMore = {}
): types.HomeView {
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
  const g = more.github
  const repos =
    g?.repos === undefined ? '' : ` · ${g.repos} ${g.repos === 1 ? 'repository' : 'repositories'}`
  const githubBlocks: types.KnownBlock[] = g
    ? [
        { type: 'divider' },
        section(
          `*GitHub*\n${g.account ? `:white_check_mark: Connected to \`${g.account}\`${repos}. Pick one when you ask, or start with \`repo:owner/name\`; the table reads it, read-only.` : 'Not connected. Connect a GitHub account or org, and the table can read one of its repositories, read-only, when you ask.'}`
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
        'A table of AI models that debates your question in a thread and writes the decision. Invite me to a channel, then `/consortium <question>` or mention @Consortium there. `/consortium` alone opens a form to attach files or a repository. Reply in the thread to steer the meeting.'
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
export function tableModal(s: Settings, catalogue: string[]): types.ModalView {
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

const NONE = 'none' // the repository select's "— none —"

// The form `/consortium` alone (or the Home tab's New question) opens. `repos`: what the repository
// select lists (unset = no select), `repo` its first pick; `files`: the install reads files (else
// `install`, the reinstall link); `note`: a line under the repository.
export function askModal(o: {
  channel?: string
  repos?: string[]
  repo?: string | null
  files: boolean
  install: string
  note?: string
}): types.ModalView {
  const list = o.repo && o.repos && !o.repos.includes(o.repo) ? [o.repo, ...o.repos] : o.repos
  const repos = list && [
    option(NONE, '— none —'),
    ...list.slice(0, MAX_OPTIONS - 1).map((r) => option(r, r))
  ]
  return {
    type: 'modal',
    callback_id: 'ask_modal',
    title: plain('Ask the table'),
    submit: plain('Convene'),
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
          placeholder: plain('What should the table decide?')
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
                options: repos,
                initial_option: repos.find((x) => x.value === (o.repo ?? NONE)) ?? repos[0]
              },
              hint: plain('The table reads it, read-only, for this meeting.')
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
  // the repository each channel asked with last, per workspace
  const lastRepos = async (team: string): Promise<Record<string, string>> =>
    (await store.get<Record<string, string>>('channel-repos', team)) ?? {}
  // the repository, cloned into `work` with a token for it alone: its folder
  const fetchRepo = async (installation: number, full: string, work: string): Promise<string> => {
    if (!REPO.test(full)) throw new Error(`${full} isn't a repository name (owner/name).`)
    let token: string
    let r: Repo
    try {
      token = await installationToken(github!, installation, [full.split('/')[1]])
      r = await getRepo(token, full)
    } catch (err) {
      throw new Error(
        `${full} isn't among the repositories this workspace's GitHub connection can read; an admin can add it with Change repositories in the Home tab (${err instanceof Error ? err.message : err}).`
      )
    }
    if (r.size > MAX_REPO_KB)
      throw new Error(
        `${full} is about ${Math.round(r.size / 1024)} MB; the table reads repositories up to 300 MB.`
      )
    const into = join(work, r.name)
    await clone(token, `https://github.com/${r.full_name}.git`, into)
    return into
  }

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
      const done = (): void => {
        for (const d of [folder, work]) if (d) rmSync(d, { recursive: true, force: true })
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
        const run = keyed(key, dir, runMember, {
          mine: [folder, work].filter((d): d is string => !!d),
          images: pixels(got),
          sees: (m) => vision.includes(m)
        })
        const attached = attachedLine(
          repo,
          got.filter((g) => !blind.includes(g)).map((g) => g.name),
          skipped
        )
        return { brief, run, dir, question: asked.text, attached, done }
      } catch (err) {
        done()
        throw err
      }
    },
    ask: async ({ team, client, channel, trigger }) => {
      const [link, last, files] = await Promise.all([
        linkOf(team),
        channel ? lastRepos(team).then((r) => r[channel]) : undefined,
        readsFiles(team)
      ])
      let repos: string[] | undefined
      let note: string | undefined
      if (github && !link)
        note = "Connect GitHub in Consortium's Home tab, and the table can read a repository."
      if (link) {
        // the form must open within 3 s of the command
        const names = await Promise.race([
          reposOf(link.installation).then((r) => r.repos.map((x) => x.full_name)),
          new Promise<undefined>((r) => setTimeout(r, 1500))
        ]).catch(() => undefined)
        repos = names ?? (last ? [last] : [])
        if (!names)
          note = 'The repository list is still loading: run /consortium again to see it all.'
      }
      await client.views.open({
        trigger_id: trigger,
        view: askModal({ channel, repos, repo: last, files, install: reinstall, note })
      })
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
      for (const kind of ['installation', 'settings', 'github', 'channel-repos'])
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
    const [install, link] = await Promise.all([installOf(team), linkOf(team)])
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
    const no = await tenancy.refuse(team, user, client)
    if (no)
      return void (await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          title: plain('Consortium'),
          close: plain('OK'),
          blocks: [section(no)]
        }
      }))
    await tenancy.ask!({ team, client, user, trigger: body.trigger_id })
  })
  // the repository select reports each pick; Convene reads it
  app.action({ block_id: 'repo' }, async ({ ack }) => ack())
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
