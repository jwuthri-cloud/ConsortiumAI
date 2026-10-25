import type { types } from '@slack/bolt'
import type { CallToolResult, FetchLike } from '@modelcontextprotocol/client'
import { chat } from './files'
import { LIMITS, connect, publicFetch, resultText, type Connection, type Open } from './mcp'
import type { Store } from './store'

// A decision's next actions as Linear issues (hosted): the clerk drafts them, a person checks and
// edits them in a modal, and the server (never a seat) creates them with the workspace's Linear
// connection, once per decision.

export type Draft = { title: string; description: string }
export type Item = { id: string; name: string } // a Linear team or project
export type Created = {
  created: { title: string; identifier?: string; url?: string }[]
  failed: { title: string; error: string }[]
}
// store kind 'linear-issues', id `${team}:${meeting id}`; without `done` it was cut off midway
export type IssuesRecord = Partial<Created> & { by: string; at: number; done?: boolean }

export const MAX_DRAFTS = 10 // the modal's 3 blocks each stay well inside Slack's 100
export const TITLE = 80
const DESCRIPTION = 3000 // a plain_text_input's most

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const mrk = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const uncite = (s: string): string => s.replace(/\s*\[T\d+(?:,\s*T\d+)*\]/g, '')

// ---------- drafts ----------

// The items of a decision's "## Next actions" (numbered or bulleted), its citations dropped.
export function nextActions(md: string): string[] {
  const body = md.match(/^##\s+Next actions[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m)?.[1] ?? ''
  const items: string[] = []
  for (const line of body.split('\n')) {
    const item = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*)$/)?.[1]
    if (item !== undefined) items.push(item)
    else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`
  }
  return items.map((i) => oneLine(uncite(i))).filter(Boolean)
}

// "# Consortium: Ship the beta" → "Ship the beta"
export const decisionTitle = (md: string): string =>
  oneLine(md.match(/^#\s+(?:Consortium:\s*)?(.+)$/m)?.[1] ?? 'the decision')

export function draftPrompt(o: { question: string; decision: string; actions: string[] }): string {
  return `A table of advisors decided the question below. Turn its next actions into Linear issues a team can pick up.

Return only a JSON array, no prose: [{"title": "…", "description": "…"}]
- One issue per concrete piece of work, at most ${MAX_DRAFTS}. Merge duplicates between the two lists; leave out what isn't work (a decision to make, "keep an eye on").
- title: at most ${TITLE} characters, imperative ("Add retries to the webhook sender").
- description: plain markdown, 2 to 5 sentences: what to do, why (the decision's reasoning), and how to tell it's done.

## The question
${cut(o.question, 1000)}

## Actions (the decision's next actions, then the whiteboard's)
${o.actions.map((a) => `- ${a}`).join('\n') || '- (none listed: take them from the decision)'}

## The decision
${cut(o.decision, 6000)}`
}

// The model's answer → drafts; anything that isn't one is left out.
export function parseDrafts(text: string): Draft[] {
  let list: unknown
  try {
    list = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  return list
    .flatMap((x: { title?: unknown; description?: unknown }) => {
      const title = typeof x?.title === 'string' ? oneLine(x.title) : ''
      const description = typeof x?.description === 'string' ? x.description.trim() : ''
      return title ? [{ title: cut(title, TITLE), description: cut(description, 2000) }] : []
    })
    .slice(0, MAX_DRAFTS)
}

// Without the clerk's drafts: one per action, as it was said.
export const plainDrafts = (actions: string[]): Draft[] =>
  actions.slice(0, MAX_DRAFTS).map((a) => ({ title: cut(a, TITLE), description: a }))

// Drafts by the workspace's clerk model; its own drafts when it can't.
export async function draftIssues(o: {
  key: string
  model: string
  question: string
  decision: string
  actions: string[]
}): Promise<Draft[]> {
  try {
    const r = await chat(
      o.key,
      { model: o.model, messages: [{ role: 'user', content: draftPrompt(o) }] },
      60_000
    )
    const drafts = parseDrafts(r.choices?.[0]?.message?.content ?? '')
    if (drafts.length) return drafts
  } catch (e) {
    console.error('issues: no drafts from the clerk:', e instanceof Error ? e.message : e)
  }
  return plainDrafts(o.actions)
}

// What each issue says of where it came from, under its description.
export const footer = (o: { decision: string; link: string; by: string }): string =>
  `From the Consortium decision “${o.decision}”${o.link ? `: ${o.link}` : ''}\nRequested by ${o.by} in Slack.`

export const withFooter = (d: Draft, foot: string): Draft => ({
  title: d.title,
  description: `${cut(d.description, DESCRIPTION - foot.length - 2)}\n\n${foot}`.trim()
})

// ---------- Linear's tools ----------

// The tools that create an issue and list teams and projects, by the names Linear's server
// gives them (2026-10: save_issue, list_teams, list_projects; create_issue before).
export function linearTools(
  tools: { name: string }[]
): { create: string; teams?: string; projects?: string } | undefined {
  const names = tools.map((t) => t.name)
  const first = (...re: RegExp[]): string | undefined =>
    re.map((r) => names.find((n) => r.test(n))).find(Boolean)
  const create = first(/^create_issue$/, /^save_issue$/, /^(create|save)_?issues?$/i)
  if (!create) return undefined
  return {
    create,
    teams: first(/^list_teams$/, /^list_?teams$/i),
    projects: first(/^list_projects$/, /^list_?projects$/i)
  }
}

// The workspace's Linear, connected, with a tool that creates issues (as it listed them last).
export const linearOf = (conns: Connection[]): Connection | undefined =>
  conns.find((c) => c.id === 'linear' && c.secret && c.tools && linearTools(c.tools))

const props = (schema: Record<string, unknown>): string[] =>
  Object.keys((schema.properties ?? {}) as object)

// The arguments for creating one issue, in the names the tool's own schema uses. Never an id:
// save_issue updates the issue it names.
export function issueArgs(
  schema: Record<string, unknown>,
  d: Draft,
  team: string,
  project?: string
): Record<string, unknown> {
  const has = props(schema)
  const pick = (...n: string[]): string | undefined => n.find((x) => has.includes(x))
  const out: Record<string, unknown> = { [pick('title', 'name') ?? 'title']: d.title }
  const desc = pick('description', 'body')
  if (desc && d.description) out[desc] = d.description
  out[pick('teamId', 'team') ?? 'team'] = team
  const p = pick('projectId', 'project')
  if (p && project) out[p] = project
  return out
}

// A list tool's arguments: as many as it gives at once, when it takes a limit.
export function listArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const n = props(schema).find((k) => /^(limit|first|page_size)$/.test(k))
  return n ? { [n]: 100 } : {}
}

const json = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    const i = text.search(/[[{]/)
    try {
      return i < 0 ? undefined : JSON.parse(text.slice(i))
    } catch {
      return undefined
    }
  }
}

// Teams or projects in a list tool's answer: the objects with an id and a name, however nested.
export function parseItems(text: string): Item[] {
  const out: Item[] = []
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (typeof o.id === 'string' && typeof o.name === 'string')
      return void out.push({ id: o.id, name: o.name })
    Object.values(o).forEach(walk)
  }
  walk(json(text))
  return out.filter((x, i) => out.findIndex((y) => y.id === x.id) === i)
}

// The issue a create answered with: its identifier (ENG-123) and URL.
export function issueRef(text: string): { identifier?: string; url?: string } {
  let identifier: string | undefined
  let url: string | undefined
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (!identifier && typeof o.identifier === 'string') identifier = o.identifier
    if (!url && typeof o.url === 'string' && /^https:\/\//.test(o.url)) url = o.url
    Object.values(o).forEach(walk)
  }
  walk(json(text))
  identifier ??= text.match(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/)?.[0]
  url ??= text.match(/https:\/\/linear\.app\/[^\s"')\]]+/)?.[0]
  return { ...(identifier && { identifier }), ...(url && { url }) }
}

// Linear's teams and projects, for the modal's selects.
export async function linearLists(
  s: Pick<Open, 'url' | 'headers'>,
  fetchFn: FetchLike = publicFetch
): Promise<{ teams: Item[]; projects: Item[]; error?: string }> {
  const { client, tools } = await connect(s, fetchFn, LIMITS.openMs)
  try {
    const names = linearTools(tools)
    const list = async (name?: string): Promise<Item[]> => {
      const t = name && tools.find((x) => x.name === name)
      if (!t) return []
      const r = (await client.callTool(
        { name: t.name, arguments: listArgs(t.inputSchema) },
        { timeout: LIMITS.callMs }
      )) as CallToolResult
      const text = resultText(r)
      if (r.isError) throw new Error(text)
      return parseItems(text)
    }
    const [teams, projects] = await Promise.allSettled([list(names?.teams), list(names?.projects)])
    const why = [teams, projects].find((x) => x.status === 'rejected')
    return {
      teams: teams.status === 'fulfilled' ? teams.value : [],
      projects: projects.status === 'fulfilled' ? projects.value : [],
      ...(why && { error: String((why as PromiseRejectedResult).reason?.message ?? why) })
    }
  } finally {
    void client.close().catch(() => {})
  }
}

// One call of Linear's create tool per draft, in order; each failure with Linear's own words.
// Nothing is tried twice: a call that timed out may still have made its issue.
export async function createIssues(
  s: Pick<Open, 'url' | 'headers'>,
  drafts: Draft[],
  team: string,
  project?: string,
  fetchFn: FetchLike = publicFetch
): Promise<Created> {
  const { client, tools } = await connect(s, fetchFn, LIMITS.openMs)
  try {
    const name = linearTools(tools)?.create
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error("Linear doesn't list a tool that creates issues.")
    const out: Created = { created: [], failed: [] }
    for (const d of drafts)
      try {
        const r = (await client.callTool(
          { name: t.name, arguments: issueArgs(t.inputSchema, d, team, project) },
          { timeout: LIMITS.callMs }
        )) as CallToolResult
        const text = resultText(r)
        if (r.isError) out.failed.push({ title: d.title, error: cut(text, 500) })
        else out.created.push({ title: d.title, ...issueRef(text) })
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        out.failed.push({ title: d.title, error: cut(`${why} (check Linear: it may exist)`, 500) })
      }
    return out
  } finally {
    void client.close().catch(() => {})
  }
}

// ---------- once per decision ----------

const making = new Map<string, Promise<IssuesRecord>>()

// A decision's issues, made once: a double click, a second person, a second modal all get the
// first one's record. Kept before the first call, so a restart midway never makes them again; a
// Linear that didn't connect made nothing, so that leaves no record.
// ponytail: the lock is in memory, one instance; the record covers restarts
export function once(
  store: Store,
  id: string,
  by: string,
  make: () => Promise<Created>,
  now = Date.now()
): Promise<{ rec: IssuesRecord; fresh: boolean }> {
  const running = making.get(id)
  if (running) return running.then((rec) => ({ rec, fresh: false }))
  let fresh = false
  const p = (async (): Promise<IssuesRecord> => {
    const had = await store.get<IssuesRecord>('linear-issues', id)
    if (had) return had
    fresh = true
    await store.put('linear-issues', id, { by, at: now })
    let made: Created
    try {
      made = await make()
    } catch (e) {
      await store.del('linear-issues', id)
      throw e
    }
    const rec: IssuesRecord = { by, at: now, ...made, done: true }
    await store.put('linear-issues', id, rec)
    return rec
  })().finally(() => making.delete(id))
  making.set(id, p)
  return p.then((rec) => ({ rec, fresh }))
}

// ---------- the modal ----------

const plain = (text: string): types.PlainTextElement => ({ type: 'plain_text', text })
const option = (value: string, text: string): types.PlainTextOption => ({
  value,
  text: plain(cut(text, 75))
})
const context = (text: string): types.KnownBlock => ({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: cut(text, 3000) }]
})
const MAX_OPTIONS = 100

export type IssuesMeta = { thread: string; id: string; channel: string; message: string; n: number }

// The drafts to check and edit, Linear's team (and project) to put them in.
export function issuesModal(o: {
  drafts: Draft[]
  teams: Item[]
  projects: Item[]
  meta: Omit<IssuesMeta, 'n'>
  decision: string
  note?: string
}): types.ModalView {
  const drafts = o.drafts.slice(0, MAX_DRAFTS)
  const teams = o.teams.slice(0, MAX_OPTIONS).map((t) => option(t.id, t.name))
  const projects = o.projects.slice(0, MAX_OPTIONS).map((p) => option(p.id, p.name))
  const yes = option('yes', 'Create this issue')
  const meta: IssuesMeta = { ...o.meta, n: drafts.length }
  return {
    type: 'modal',
    callback_id: 'issues_modal',
    private_metadata: JSON.stringify(meta),
    title: plain('Linear issues'),
    submit: plain('Create issues'),
    close: plain('Cancel'),
    blocks: [
      context(
        `${drafts.length} draft${drafts.length === 1 ? '' : 's'} from *${mrk(cut(o.decision, 200))}*. Uncheck what you don't want, edit the rest; Create makes them in Linear with this workspace's connection, once.${o.note ? `\n${o.note}` : ''}`
      ),
      {
        type: 'input',
        block_id: 'team',
        label: plain('Team'),
        element: {
          type: 'static_select',
          action_id: 'team',
          placeholder: plain('Pick a team'),
          options: teams,
          ...(teams.length === 1 && { initial_option: teams[0] })
        }
      },
      ...(projects.length
        ? [
            {
              type: 'input' as const,
              block_id: 'project',
              optional: true,
              label: plain('Project'),
              element: {
                type: 'static_select' as const,
                action_id: 'project',
                placeholder: plain('No project'),
                options: projects
              }
            }
          ]
        : []),
      ...drafts.flatMap((d, i): types.KnownBlock[] => [
        { type: 'divider' },
        {
          type: 'input',
          block_id: `pick${i}`,
          optional: true,
          label: plain(`Issue ${i + 1}`),
          element: {
            type: 'checkboxes',
            action_id: 'pick',
            options: [yes],
            initial_options: [yes]
          }
        },
        {
          type: 'input',
          block_id: `title${i}`,
          label: plain('Title'),
          element: {
            type: 'plain_text_input',
            action_id: 'title',
            max_length: TITLE,
            initial_value: cut(d.title, TITLE)
          }
        },
        {
          type: 'input',
          block_id: `desc${i}`,
          optional: true,
          label: plain('Description'),
          element: {
            type: 'plain_text_input',
            action_id: 'desc',
            multiline: true,
            max_length: DESCRIPTION,
            initial_value: cut(d.description, DESCRIPTION)
          }
        }
      ])
    ]
  }
}

type Values = Record<
  string,
  Record<
    string,
    {
      value?: string | null
      selected_option?: { value: string } | null
      selected_options?: { value: string }[] | null
    }
  >
>

// The modal's answers: the checked drafts as edited, the team and project; or what's wrong.
export function readIssues(
  values: Values,
  n: number
): { team: string; project?: string; drafts: Draft[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const drafts: Draft[] = []
  for (let i = 0; i < n; i++) {
    if (!values[`pick${i}`]?.pick?.selected_options?.length) continue
    const title = oneLine(values[`title${i}`]?.title?.value ?? '')
    if (!title) errors[`title${i}`] = 'Give it a title, or uncheck it.'
    else drafts.push({ title, description: (values[`desc${i}`]?.desc?.value ?? '').trim() })
  }
  const team = values.team?.team?.selected_option?.value
  const project = values.project?.project?.selected_option?.value
  if (!team) errors.team = 'Pick the team the issues go to.'
  if (!drafts.length && !Object.keys(errors).some((k) => k.startsWith('title')))
    errors[n ? 'pick0' : 'team'] = 'Check at least one issue.'
  return Object.keys(errors).length
    ? { errors }
    : { team: team!, ...(project && { project }), drafts }
}

const ref = (c: Created['created'][number]): string =>
  c.url ? `<${c.url}|${mrk(c.identifier ?? 'Open')}>` : mrk(c.identifier ?? '(no link came back)')

// mrkdwn lines, in sections of at most 3,000 characters
const sections = (lines: string[]): types.KnownBlock[] => {
  const out: string[] = []
  for (const l of lines.map((x) => cut(x, 2900)))
    if (out.length && out[out.length - 1].length + l.length + 1 <= 3000)
      out[out.length - 1] += `\n${l}`
    else out.push(l)
  return out.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }))
}

// What happened: the issues made, the ones that failed with Linear's words, or a cut-off run.
export function resultModal(rec: IssuesRecord): types.ModalView {
  const created = rec.created ?? []
  const failed = rec.failed ?? []
  const lines = !rec.done
    ? [
        `:warning: <@${rec.by}> started creating this decision's issues and it was cut off midway. Check Linear for them: Consortium won't create them again.`
      ]
    : [
        created.length
          ? `:white_check_mark: *${created.length} issue${created.length > 1 ? 's' : ''} created in Linear* by <@${rec.by}>`
          : `:x: *No issue was created* (<@${rec.by}> tried).`,
        ...created.map((c) => `• ${ref(c)} ${mrk(c.title)}`),
        ...(failed.length
          ? [
              `:x: *${failed.length} didn't go through.* Linear said:`,
              ...failed.map((f) => `• *${mrk(f.title)}*: ${mrk(f.error)}`),
              '_Consortium makes a decision’s issues once; create these in Linear by hand._'
            ]
          : [])
      ]
  return {
    type: 'modal',
    title: plain('Linear issues'),
    close: plain('Close'),
    blocks: sections(lines).slice(0, 100)
  }
}

// The thread's message once they're made.
export function issuesLine(rec: IssuesRecord): string {
  const created = rec.created ?? []
  const failed = rec.failed ?? []
  const made = created.length
    ? `<@${rec.by}> created ${created.length} Linear issue${created.length > 1 ? 's' : ''} from this decision: ${created.map((c) => `${ref(c)} ${mrk(c.title)}`).join(' · ')}`
    : `<@${rec.by}> tried to create Linear issues from this decision; none went through.`
  const not = failed.map((f) => `• ${mrk(f.title)}: ${mrk(cut(oneLine(f.error), 200))}`)
  return cut(
    [`:clipboard: ${made}`, ...(not.length ? ["Linear didn't take these:", ...not] : [])].join(
      '\n'
    ),
    3000
  )
}
