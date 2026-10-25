import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { App, type BlockAction, type ButtonAction, type types } from '@slack/bolt'
import * as debate from './debate'
import { ENDED, SILENT, toBrief } from './api'
import { killAll, type runMember } from './cli'
import { dataDir } from './paths'
import { tenantOf } from './store'
import type { SlackFile } from './files'
import { ACTIVITY_LABELS } from '../shared/activity'
import { spoken } from '../shared/cite'
import { memberModel, modelName } from '../shared/models'
import { makeLabels } from '../shared/personas'
import { fmtUsd, sumUsage, type Usage } from '../shared/usage'
import { sameLabel } from '../shared/vote'
import type { BoardVisual } from '../shared/boardVisuals'
import type { Brief, DebateEvent, PersonaId, TraceStep, Turn } from '../shared/types'
import type { HostInput, Whiteboard } from '../shared/whiteboard'

// The meeting engine in Slack, without the desktop app: `npm run slack`. One thread per meeting:
// the root message carries the board's gist and the controls, the whiteboard itself is a canvas the
// channel can read, each member speaks in the thread as its persona, and replies in the thread
// steer. Socket Mode, so it runs where the CLIs are signed in with no public URL. Same engine and
// sessions folder as the app; meetings run side by side, up to maxMeetings.

type Block = types.KnownBlock

// slack.json in the data folder. A preset is a brief without its task (see api.ts's toBrief);
// projectPath only ever comes from a preset, never from what someone types in Slack.
export type SlackConfig = {
  allow: string[] // Slack user ids that may start, steer and press the buttons; "*" = anyone in a channel the bot is in
  presets: Record<string, Record<string, unknown>>
  channels: Record<string, string> // channel id → the preset it uses
  maxMeetings?: number // meetings running at once (default 5)
}

export const allowed = (c: SlackConfig, user: string): boolean =>
  c.allow.includes('*') || c.allow.includes(user)

const ICONS: Record<PersonaId, string> = {
  strategist: ':chess_pawn:',
  engineer: ':hammer_and_wrench:',
  researcher: ':mag:',
  designer: ':art:',
  skeptic: ':thinking_face:',
  customer: ':shopping_trolley:'
}
const CHAIR = { username: 'Decision', icon_emoji: ':scales:' }
const FLOOR = { body: '', foot: '_Gave the floor to the host._' }
const SECTION = 3000 // Slack's limit for a section's (and a context element's) text
const BODY = 11_000 // a markdown block holds 12,000; leave room for the footer
const NOTES = [
  ['agreed', 'Agreed'],
  ['disputed', 'Disputed'],
  ['questions', 'Open questions'],
  ['actions', 'Actions']
] as const

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cites = (s: number[]): string => (s.length ? ` [${s.map((n) => `T${n}`).join(', ')}]` : '')
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unmention = (s: string): string => s.replace(/<@[A-Z0-9]+>/g, '').trim()
const own = <T>(o: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(o, k) ? o[k] : undefined
// names the id so the first refusal is also the setup step
const refused = (user: string): string =>
  `You are not on this table’s allow list. Add your id, \`${user}\`, to "allow" in slack.json.`
const slackError = (e: unknown): string =>
  (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.message : String(e))
const context = (text: string): Block => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: cut(text, SECTION) }]
})
const button = (action_id: string, text: string, style?: 'danger'): types.Button => ({
  type: 'button',
  action_id,
  text: { type: 'plain_text', text },
  ...(style && { style })
})

// "[preset:] question": an explicit preset wins, then the channel's, then "default".
export function briefFor(config: SlackConfig, channel: string, text: string): Brief {
  const [, word, rest] = text.match(/^\s*([\w-]+):\s*([\s\S]+)$/) ?? []
  const explicit = !!word && own(config.presets, word) !== undefined
  const name = explicit ? word : (own(config.channels, channel) ?? 'default')
  const preset = own(config.presets, name)
  if (!preset) throw new Error(`no preset "${name}" in slack.json`)
  return toBrief({ ...preset, task: (explicit ? rest : text).trim() })
}

// A reply in the meeting's thread: "focus: …" sets the focus, "skeptic: …" asks that member,
// anything else is a thought for the whole table.
export function parseSteer(text: string, labels: Record<string, string>): Omit<HostInput, 'id'> {
  const clean = unmention(text)
  const [, word, rest] = clean.match(/^([a-z][a-z0-9 ]{0,30}?)\s*:\s*([\s\S]+)$/i) ?? []
  if (word && /^focus$/i.test(word)) return { kind: 'focus', text: rest.trim() }
  const targetId = word && Object.keys(labels).find((id) => sameLabel(word, labels[id]))
  if (targetId) return { kind: 'ask', text: rest.trim(), targetId }
  return { kind: 'thought', text: clean }
}

export type BoardView = {
  question: string
  board?: Whiteboard
  phase: string // the engine's phase, or "concluding" / "deciding"
  turn: number
  maxTurns: number
  usage?: Record<string, Usage>
  state: 'running' | 'paused' | 'decided' | 'stopped' | 'failed'
  note?: string // mrkdwn under the footer: the decision's link, or why it failed
  canvas?: string // the whiteboard canvas's URL; without one the root carries the whole board
  attached?: string // mrkdwn: the repository and files the table reads, and what was left out
  follow?: number // a follow-up: its number in the thread (1 for the first)
  thread?: string // where an ended meeting's Ask a follow-up continues (hosted); unset: no button
}

const footer = (v: BoardView): string =>
  `${v.state === 'running' ? v.phase : v.state} · turn ${v.turn}/${v.maxTurns} · ${fmtUsd(sumUsage(Object.values(v.usage ?? {})))}`

// The root message: the board (or, with a canvas, its gist), a footer (phase · turn · cost), and
// the controls while it runs.
export function boardBlocks(v: BoardView): Block[] {
  const section = (title: string, body: string): Block => ({
    type: 'section',
    text: { type: 'mrkdwn', text: cut(`*${title}*\n${body}`, SECTION) }
  })
  const blocks: Block[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: cut(oneLine(v.question), 150) }
    },
    ...(v.follow
      ? [
          context(
            `:leftwards_arrow_with_hook: Follow-up ${v.follow} · builds on what the table said above`
          )
        ]
      : []),
    ...(v.attached ? [context(v.attached)] : [])
  ]
  const b = v.board
  if (b?.recommendation) blocks.push(section('Recommendation', esc(b.recommendation)))
  if (b && v.canvas)
    blocks.push(context(NOTES.map(([key, title]) => `${title} ${b[key].length}`).join(' · ')))
  else
    for (const [key, title] of NOTES) {
      const notes = b?.[key] ?? []
      if (notes.length)
        blocks.push(
          section(title, notes.map((n) => `• ${esc(n.text)}${cites(n.sources)}`).join('\n'))
        )
    }
  if (!b) blocks.push(context('_The clerk writes the board once the table has spoken._'))
  blocks.push(context(v.note ? `${footer(v)}\n${v.note}` : footer(v)))
  const elements: types.Button[] = v.canvas
    ? [{ ...button('whiteboard', 'Open whiteboard'), url: v.canvas }]
    : []
  if (v.state === 'running' || v.state === 'paused')
    elements.push(
      button('pause', v.state === 'paused' ? 'Resume' : 'Pause'),
      button('conclude', 'Conclude'),
      button('stop', 'Stop', 'danger')
    )
  // a decision's own message has the button; a meeting that ended without one, its board
  if (v.thread && (v.state === 'stopped' || v.state === 'failed'))
    elements.push({ ...button('follow_up', 'Ask a follow-up'), value: v.thread })
  if (elements.length) blocks.push({ type: 'actions', elements })
  return blocks
}

const cell = (s: string): string => oneLine(s).replace(/\|/g, '\\|') || ' '
const table = (head: string[], rows: string[][]): string =>
  [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')

function visualTable(v: BoardVisual): string {
  if (v.kind === 'comparison')
    return table(
      ['Criterion', ...v.options],
      v.rows.map((r) => [r.label, ...r.cells])
    )
  if (v.kind === 'sequence')
    return table(
      ['#', 'Step', 'Status', 'Detail'],
      v.steps.map((s, i) => [`${i + 1}`, s.label, s.status, s.detail + cites(s.sources)])
    )
  const label = (id: string): string => v.nodes.find((n) => n.id === id)?.label ?? id
  return table(
    ['From', 'Link', 'To'],
    v.edges.map((e) => [label(e.from), e.label || '→', label(e.to)])
  )
}

export const canvasTitle = (question: string): string => cut(oneLine(question), 100)

// The whiteboard canvas: the whole board as markdown, replaced on each revision.
export function canvasMarkdown(v: BoardView): string {
  const b = v.board
  const out: string[] = []
  const question = oneLine(v.question)
  if (canvasTitle(question) !== question) out.push(`> ${question}`) // the title cut it short
  if (!b) out.push('_The clerk writes the board once the table has spoken._')
  if (b?.recommendation) out.push(`## Recommendation\n${oneLine(b.recommendation)}`)
  if (b?.moderation)
    out.push(`> **Moderator:** ${oneLine(b.moderation.message)}${cites(b.moderation.sources)}`)
  for (const [key, title] of NOTES) {
    const notes = b?.[key] ?? []
    if (notes.length)
      out.push(
        `## ${title}\n${notes.map((n) => `- ${oneLine(n.text)}${cites(n.sources)}`).join('\n')}`
      )
  }
  for (const visual of b?.visuals ?? [])
    out.push(
      `### ${oneLine(visual.title)}\n${visual.caption ? `${oneLine(visual.caption)}${cites(visual.sources)}\n\n` : ''}${visualTable(visual)}`
    )
  // the note is mrkdwn: its <url|text> links become markdown links
  const note = v.note?.replace(/<([^|>]+)\|([^>]+)>/g, '[$2]($1)')
  out.push(`---\n${footer(v)}${note ? `\n\n${note}` : ''}`)
  return out.join('\n\n')
}

function voteLine(t: Turn): string {
  const v = t.vote
  if (!v) return ''
  const parts = [`*${esc(v.position)}*`, `${Math.round(v.confidence * 100)}% confident`]
  if (v.disagreements.length)
    parts.push(
      'disagrees with ' +
        v.disagreements.map((d) => esc(d.on ? `${d.with} on ${d.on}` : d.with)).join('; ')
    )
  return parts.join(' · ')
}

// The connected services' tools a turn called (their names hold "__"), for its footer:
// ":hammer_and_wrench: `linear.list_issues` ×2, `datadog.search_logs`".
export function toolsLine(trace: TraceStep[] = []): string {
  const n = new Map<string, number>()
  for (const s of trace)
    if (s.kind === 'tool' && s.name.includes('__')) {
      const name = s.name.replace('__', '.')
      n.set(name, (n.get(name) ?? 0) + 1)
    }
  return n.size
    ? `:hammer_and_wrench: ${[...n].map(([k, c]) => `\`${k}\`${c > 1 ? ` ×${c}` : ''}`).join(', ')}`
    : ''
}

// One member's message in the thread: streaming text and what it is doing, then the clean answer.
type Live = {
  ts?: string
  text: string
  activity: string
  model?: string // shown in the footer; the CLI may report the real one after the turn starts
  // calls: what its Tool calls button opens; buttons: the decision's (Ask a follow-up, Linear)
  final?: { body: string; foot: string; calls?: string; buttons?: types.Button[] }
}

function liveMessage(l: Live): { text: string; blocks: Block[] } {
  const body = l.final ? l.final.body : spoken(l.text)
  const foot = [l.final ? l.final.foot : `_${l.activity}…_`, l.model && `\`${l.model}\``]
    .filter(Boolean)
    .join(' · ')
  const blocks: Block[] = []
  if (body) blocks.push({ type: 'markdown', text: cut(body, BODY) })
  if (foot) blocks.push(context(foot))
  const elements: types.Button[] = [
    ...(l.final?.calls ? [{ ...button('tool_calls', 'Tool calls'), value: l.final.calls }] : []),
    ...(l.final?.buttons ?? [])
  ]
  if (elements.length) blocks.push({ type: 'actions', elements })
  return { text: cut(body || foot, 300), blocks }
}

type Client = App['client']

type Meeting = {
  id: string
  team: string // the workspace it runs for; only that workspace's events reach it
  client: Client // that workspace's bot
  channel: string
  ts: string // the thread: the root message, or the one a follow-up continues
  board: string // the message with the board and the controls: the root, or a follow-up's header
  link: string // its permalink
  at: number
  labels: Record<string, string>
  personas: Record<string, PersonaId>
  models: Record<string, string | undefined> // member id → the model it runs, for display
  view: BoardView
  live: Map<string, Live> // `${memberId}:${turn}`; the chair speaks at turn 0
  canvas?: string // the whiteboard canvas's id
  // Its Slack calls go out one at a time in event order, so a turn's message exists before its
  // updates; each meeting has its own queue, so a slow one never holds up the others.
  chain: Promise<unknown>
  timers: Map<string, NodeJS.Timeout>
  done?: () => void // once it has ended: what convene set up for it goes
  calls?: Convened['calls']
  log?: () => Promise<void>
  record?: Convened['record']
  recorded?: boolean
  issues?: boolean
  decision?: string // the chair's document, once written
}

function config(): SlackConfig {
  const file = join(dataDir(), 'slack.json')
  let c: Partial<SlackConfig>
  try {
    c = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : e} (see README, "Slack")`)
  }
  return {
    allow: c.allow ?? [],
    presets: c.presets ?? {},
    channels: c.channels ?? {},
    maxMeetings: c.maxMeetings ?? 5
  }
}

// Slack allows 3 s from a command or a click to the form it opens, and the database or GitHub can
// take longer: the form opens at once as this, then fills in (views.update has no deadline).
export const LOADING_VIEW: types.ModalView = {
  type: 'modal',
  title: { type: 'plain_text', text: 'Ask the table' },
  close: { type: 'plain_text', text: 'Cancel' },
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':hourglass_flowing_sand: Getting the table ready…' }
    }
  ]
}
export const noticeView = (text: string): types.ModalView => ({
  type: 'modal',
  title: { type: 'plain_text', text: 'Consortium' },
  close: { type: 'plain_text', text: 'OK' },
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: cut(text, SECTION) } }]
})
// the open form's id, or undefined when Slack refused (the 3 s were already gone)
export async function openLoading(client: Client, trigger: string): Promise<string | undefined> {
  try {
    return (await client.views.open({ trigger_id: trigger, view: LOADING_VIEW })).view?.id
  } catch (e) {
    console.error('slack: the form did not open:', slackError(e))
    return undefined
  }
}

// What differs between one workspace (slack.json, Socket Mode) and many (hosted.ts): who may use
// the table, how many meetings it holds at once, and the brief, runner and folder for a question.
export type Tenancy = {
  refuse(team: string, user: string, client: Client): Promise<string | undefined> // why not, or undefined
  maxMeetings(team: string): Promise<number>
  convene(team: string, channel: string, question: string, x: Extra): Promise<Convened> // throws what to tell them
  forget?(team: string): Promise<void> // the app was uninstalled there
  // Before a question starts (hosted): the form to ask with, filled into `view` (the loading form
  // `/consortium` and the Home tab open at once), or, for a mention, a message to pick the
  // repository with. false: start it at once (a mention only).
  ask?(o: {
    team: string
    client: Client
    user: string
    channel?: string
    view?: string
    question?: string
    files?: SlackFile[]
    thread?: string
    follow?: { thread: string; repo: string | null } // Ask a follow-up: the form on its thread
  }): Promise<boolean>
  // files posted in a meeting's thread, as text for the host's message (hosted); throws what to tell them
  attach?(team: string, client: Client, files: SlackFile[], question: string): Promise<string>
  // A thread's ended meetings (hosted), what its follow-ups build on; undefined: none kept
  thread?(team: string, ts: string): Promise<Thread | undefined>
}
// What came with the question: the meeting's id (picked before it starts), the files attached,
// and the repository: a full name, null for none, unset for the channel's usual. `thread`: the
// thread it follows up in.
export type Extra = {
  id: string
  client: Client
  files?: SlackFile[]
  repo?: string | null
  thread?: string
  say(text: string): Promise<unknown>
}
export type Convened = {
  brief: Brief
  run?: typeof runMember
  dir?: string
  question?: string // what the root message shows (default: the brief's task)
  attached?: string // see BoardView
  done?: () => void // called once the meeting has ended, or didn't start
  // The tool calls `who` (m1…, chair) made since it was last asked, kept under `title` (hosted):
  // the id its message's Tool calls button opens, or undefined when it made none.
  calls?: (who: string, title: string) => Promise<string | undefined>
  // The meeting as it stands, once it starts and once it ends (hosted: the Home tab's Recent meetings)
  log?: (r: MeetingLog) => Promise<void>
  follow?: number // a follow-up: its number in the thread
  record?: (thread: string, r: Round) => Promise<void> // once it has ended, for its follow-ups
  issues?: boolean // the decision gets Create Linear issues
}
// `user`: who asked. `link`: the root message's permalink. `cost`: as its footer says it.
export type MeetingLog = {
  ts: string
  channel: string
  user: string
  question: string
  link: string
  state: BoardView['state']
  cost: string
}

// A meeting that ended, as its thread's follow-ups need it (hosted: store kind 'threads').
export type Round = {
  id: string // the meeting's
  question: string
  state: BoardView['state']
  decision?: string // the chair's document, without its sources and appendix
  board?: Pick<Whiteboard, 'recommendation' | (typeof NOTES)[number][0]>
  link: string // its board message's permalink
  note?: string // the decision's link (mrkdwn), or why it failed
  cost: string
  at: number // started
  ended: number
}
// A thread's meetings: where, the repository and files they read, and each meeting, oldest first.
export type Thread = {
  channel: string
  repo: string | null
  files: SlackFile[]
  rounds: Round[]
}

// The chair's document without what the engine appends (sources, votes, panel).
export const decisionBody = (md: string): string =>
  md.split(/\n## Sources\n|\n---\n+## Final votes/)[0].trim()

export const UNAVAILABLE =
  'This meeting ended before Consortium kept what a follow-up needs, so the earlier context isn’t available here.'

// One workspace: slack.json, re-read on each use.
const local = (run?: typeof runMember): Tenancy => ({
  refuse: async (_, user) => (allowed(config(), user) ? undefined : refused(user)),
  maxMeetings: async () => config().maxMeetings!,
  convene: async (_, channel, question) => ({ brief: briefFor(config(), channel, question), run })
})

export function serve({ run }: { run?: typeof runMember } = {}): App {
  const { SLACK_BOT_TOKEN: token, SLACK_APP_TOKEN: appToken } = process.env
  if (!token || !appToken)
    throw new Error(
      'Set SLACK_BOT_TOKEN (xoxb-…) and SLACK_APP_TOKEN (xapp-…); see README, "Slack"'
    )
  config() // a missing or broken slack.json fails now, not at the first command; it's re-read on each use
  debate.configure(dataDir())
  const app = new App({ token, appToken, socketMode: true })
  bridge(app, local(run))
  app.start().then(() => console.log(`Consortium in Slack (Socket Mode; data: ${dataDir()})`))
  return app
}

export type Start = (
  team: string,
  client: Client,
  channel: string,
  user: string,
  text: string,
  say: (text: string) => Promise<unknown>,
  more?: Pick<Extra, 'files' | 'repo' | 'thread'>
) => Promise<void>

// Meetings in threads, for whichever workspaces `app` serves. Returns how to start one.
export function bridge(app: App, t: Tenancy): { start: Start } {
  const meetings = new Map<string, Meeting>() // `${team}:${root message ts}` → meeting
  const starting = new Map<string, number>() // per workspace: meetings between their command and their root message
  const slot = (team: string, ts: string): string => `${team}:${ts}`
  const running = (team: string): number =>
    [...meetings.values()].filter((m) => m.team === team).length + (starting.get(team) ?? 0)

  const q = (m: Meeting, f: () => Promise<unknown>): void => {
    m.chain = m.chain.then(f).catch((e) => console.error('slack:', slackError(e)))
  }
  // at most one update per message per `ms`; `now` sends the latest state at once
  const soon = (
    m: Meeting,
    key: string,
    ms: number,
    f: () => Promise<unknown>,
    now = false
  ): void => {
    if (m.timers.has(key) && !now) return
    clearTimeout(m.timers.get(key))
    m.timers.delete(key)
    if (now) return q(m, f)
    m.timers.set(
      key,
      setTimeout(() => {
        m.timers.delete(key)
        q(m, f)
      }, ms)
    )
  }
  const rootUpdate = (m: Meeting): Promise<unknown> =>
    m.client.chat.update({
      channel: m.channel,
      ts: m.board,
      text: m.view.question,
      blocks: boardBlocks(m.view)
    })
  const canvasUpdate = async (m: Meeting): Promise<unknown> =>
    m.canvas &&
    m.client.canvases.edit({
      canvas_id: m.canvas,
      changes: [
        {
          operation: 'replace',
          document_content: { type: 'markdown', markdown: canvasMarkdown(m.view) }
        }
      ]
    })
  // the board, usage and turn changes share one message: update it less often
  const renderRoot = (m: Meeting, now = false): void =>
    soon(m, 'root', 3000, () => rootUpdate(m), now)
  const renderCanvas = (m: Meeting, now = false): void =>
    soon(m, 'canvas', 5000, () => canvasUpdate(m), now)
  const render = (m: Meeting, now = false): void => {
    renderRoot(m, now)
    renderCanvas(m, now)
  }
  const renderTurn = (m: Meeting, key: string, now = false): void => {
    const l = m.live.get(key)
    if (l)
      soon(
        m,
        key,
        1500,
        async () =>
          l.ts && m.client.chat.update({ channel: m.channel, ts: l.ts, ...liveMessage(l) }),
        now
      )
  }
  const open = (
    m: Meeting,
    key: string,
    as: { username: string; icon_emoji: string },
    model?: string
  ): void => {
    const old = m.live.get(key)
    if (old && !old.final) {
      // the chair redrafts after the host spoke: close its first draft
      old.final = { ...FLOOR }
      renderTurn(m, key, true)
    }
    const l: Live = { text: '', activity: ACTIVITY_LABELS.starting, model }
    m.live.set(key, l)
    q(m, async () => {
      const r = await m.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.ts,
        ...as,
        ...liveMessage(l)
      })
      l.ts = r.ts
    })
  }
  const canvasUrl = async (m: Meeting, id: string): Promise<string> => {
    const { url, team_id } = await m.client.auth.test()
    return `${url}docs/${team_id}/${id}`
  }

  // The tool calls a seat made in a turn, kept (hosted): its message gets a Tool calls button.
  // Queued before the message's last update, which then carries it.
  const keep = (m: Meeting, key: string, who: string, title: string): void => {
    const calls = m.calls
    if (calls)
      q(m, async () => {
        const id = await calls(who, title)
        const l = m.live.get(key)
        if (id && l?.final) l.final.calls = id
      })
  }
  const title = (m: Meeting, who: string, turn: number): string =>
    `${m.labels[who] ?? who} · turn ${turn}`

  // One meeting's engine events → its thread. Audio never arrives: SILENT keeps the engine quiet.
  const send = (m: Meeting, e: DebateEvent): void => {
    const key = 'memberId' in e ? `${e.memberId}:${'turn' in e ? e.turn : 0}` : ''
    const l = m.live.get(key)
    switch (e.type) {
      case 'turn-start':
        Object.assign(m.view, { turn: e.turn, phase: e.phase })
        open(
          m,
          key,
          { username: m.labels[e.memberId], icon_emoji: ICONS[m.personas[e.memberId]] },
          m.models[e.memberId]
        )
        render(m)
        break
      case 'chair-start':
        m.view.phase = 'deciding'
        open(m, key, CHAIR, m.models[e.memberId])
        render(m)
        break
      case 'member-model': // the model the CLI actually runs: shown on its live turn from now on
        m.models[e.memberId] = modelName(e.model) ?? m.models[e.memberId]
        for (const [k, x] of m.live)
          if (k.startsWith(`${e.memberId}:`) && !x.final) {
            x.model = m.models[e.memberId]
            renderTurn(m, k)
          }
        break
      case 'activity':
        if (l) l.activity = ACTIVITY_LABELS[e.kind]
        renderTurn(m, key)
        break
      case 'delta':
        if (l) l.text += e.text
        renderTurn(m, key)
        break
      case 'turn-done': {
        const done = m.live.get(`${e.turn.speaker}:${e.turn.n}`)
        const foot = [voteLine(e.turn), toolsLine(e.turn.trace)].filter(Boolean).join(' · ')
        if (done) done.final = { body: e.turn.text, foot }
        keep(m, `${e.turn.speaker}:${e.turn.n}`, e.turn.speaker, title(m, e.turn.speaker, e.turn.n))
        renderTurn(m, `${e.turn.speaker}:${e.turn.n}`, true)
        break
      }
      case 'turn-cancelled': // the host took the floor; this seat speaks again after them
        if (l) l.final = { ...FLOOR }
        keep(m, key, e.memberId, title(m, e.memberId, e.turn))
        renderTurn(m, key, true)
        break
      case 'turn-error':
        if (l)
          l.final = { body: '', foot: `:warning: Couldn't answer: ${esc(cut(e.message, 300))}` }
        keep(m, key, e.memberId, title(m, e.memberId, e.turn))
        renderTurn(m, key, true)
        break
      case 'whiteboard':
        m.view.board = e.board
        render(m)
        break
      case 'usage':
        m.view.usage = e.usage
        renderRoot(m)
        break
      case 'concluding':
        m.view.phase = 'concluding'
        render(m)
        break
      case 'consortium': {
        const chair = [...m.live.keys()].findLast((k) => k.endsWith(':0'))
        const draft = chair && m.live.get(chair)
        m.decision = e.markdown
        const buttons: types.Button[] = [
          ...(t.thread ? [{ ...button('follow_up', 'Ask a follow-up'), value: m.ts }] : []),
          ...(m.issues
            ? [{ ...button('linear_issues', 'Create Linear issues'), value: `${m.ts}:${m.id}` }]
            : [])
        ]
        if (draft) draft.final = { body: e.markdown, foot: '', buttons }
        if (chair) keep(m, chair, 'chair', 'The decision')
        if (chair) renderTurn(m, chair, true)
        m.view.state = 'decided'
        q(m, async () => {
          const link = await publish(m, e.markdown, e.path).catch(
            (err) => (console.error('slack:', slackError(err)), `saved on the host: ${esc(e.path)}`)
          )
          m.view.note = `:page_facing_up: ${link}`
        })
        render(m, true)
        break
      }
      case 'stopped':
        m.view.state = 'stopped'
        render(m, true)
        break
      case 'failed':
        m.view.state = 'failed'
        m.view.note = `:warning: ${esc(cut(e.message, 500))}`
        render(m, true)
        break
    }
    if (ENDED.has(e.type)) {
      meetings.delete(slot(m.team, m.ts))
      m.done?.()
      void m.log?.()
      q(m, () => finish(m)) // after the decision's link is in
    }
  }

  // What its follow-ups need, kept once it has ended (hosted)
  const finish = async (m: Meeting): Promise<void> => {
    if (!m.record || m.recorded) return
    m.recorded = true
    const b = m.view.board
    await m
      .record(m.ts, {
        id: m.id,
        question: m.view.question,
        state: m.view.state,
        ...(m.decision && { decision: decisionBody(m.decision) }),
        ...(b && {
          board: {
            recommendation: b.recommendation,
            ...Object.fromEntries(NOTES.map(([k]) => [k, b[k]]))
          } as Round['board']
        }),
        link: m.link,
        ...(m.view.note && { note: m.view.note }),
        cost: fmtUsd(sumUsage(Object.values(m.view.usage ?? {}))),
        at: m.at,
        ended: Date.now()
      })
      .catch((e) => console.error('slack: meeting not kept for follow-ups:', slackError(e)))
  }

  // The thread's root says how many follow-ups it has, and links the latest.
  const noteRoot = async (m: Meeting, n: number): Promise<void> => {
    const root = (await m.client.conversations.replies({ channel: m.channel, ts: m.ts, limit: 1 }))
      .messages?.[0]
    if (!root?.blocks) return
    const note: Block = {
      type: 'context',
      block_id: 'follow_ups',
      elements: [
        {
          type: 'mrkdwn',
          text: `:leftwards_arrow_with_hook: ${n} follow-up${n > 1 ? 's' : ''} in the thread${m.link ? ` · <${m.link}|the latest>` : ''}`
        }
      ]
    }
    await m.client.chat.update({
      channel: m.channel,
      ts: m.ts,
      text: root.text ?? m.view.question,
      blocks: [...(root.blocks as Block[]).filter((b) => b.block_id !== 'follow_ups'), note]
    })
  }

  // The live whiteboard as a canvas the channel can read. Without canvases (a plan without them,
  // or a missing scope) the root message keeps the whole board instead.
  async function whiteboard(m: Meeting): Promise<void> {
    try {
      const { canvas_id } = await m.client.canvases.create({
        title: canvasTitle(m.view.question),
        document_content: { type: 'markdown', markdown: canvasMarkdown(m.view) }
      })
      if (!canvas_id) throw new Error('no canvas id')
      await m.client.canvases.access.set({
        canvas_id,
        access_level: 'read',
        channel_ids: [m.channel]
      })
      m.view.canvas = await canvasUrl(m, canvas_id)
      m.canvas = canvas_id
      render(m, true)
    } catch (e) {
      console.error(
        'slack: no whiteboard canvas, the board stays in the root message:',
        slackError(e)
      )
    }
  }

  // The decision as a canvas the channel can read; the .md in the thread if canvases are off.
  async function publish(m: Meeting, markdown: string, path: string): Promise<string> {
    const title = cut(markdown.match(/^#\s+(.+)$/m)?.[1] ?? m.view.question, 100)
    try {
      const { canvas_id } = await m.client.canvases.create({
        title,
        document_content: { type: 'markdown', markdown }
      })
      if (!canvas_id) throw new Error('no canvas id')
      await m.client.canvases.access.set({
        canvas_id,
        access_level: 'read',
        channel_ids: [m.channel]
      })
      return `<${await canvasUrl(m, canvas_id)}|${esc(title)}>`
    } catch (e) {
      console.error('slack: no canvas, attaching the file instead:', slackError(e))
      const r = (await m.client.files.uploadV2({
        channel_id: m.channel,
        thread_ts: m.ts,
        filename: basename(path),
        content: markdown,
        title
      })) as { files?: { files?: { permalink?: string }[] }[] }
      const link = r.files?.[0]?.files?.[0]?.permalink
      return link ? `<${link}|${esc(title)}>` : 'the decision is attached in the thread'
    }
  }

  const start: Start = async (team, client, channel, user, text, say, more = {}) => {
    const no = await t.refuse(team, user, client)
    if (no) return void (await say(no))
    const max = await t.maxMeetings(team)
    const now = running(team)
    if (now >= max)
      return void (await say(
        `${now} meetings are running, the most this table holds at once (${max}). Try again when one ends.`
      ))
    const question = unmention(text)
    if (!question) return void (await say('Usage: `/consortium [preset:] <question>`'))
    if (more.thread && meetings.has(slot(team, more.thread)))
      return void (await say(
        'A meeting is already running in this thread: reply there to steer it.'
      ))
    starting.set(team, (starting.get(team) ?? 0) + 1) // counted before the first await, so starts at once can't pass the limit
    try {
      const id = randomUUID()
      let c: Convened
      try {
        c = await t.convene(team, channel, question, { id, client, say, ...more })
      } catch (e) {
        return void (await say(`Can't convene: ${e instanceof Error ? e.message : e}`))
      }
      const { brief, run, dir } = c
      const m: Meeting = {
        id,
        team,
        client,
        channel,
        ts: '',
        board: '',
        link: '',
        at: Date.now(),
        labels: makeLabels(brief.members),
        personas: Object.fromEntries(brief.members.map((x) => [x.id, x.persona])),
        models: Object.fromEntries(brief.members.map((x) => [x.id, memberModel(x)])),
        view: {
          question: c.question ?? brief.task,
          phase: 'open',
          turn: 0,
          maxTurns: brief.maxTurns,
          state: 'running',
          attached: c.attached,
          ...(c.follow && { follow: c.follow })
        },
        live: new Map(),
        chain: Promise.resolve(),
        timers: new Map(),
        done: c.done,
        calls: c.calls,
        record: c.record,
        issues: c.issues
      }
      try {
        // a follow-up's board goes in its thread, under a header of its own
        const posted = await client.chat.postMessage({
          channel,
          ...(more.thread && { thread_ts: more.thread }),
          text: m.view.question,
          blocks: boardBlocks(m.view)
        })
        m.board = posted.ts!
        m.ts = more.thread ?? m.board
        if (t.thread) m.view.thread = m.ts
        m.link = (await client.chat.getPermalink({ channel, message_ts: m.board })).permalink ?? ''
      } catch (e) {
        c.done?.()
        return void (await say(
          `Can't post here (${slackError(e)}); invite me to the channel first.`
        ))
      }
      meetings.set(slot(team, m.ts), m)
      const log = c.log
      m.log =
        log &&
        (() =>
          log({
            ts: m.board,
            channel,
            user,
            question: m.view.question,
            link: m.link,
            state: m.view.state,
            cost: fmtUsd(sumUsage(Object.values(m.view.usage ?? {})))
          }).catch((e) => console.error('slack: meeting not logged:', slackError(e))))
      void m.log?.()
      if (c.follow) q(m, () => noteRoot(m, c.follow!))
      q(m, () => whiteboard(m))
      debate.runDebate(brief, (e) => send(m, e), m.id, undefined, run, SILENT, dir)
    } finally {
      starting.set(team, starting.get(team)! - 1)
    }
  }

  const ephemeral =
    (client: Client, channel: string, user: string, thread_ts?: string) => (text: string) =>
      client.chat.postEphemeral({ channel, user, thread_ts, text })

  // t.ask first, when there is one: true = it took the question (a form, a picker, a refusal)
  const asked = async (
    o: Parameters<NonNullable<Tenancy['ask']>>[0],
    say: (text: string) => Promise<unknown>
  ): Promise<boolean> => {
    if (!t.ask) return false
    const no = await t.refuse(o.team, o.user, o.client)
    if (!no) return t.ask(o)
    await say(no)
    return true
  }

  app.command('/consortium', async ({ command, ack, respond, client, context }) => {
    await ack()
    const team = tenantOf(context)
    const { user_id: user, channel_id: channel, trigger_id: trigger } = command
    // hosted: the form opens before any database or GitHub call, well inside Slack's 3 s
    const view = t.ask ? await openLoading(client, trigger) : undefined
    const say = (text: string): Promise<unknown> =>
      view
        ? client.views.update({ view_id: view, view: noticeView(text) })
        : respond({ response_type: 'ephemeral', text })
    const question = unmention(command.text)
    const o = { team, client, user, channel, ...(view && { view }), ...(question && { question }) }
    try {
      if (await asked(o, say)) return
    } catch (e) {
      // Slack's own words for a form it refuses (response_metadata.messages), so it can be fixed
      const detail = (e as { data?: { response_metadata?: { messages?: string[] } } })?.data
        ?.response_metadata?.messages
      const why = [slackError(e), ...(detail ?? [])].join(' · ')
      console.error('slack: no form:', why)
      return void (await say(
        `Couldn't open the form: \`${cut(why, 600)}\`. Run /consortium again.`
      ))
    }
    await start(team, client, channel, user, command.text, say)
  })

  // A question as a mention asks it: the tenancy's picker first, when there is one.
  const fresh = async (
    team: string,
    client: Client,
    channel: string,
    user: string,
    text: string,
    say: (text: string) => Promise<unknown>,
    files?: SlackFile[],
    thread?: string
  ): Promise<void> => {
    const question = unmention(text)
    const o = { team, client, user, channel, thread }
    if (question && (await asked({ ...o, question, files }, say))) return
    await start(team, client, channel, user, text, say, { files })
  }
  // A thread's ended meetings, when they were in this channel
  const earlier = async (
    team: string,
    channel: string,
    ts: string
  ): Promise<Thread | undefined> => {
    const r = await t.thread?.(team, ts)
    return r?.channel === channel ? r : undefined
  }
  // the thread's root is this bot's: a meeting's, from before follow-ups were kept
  const ours = async (
    client: Client,
    channel: string,
    ts: string,
    bot?: string
  ): Promise<boolean> =>
    !!bot &&
    (await client.conversations
      .replies({ channel, ts, limit: 1 })
      .then((r) => r.messages?.[0]?.bot_id === bot)
      .catch(() => false))

  app.event('app_mention', async ({ event, client, context }) => {
    const team = tenantOf(context)
    // a mention inside a running meeting's thread is a steer: the message listener has it
    if (!event.user || (event.thread_ts && meetings.has(slot(team, event.thread_ts)))) return
    const say = ephemeral(client, event.channel, event.user, event.thread_ts)
    const thread = event.thread_ts
    // in an ended meeting's thread: a follow-up, there
    if (thread && t.thread) {
      if (await earlier(team, event.channel, thread))
        return start(team, client, event.channel, event.user, event.text, say, {
          files: event.files,
          thread
        })
      const question = unmention(event.text)
      if (question && (await ours(client, event.channel, thread, context.botId)))
        return void (await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          thread_ts: thread,
          text: UNAVAILABLE,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `${UNAVAILABLE} Start fresh, and the table takes your question as a new meeting in the channel.`
              }
            },
            {
              type: 'actions',
              elements: [{ ...button('fresh_start', 'Start fresh'), value: cut(question, 2000) }]
            }
          ]
        }))
    }
    await fresh(team, client, event.channel, event.user, event.text, say, event.files, thread)
  })

  // the offer above: the question as a new meeting
  app.action<BlockAction>(
    'fresh_start',
    async ({ ack, body, action, client, context, respond }) => {
      await ack()
      const channel = body.channel?.id
      if (!channel) return
      await respond({ delete_original: true }).catch(() => {})
      const thread = body.container?.thread_ts as string | undefined
      const say = ephemeral(client, channel, body.user.id, thread)
      const text = (action as ButtonAction).value ?? ''
      await fresh(tenantOf(context), client, channel, body.user.id, text, say, undefined, thread)
    }
  )

  // Ask a follow-up: the form on the thread's channel and repository
  if (t.thread && t.ask)
    app.action<BlockAction>('follow_up', async ({ ack, body, action, client, context }) => {
      await ack()
      const team = tenantOf(context)
      const user = body.user.id
      const thread = (action as ButtonAction).value ?? ''
      const view = await openLoading(client, body.trigger_id)
      if (!view) return
      const say = (text: string): Promise<unknown> =>
        client.views.update({ view_id: view, view: noticeView(text) })
      const no = await t.refuse(team, user, client)
      if (no) return void (await say(no))
      if (meetings.has(slot(team, thread)))
        return void (await say(
          'A meeting is already running in this thread: reply there to steer it.'
        ))
      const r = await earlier(team, body.channel?.id ?? '', thread)
      if (!r) return void (await say(`${UNAVAILABLE} Ask in a new meeting instead.`))
      await t.ask!({
        team,
        client,
        user,
        channel: r.channel,
        view,
        follow: { thread, repo: r.repo }
      })
    })

  app.message(async ({ message, client, context }) => {
    // a file posted in the thread comes as file_share
    if (message.subtype !== undefined && message.subtype !== 'file_share') return
    if (('bot_id' in message && message.bot_id) || !message.thread_ts) return
    const team = tenantOf(context)
    const m = meetings.get(slot(team, message.thread_ts))
    if (!m) return hint(team, client, message, context.botUserId)
    // from before it started: the mention that asked a follow-up, say, is no steer
    if (Number(message.ts) * 1000 < m.at) return
    const say = ephemeral(client, m.channel, message.user, m.ts)
    const no = await t.refuse(team, message.user, client)
    if (no) return void (await say(no))
    const steer = parseSteer(message.text ?? '', m.labels)
    if (message.files?.length && t.attach)
      try {
        const files = await t.attach(team, client, message.files, m.view.question)
        steer.text = [steer.text, files].filter(Boolean).join('\n\n')
      } catch (e) {
        await say(`Can't add the files: ${e instanceof Error ? e.message : e}`)
      }
    if (!steer.text) return
    try {
      debate.host(m.id, { id: randomUUID(), ...steer })
    } catch (e) {
      await say(e instanceof Error ? e.message : String(e))
    }
  })

  // A plain reply in an ended meeting's thread starts nothing: how to continue it, once a person.
  // ponytail: who was told is in memory; after a restart they're told once more
  const told = new Set<string>()
  async function hint(
    team: string,
    client: Client,
    message: { channel: string; user?: string; thread_ts?: string; text?: string },
    botUser?: string
  ): Promise<void> {
    const { channel, user, thread_ts: thread } = message
    if (!t.thread || !user || !thread) return
    if (botUser && message.text?.includes(`<@${botUser}>`)) return // a mention: app_mention has it
    const k = `${team}:${thread}:${user}`
    if (told.has(k) || !(await earlier(team, channel, thread))) return
    if (told.size > 10_000) told.clear()
    told.add(k)
    await ephemeral(
      client,
      channel,
      user,
      thread
    )('Mention @Consortium or press Ask a follow-up to continue.')
  }

  // a link button: Slack opens the canvas, the bot only acknowledges the click
  app.action('whiteboard', async ({ ack }) => ack())

  app.action<BlockAction>(
    /^(pause|conclude|stop)$/,
    async ({ ack, body, action, client, context }) => {
      await ack()
      const team = tenantOf(context)
      const say = ephemeral(client, body.channel?.id ?? '', body.user.id)
      const no = await t.refuse(team, body.user.id, client)
      if (no) return void (await say(no))
      // a follow-up's controls are on its header, in the thread
      const ts = body.message?.thread_ts ?? body.message?.ts
      const m = ts ? meetings.get(slot(team, ts)) : undefined
      if (!m) return void (await say('This meeting is no longer running.'))
      try {
        if (action.action_id === 'pause') {
          m.view.state = m.view.state === 'paused' ? 'running' : 'paused'
          debate.pause(m.id, m.view.state === 'paused')
          renderRoot(m, true)
          renderCanvas(m)
        } else if (action.action_id === 'conclude') debate.conclude(m.id)
        else debate.stop(m.id)
      } catch (e) {
        await say(e instanceof Error ? e.message : String(e))
      }
    }
  )

  // Uninstalled (or its bot token revoked): its meetings stop and what it stored goes.
  if (t.forget) {
    const gone = async (team: string): Promise<void> => {
      for (const m of meetings.values()) if (m.team === team) debate.stop(m.id)
      await t.forget!(team)
    }
    app.event('app_uninstalled', async ({ context }) => gone(tenantOf(context)))
    app.event('tokens_revoked', async ({ event, context }) => {
      if (event.tokens.bot?.length) await gone(tenantOf(context))
    })
  }

  const quit = async (): Promise<void> => {
    const all = [...meetings.values()]
    for (const m of all) debate.stop(m.id)
    for (const m of all) m.done?.()
    killAll()
    await Promise.all(
      all.map((m) => {
        m.view.state = 'stopped'
        m.view.note = '_The Slack bridge shut down._'
        return Promise.all([rootUpdate(m), canvasUpdate(m), m.log?.(), finish(m)]).catch(() => {})
      })
    )
    await app.stop()
    process.exit(0)
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  return { start }
}

// Hosted (many workspaces, "Add to Slack", HTTP) when its settings are there; else Socket Mode.
if (require.main === module) {
  const e = process.env
  if (e.SLACK_CLIENT_ID && e.SLACK_CLIENT_SECRET && e.SLACK_SIGNING_SECRET && e.DATABASE_URL)
    import('./hosted')
      .then((h) => h.serveHosted())
      .catch((err) => {
        console.error(err instanceof Error ? err.message : err)
        process.exit(1)
      })
  else serve()
}
