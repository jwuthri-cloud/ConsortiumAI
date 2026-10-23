import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import * as debate from './debate'
import { checkCli, detectBins, killAll, listModels, type runMember } from './cli'
import { listKeys } from './keys'
import { dataDir } from './paths'
import { DEFAULT_MODEL } from '../shared/models'
import { PERSONA_IDS } from '../shared/personas'
import {
  CLI_META,
  splitModel,
  type Brief,
  type Cli,
  type DebateEvent,
  type Member,
  type PersonaId
} from '../shared/types'
import type { HostInput } from '../shared/whiteboard'

// The meeting engine over HTTP, without the desktop app: `npm run api`.
// Same engine, same sessions folder as the app; one meeting at a time per server.

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export const ENDED = new Set<DebateEvent['type']>(['consortium', 'stopped', 'failed'])
// The API has no voices: the engine never speaks, and audio events never reach a client.
export const SILENT = {
  enabled: (): boolean => false,
  filler: (): undefined => undefined,
  readAloud: async (): Promise<number> => 0
}
const AUDIO = new Set<DebateEvent['type']>(['voice', 'voice-error'])

// A caller's brief: members need only a cli; ids, roles, models and the chair are filled in.
export function toBrief(input: unknown): Brief {
  const body = (input ?? {}) as Record<string, unknown>
  const bad = (msg: string): never => {
    throw new HttpError(400, msg)
  }
  if (typeof body.task !== 'string' || !body.task.trim()) bad('task: the question, as a string')
  const raw = Array.isArray(body.members) ? (body.members as Record<string, unknown>[]) : []
  if (raw.length < 2 || raw.length > 6)
    bad('members: 2 to 6 seats, like [{"cli":"claude"},{"cli":"codex"}]')
  const used = new Set<string>()
  const members: Member[] = raw.map((m, i) => {
    const cli = m?.cli as Cli
    if (!(cli in CLI_META)) bad(`members[${i}].cli: one of ${Object.keys(CLI_META).join(', ')}`)
    const persona = (m.persona ?? PERSONA_IDS.find((p) => !used.has(p)) ?? 'skeptic') as PersonaId
    if (!PERSONA_IDS.includes(persona))
      bad(`members[${i}].persona: one of ${PERSONA_IDS.join(', ')}`)
    used.add(persona)
    const model =
      typeof m.model === 'string' && m.model.trim() ? m.model.trim() : DEFAULT_MODEL[cli]
    if (cli === 'harness' && !splitModel(model).model)
      bad(
        `members[${i}].model: the Deep-agent needs "provider:model", like "openrouter:z-ai/glm-5.3"`
      )
    return { id: typeof m.id === 'string' && m.id ? m.id : `m${i + 1}`, cli, model, persona }
  })
  if (new Set(members.map((m) => m.id)).size !== members.length) bad('members: ids must be unique')
  const chairId = typeof body.chairId === 'string' ? body.chairId : members[0].id
  if (!members.some((m) => m.id === chairId)) bad('chairId: the id of one of the members')
  const maxTurns = body.maxTurns === undefined ? 30 : Number(body.maxTurns)
  if (!Number.isInteger(maxTurns) || maxTurns < members.length * 2 || maxTurns > 100)
    bad(`maxTurns: a whole number from ${members.length * 2} to 100`)
  const projectPath = typeof body.projectPath === 'string' ? body.projectPath : undefined
  if (projectPath && !(existsSync(projectPath) && statSync(projectPath).isDirectory()))
    bad('projectPath: no such folder on the server')
  const attachments = Array.isArray(body.attachments) ? (body.attachments as string[]) : undefined
  for (const f of attachments ?? [])
    if (typeof f !== 'string' || !existsSync(f))
      bad(`attachments: no such file on the server: ${f}`)
  const board = body.board as { cli?: Cli; model?: string } | undefined
  if (board && !(board.cli && board.cli in CLI_META)) bad('board.cli: one of the connections')
  return {
    task: body.task as string,
    projectPath,
    attachments: attachments?.length ? attachments : undefined,
    members,
    chairId,
    maxTurns,
    board: board?.cli ? { cli: board.cli, model: board.model } : undefined
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw new HttpError(413, 'body: over 1 MB')
  }
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body: not valid JSON')
  }
}

function reply(res: ServerResponse, status: number, data: unknown): void {
  const text = typeof data === 'string'
  res.writeHead(status, {
    'content-type': text ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8'
  })
  res.end(text ? data : JSON.stringify(data, null, 2))
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '')
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

type Options = { token: string; dir?: string; run?: typeof runMember }

export function createApi({ token, dir = dataDir(), run }: Options): Server {
  debate.configure(dir)
  const listeners = new Set<(e: DebateEvent) => void>()
  let active: string | null = null
  // the running meeting's events so far, so a stream opened late (or reopened) starts at turn one
  // ponytail: kept in memory for the one running meeting; a 30-turn meeting is a few MB at most
  let log: DebateEvent[] = []
  const send = (e: DebateEvent): void => {
    if (AUDIO.has(e.type)) return
    if (e.sessionId === active) log.push(e)
    if (ENDED.has(e.type) && e.sessionId === active) active = null
    for (const l of listeners) l(e)
  }
  // resolves with the meeting's last event: its decision, a stop, or a failure
  const ended = (id: string): Promise<DebateEvent> =>
    new Promise((resolve) => {
      const l = (e: DebateEvent): void => {
        if (e.sessionId !== id || !ENDED.has(e.type)) return
        listeners.delete(l)
        resolve(e)
      }
      listeners.add(l)
    })
  const own = (id: string): void => {
    if (active !== id) throw new HttpError(409, `meeting ${id} is not running here`)
  }
  const outcome = (id: string): unknown => {
    const s = debate.loadSession(id)
    return { id, status: s?.status, decision: s?.consortium?.markdown, path: s?.consortium?.path }
  }

  const routes = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const [root, id, action] = url.pathname.split('/').filter(Boolean)
    const route = `${req.method} /${[root, id && ':id', action].filter(Boolean).join('/')}`

    switch (route) {
      case 'GET /health':
        return reply(res, 200, { ok: true, running: active, clis: detectBins(), keys: listKeys() })
      case 'GET /models/:id':
        if (!(id in CLI_META)) throw new HttpError(404, `no connection called ${id}`)
        return reply(res, 200, await listModels(id as Cli))
      case 'POST /check': {
        const { cli, model } = (await readJson(req)) as { cli?: Cli; model?: string }
        if (!cli || !(cli in CLI_META)) throw new HttpError(400, 'cli: one of the connections')
        return reply(res, 200, await checkCli(cli, model))
      }
      case 'GET /meetings':
        return reply(res, 200, debate.listSessions())
      case 'POST /meetings': {
        const brief = toBrief(await readJson(req))
        if (active && url.searchParams.get('replace') !== '1')
          throw new HttpError(409, `meeting ${active} is running; stop it, or add ?replace=1`)
        if (active) debate.stop(active) // ?replace=1
        const meetingId = randomUUID()
        const done = ended(meetingId)
        active = meetingId
        log = []
        debate.runDebate(brief, send, meetingId, undefined, run, SILENT)
        // ?wait=1: hold the request until the decision is written (minutes), then return it
        if (url.searchParams.get('wait') !== '1') return reply(res, 201, { id: meetingId })
        await done
        return reply(res, 200, outcome(meetingId))
      }
      case 'GET /meetings/:id': {
        const s = debate.loadSession(id)
        if (!s) throw new HttpError(404, `no meeting ${id}`)
        return reply(res, 200, s)
      }
      case 'DELETE /meetings/:id':
        if (active === id) throw new HttpError(409, 'stop the meeting first')
        debate.deleteSession(id)
        return reply(res, 200, { deleted: id })
      case 'GET /meetings/:id/decision': {
        const md = debate.loadSession(id)?.consortium?.markdown
        if (!md) throw new HttpError(404, 'no decision yet')
        return reply(res, 200, md)
      }
      case 'GET /meetings/:id/events':
        return events(res, id)
      case 'POST /meetings/:id/stop':
        own(id)
        debate.stop(id)
        return reply(res, 200, { stopped: id })
      case 'POST /meetings/:id/pause':
      case 'POST /meetings/:id/unpause':
        own(id)
        debate.pause(id, action === 'pause')
        return reply(res, 200, { paused: action === 'pause' })
      case 'POST /meetings/:id/conclude':
        own(id)
        debate.conclude(id)
        return reply(res, 200, { concluding: id })
      case 'POST /meetings/:id/messages': {
        own(id)
        const m = (await readJson(req)) as Partial<HostInput>
        if (typeof m.text !== 'string' || !m.text.trim())
          throw new HttpError(400, 'text: what you say')
        const kind = m.kind ?? 'thought'
        if (!['thought', 'ask', 'focus'].includes(kind))
          throw new HttpError(400, 'kind: thought, ask or focus')
        if (kind === 'ask' && !m.targetId) throw new HttpError(400, 'targetId: the member to ask')
        debate.host(id, { id: randomUUID(), kind, text: m.text.trim(), targetId: m.targetId })
        return reply(res, 202, { queued: true })
      }
      case 'POST /meetings/:id/resume': {
        const s = debate.loadSession(id)
        if (!s) throw new HttpError(404, `no meeting ${id}`)
        if (s.status === 'done') throw new HttpError(409, 'this meeting is already decided')
        if (active && active !== id) throw new HttpError(409, `meeting ${active} is running`)
        active = id
        log = []
        debate.runDebate(s.brief, send, id, s, run, SILENT)
        return reply(res, 202, { resumed: id })
      }
    }
    throw new HttpError(404, `${req.method} ${url.pathname}: no such route`)
  }

  // Server-sent events for a running meeting; the stream ends with its last event.
  function events(res: ServerResponse, id: string): void {
    if (active !== id) {
      const s = debate.loadSession(id)
      if (!s) throw new HttpError(404, `no meeting ${id}`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`event: ended\ndata: ${JSON.stringify({ status: s.status })}\n\n`)
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
    const l = (e: DebateEvent): void => {
      if (e.sessionId !== id) return
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      if (ENDED.has(e.type)) close()
    }
    const close = (): void => {
      clearInterval(ping)
      listeners.delete(l)
      res.end()
    }
    for (const e of log) l(e) // catch up, then live
    listeners.add(l)
    res.on('close', close)
  }

  return createServer((req, res) => {
    if (!authorized(req, token)) {
      reply(res, 401, { error: 'unauthorized: send Authorization: Bearer <token>' })
      return
    }
    routes(req, res).catch((e) => {
      if (res.headersSent) res.end()
      else
        reply(res, e instanceof HttpError ? e.status : 500, {
          error: e instanceof Error ? e.message : String(e)
        })
    })
  })
}

// The token every request must carry: $CONSORTIUM_API_TOKEN, or one made once and kept in the data folder.
function apiToken(): string {
  if (process.env.CONSORTIUM_API_TOKEN) return process.env.CONSORTIUM_API_TOKEN
  const file = join(dataDir(), 'api-token')
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    const token = randomBytes(24).toString('base64url')
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
    return token
  }
}

export function serve(): Server {
  const port = Number(process.env.CONSORTIUM_PORT ?? 4317)
  const host = process.env.CONSORTIUM_HOST ?? '127.0.0.1' // this machine only, unless you say otherwise
  const token = apiToken()
  const server = createApi({ token })
  server.listen(port, host, () =>
    console.log(
      `Consortium API on http://${host}:${port} (data: ${dataDir()})\n` +
        `Token: ${token}\n` +
        `Try:   curl -H "Authorization: Bearer ${token}" http://${host}:${port}/health`
    )
  )
  const quit = (): void => {
    killAll()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', quit)
  process.on('SIGTERM', quit)
  return server
}

if (require.main === module) serve()
