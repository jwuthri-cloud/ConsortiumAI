import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_META,
  HUMAN,
  type Brief,
  type DebateEvent,
  type Phase,
  type Session,
  type SessionSummary,
  type Shape,
  type Turn,
  type Vote
} from '../shared/types'
import { PERSONAS, makeLabels } from '../shared/personas'
import { extractVote, extractJson, stripVote } from '../shared/vote'
import { runMember, killAll } from './cli'
import * as P from './prompts'

type Send = (e: DebateEvent) => void

let userData = ''
// ponytail: one debate at a time; a second start stops the first.
let current: { id: string; cancelled: boolean; interjections: string[] } | null = null

export function configure(dir: string): void {
  userData = dir
  mkdirSync(join(userData, 'sessions'), { recursive: true })
}

export function interject(text: string): void {
  current?.interjections.push(text)
}

export function stop(): void {
  if (!current) return
  current.cancelled = true
  killAll()
}

function save(s: Session): void {
  writeFileSync(join(userData, 'sessions', `${s.id}.json`), JSON.stringify(s))
}

export function listSessions(): SessionSummary[] {
  const dir = join(userData, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Session
        if (s.version !== 2) return null
        return { id: s.id, createdAt: s.createdAt, task: s.brief.task, status: s.status }
      } catch {
        return null
      }
    })
    .filter((x): x is SessionSummary => !!x)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function loadSession(id: string): Session | null {
  const f = join(userData, 'sessions', `${id}.json`)
  if (!existsSync(f)) return null
  const s = JSON.parse(readFileSync(f, 'utf8')) as Session
  return s.version === 2 ? s : null
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'consortium'
  )
}

export function latestVotes(turns: Turn[]): Record<string, Vote | null> {
  const v: Record<string, Vote | null> = {}
  for (const t of turns) if (t.speaker !== HUMAN && t.vote) v[t.speaker] = t.vote
  return v
}

function appendix(s: Session, votes: Record<string, Vote | null>): string {
  const { brief, labels } = s
  const ids = brief.members.map((m) => m.id)
  const cell = (a: string, b: string): string => {
    if (a === b) return '—'
    const v = votes[a]
    if (!v) return '·'
    if (v.disagreements.some((d) => d.with === labels[b])) return '✗'
    if (v.agrees_with.includes(labels[b])) return '✓'
    return '·'
  }
  const header = `| | ${ids.map((id) => labels[id]).join(' | ')} |\n|---|${ids.map(() => '---').join('|')}|`
  const rows = ids
    .map((a) => `| ${labels[a]} | ${ids.map((b) => cell(a, b)).join(' | ')} |`)
    .join('\n')
  const panel = brief.members
    .map(
      (m) =>
        `| ${labels[m.id]} | ${PERSONAS[m.persona].label.replace('The ', '')} | ${CLI_META[m.cli].name} | ${m.model || 'default'}${m.id === brief.chairId ? ' · chair' : ''} |`
    )
    .join('\n')
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN)
  const cost = memberTurns.reduce((acc, t) => acc + (t.costUsd ?? 0), 0)
  return `---

## Agreement matrix
Row agrees (✓) or disagrees (✗) with column, from each member's final vote.

${header}
${rows}

## Panel
| Label | Lens | CLI | Model |
|---|---|---|---|
${panel}

${memberTurns.length} turns · ${s.converged ? 'full consensus' : 'dissent recorded'}${cost ? ` · reported cost $${cost.toFixed(2)}` : ''} · ${new Date(s.createdAt).toLocaleString()}
`
}

function validShape(x: unknown): Shape | null {
  const s = x as Shape
  if (!s || !Array.isArray(s.converging) || !Array.isArray(s.open)) return null
  return {
    converging: s.converging
      .filter((c) => c && typeof c.point === 'string')
      .map((c) => ({
        point: c.point,
        supporters: Array.isArray(c.supporters)
          ? c.supporters.filter((l) => typeof l === 'string')
          : []
      }))
      .slice(0, 4),
    open: s.open
      .filter((o) => o && typeof o.point === 'string')
      .map((o) => ({ point: o.point, sides: typeof o.sides === 'string' ? o.sides : '' }))
      .slice(0, 4)
  }
}

export function phaseOf(n: number, members: number, budget: number): Phase {
  if (n <= members) return 'open'
  if (n > budget - members) return 'decide'
  if (n > Math.floor(budget * 0.6)) return 'converge'
  return 'debate'
}

// The renderer picks the id so it can attribute events that arrive before the invoke resolves.
export function runDebate(brief: Brief, send: Send, id: string = randomUUID()): string {
  stop()
  const me = { id, cancelled: false, interjections: [] as string[] }
  current = me
  const labels = makeLabels(brief.members)
  const session: Session = {
    version: 2,
    id,
    createdAt: new Date().toISOString(),
    brief,
    labels,
    turns: [],
    shape: null,
    converged: false,
    status: 'running'
  }
  const members = brief.members
  const N = members.length
  const chairMember = members.find((m) => m.id === brief.chairId) ?? members[0]
  const cliSessions: Record<string, string | undefined> = {}
  const seen: Record<string, number> = {} // how much of the transcript each member has been shown
  const lastError: Record<string, string | undefined> = {}
  const transcript = session.turns
  const emit = (e: DebateEvent): void => {
    if (current === me) send(e)
  }

  const drainHuman = (n: number): void => {
    for (const text of me.interjections.splice(0)) {
      const t: Turn = { n, speaker: HUMAN, label: 'The Human', text, vote: null }
      transcript.push(t)
      emit({ sessionId: id, type: 'human', turn: t })
    }
  }

  let clerkBusy = false
  const takeNotes = (n: number): void => {
    if (clerkBusy) return
    clerkBusy = true
    const recent = transcript.slice(-2 * N - 2)
    runMember(
      chairMember.cli,
      { prompt: P.clerk(brief, labels, recent, latestVotes(transcript)), model: chairMember.model },
      () => {},
      `${id}:clerk:${n}`
    )
      .then((r) => {
        const shape = validShape(extractJson<Shape>(r.text))
        if (!shape) return
        session.shape = shape
        save(session)
        emit({ sessionId: id, type: 'shape', turn: n, shape })
      })
      .catch(() => {
        /* the notes just stay as they were */
      })
      .finally(() => {
        clerkBusy = false
      })
  }

  ;(async () => {
    try {
      for (let n = 1; n <= brief.maxTurns; n++) {
        const m = members[(n - 1) % N]
        const phase = phaseOf(n, N, brief.maxTurns)
        drainHuman(n)
        const since = transcript.slice(seen[m.id] ?? 0)
        seen[m.id] = transcript.length
        emit({ sessionId: id, type: 'turn-start', memberId: m.id, turn: n, phase })
        const prompt =
          phase === 'open'
            ? P.opening(brief, m, labels, since)
            : P.turn(brief, m, labels, since, phase, n, session.shape)
        try {
          const r = await runMember(
            m.cli,
            { prompt, model: m.model, cwd: brief.projectPath, resume: cliSessions[m.id] },
            (t) => emit({ sessionId: id, type: 'delta', memberId: m.id, turn: n, text: t }),
            `${id}:${m.id}`
          )
          cliSessions[m.id] = r.sessionId ?? cliSessions[m.id]
          const t: Turn = {
            n,
            speaker: m.id,
            label: labels[m.id],
            text: stripVote(r.text),
            vote: extractVote(r.text),
            costUsd: r.costUsd
          }
          transcript.push(t)
          seen[m.id] = transcript.length
          lastError[m.id] = undefined
          emit({ sessionId: id, type: 'turn-done', turn: t })
        } catch (e) {
          if (me.cancelled) throw e
          const message = e instanceof Error ? e.message : String(e)
          lastError[m.id] = message
          emit({ sessionId: id, type: 'turn-error', memberId: m.id, turn: n, message })
        }
        save(session)
        if (me.cancelled) throw new Error('stopped')
        if (n % N === 0) {
          // a full cycle after the openings with nobody disagreeing = done talking
          const votes = latestVotes(transcript)
          const converged =
            n > N &&
            members.every(
              (x) => !lastError[x.id] && votes[x.id] && votes[x.id]!.disagreements.length === 0
            )
          if (converged) {
            session.converged = true
            break
          }
          takeNotes(n)
        }
      }
      emit({ sessionId: id, type: 'chair-start', memberId: chairMember.id })
      const votes = latestVotes(transcript)
      const r = await runMember(
        chairMember.cli,
        {
          prompt: P.chair(
            brief,
            labels,
            transcript,
            votes,
            lastError,
            me.interjections.splice(0).join('\n\n')
          ),
          model: chairMember.model
        },
        (t) => emit({ sessionId: id, type: 'delta', memberId: chairMember.id, turn: 0, text: t }),
        `${id}:chair`
      )
      if (me.cancelled) throw new Error('stopped')
      const markdown = `${r.text.trim()}\n\n${appendix(session, votes)}`
      const dir = brief.projectPath
        ? join(brief.projectPath, 'consortium')
        : join(userData, 'consortium')
      mkdirSync(dir, { recursive: true })
      const path = join(
        dir,
        `${slug(brief.task)}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`
      )
      writeFileSync(path, markdown)
      session.consortium = { markdown, path }
      session.status = 'done'
      save(session)
      emit({ sessionId: id, type: 'consortium', markdown, path })
    } catch (e) {
      session.status = me.cancelled ? 'stopped' : 'failed'
      save(session)
      if (me.cancelled) emit({ sessionId: id, type: 'stopped' })
      else
        emit({ sessionId: id, type: 'failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (current === me) current = null
    }
  })()
  return id
}
