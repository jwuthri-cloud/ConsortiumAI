import { visualContext } from '../shared/boardVisuals'
import { createBoardWriter } from './whiteboard'
import type { HostInput, HostMessage } from '../shared/whiteboard'
import { memberModel, modelName } from '../shared/models'
import { summarize } from '../shared/summary'
import { addUsage, priced } from '../shared/usage'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  rmSync
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import {
  CLI_META,
  HUMAN,
  type Brief,
  type Member,
  type DebateEvent,
  type Phase,
  type Session,
  type SessionSummary,
  type TraceStep,
  type Turn,
  type Vote
} from '../shared/types'
import { PERSONAS, makeLabels } from '../shared/personas'
import { extractVote, sameLabel, stance, stripVote } from '../shared/vote'
import { runMember, killAll, killRun } from './cli'
import { getKey } from './keys'
import { filler, readAloud } from './voice'
import * as P from './prompts'
import { sources } from '../shared/cite'

type Send = (e: DebateEvent) => void

let userData = ''
// ponytail: one debate at a time; a second start stops the first.
let current: {
  id: string
  cancelled: boolean
  paused: boolean
  wake?: () => void
  concluding: boolean
  host: (input: HostInput) => void
  finish: () => void
  refreshBoard: () => void
  heard: Map<number, () => void> // turn → resolves when the renderer has played its answer
  raise: (on: boolean) => void
} | null = null

export function configure(dir: string): void {
  userData = dir
  mkdirSync(join(userData, 'sessions'), { recursive: true })
}

export function interject(text: string): void {
  host({ id: randomUUID(), kind: 'thought', text })
}

export function host(input: HostInput): void {
  if (!current || current.cancelled) throw new Error('There is no active meeting.')
  current.host(input)
}
export function conclude(): void {
  if (!current || current.cancelled) throw new Error('There is no active meeting.')
  current.finish()
}
export function refreshBoard(): void {
  if (!current || current.cancelled) throw new Error('There is no active meeting.')
  current.refreshBoard()
}

// ponytail: pause lands between turns; the member already speaking finishes first.
export function pause(on: boolean): void {
  if (!current) return
  current.paused = on
  if (!on) current.wake?.()
}

// The human raises a hand: the meeting holds, and the seat preparing its turn stops and takes it
// again after the human has spoken, so it hears them. Lowering the hand resumes.
export function raiseHand(on: boolean): void {
  if (!current || current.cancelled) throw new Error('There is no active meeting.')
  current.raise(on)
}

export function stop(): void {
  if (!current) return
  current.cancelled = true
  current.wake?.()
  for (const done of current.heard.values()) done()
  killAll()
}

export function spoken(sessionId: string, turn: number): void {
  if (current?.id === sessionId) current.heard.get(turn)?.()
}

function sessionStatus(s: Session): Session['status'] {
  return s.status === 'running' && current?.id !== s.id ? 'stopped' : s.status
}

function save(s: Session): void {
  writeFileSync(join(userData, 'sessions', `${s.id}.json`), JSON.stringify(s))
}

// Meetings saved before their model had a price get one when read back.
function withPrices(s: Session): Session {
  if (!s.usage) return s
  const model = (id: string): string | undefined => {
    const m = s.brief.members.find((x) => x.id === (id === 'chair' ? s.brief.chairId : id))
    return m && memberModel(m)
  }
  const usage = Object.fromEntries(
    Object.entries(s.usage).map(([id, u]) => [id, priced(u, model(id))])
  )
  return { ...s, usage }
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
        return summarize(withPrices({ ...s, status: sessionStatus(s) }))
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
  return s.version === 2 ? withPrices({ ...s, status: sessionStatus(s) }) : null
}

// Removes the transcript and its copied attachments; a meeting still in progress is left alone.
export function deleteSession(id: string): void {
  if (current?.id === id) throw new Error('Stop this meeting before deleting it.')
  rmSync(join(userData, 'sessions', `${id}.json`), { force: true })
  rmSync(join(userData, 'attachments', id), { recursive: true, force: true })
}

// Copied into the session's own folder: stable across resumes, and the members can read that folder
// rather than wherever the human keeps the originals.
function keepAttachments(id: string, files: string[] = []): string[] {
  const dir = join(userData, 'attachments', id)
  return files.filter(existsSync).map((f) => {
    mkdirSync(dir, { recursive: true })
    let to = join(dir, basename(f))
    for (let i = 2; existsSync(to); i++) to = join(dir, `${i}-${basename(f)}`)
    copyFileSync(f, to)
    return to
  })
}

// Continue an unfinished session from its saved transcript.
export function resume(id: string, send: Send): void {
  if (current?.id === id && !current.cancelled) return
  const s = loadSession(id)
  if (s && s.status !== 'done') runDebate(s.brief, send, id, s)
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
  // one plain line per member: a grid made one-way backing look like a bug
  const line = (a: string): string => {
    const v = votes[a]
    if (!v) return `- **${labels[a]}** left no final vote.`
    const others = ids.filter((b) => b !== a)
    const backs = others.filter((b) => stance(v, labels[b]) === 'agree').map((b) => labels[b])
    const against = others
      .filter((b) => stance(v, labels[b]) === 'disagree')
      .map((b) => {
        const on = v.disagreements.find((d) => sameLabel(d.with, labels[b]))?.on
        return on ? `${labels[b]} (${on})` : labels[b]
      })
    const said = [
      backs.length && `backs ${backs.join(', ')}`,
      against.length && `disagrees with ${against.join(', ')}`
    ].filter(Boolean)
    return `- **${labels[a]}** ${said.length ? said.join('; ') : 'named no one'}.`
  }
  const rows = ids.map(line).join('\n')
  const panel = brief.members
    .map(
      (m) =>
        `| ${labels[m.id]} | ${PERSONAS[m.persona].label.replace('The ', '')} | ${CLI_META[m.cli].name} | ${memberModel(m) || 'Not recorded'}${m.id === brief.chairId ? ' · chair' : ''} |`
    )
    .join('\n')
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN)
  const cost = memberTurns.reduce((acc, t) => acc + (t.costUsd ?? 0), 0)
  return `---

## Final votes
What each member said about the others in its last vote. Backing is one-way: a member can back another that never named it back.

${rows}

## Panel
| Label | Lens | CLI | Model |
|---|---|---|---|
${panel}

${memberTurns.length} turns · ${s.converged ? 'full consensus' : 'dissent recorded'}${cost ? ` · reported cost $${cost.toFixed(2)}` : ''} · ${new Date(s.createdAt).toLocaleString()}
`
}

// Everything the table said and did, turn by turn: the record behind the decision document.
export function fullTranscript(s: Session): string {
  const { brief, labels } = s
  const seat = (id: string): string => {
    const m = brief.members.find((x) => x.id === id)
    return m ? `${CLI_META[m.cli].name} · ${memberModel(m) || 'model not recorded'}` : ''
  }
  const seats = brief.members
    .map(
      (m) =>
        `| ${labels[m.id]} | ${PERSONAS[m.persona].label.replace('The ', '')} | ${CLI_META[m.cli].name} | ${memberModel(m) || 'Not recorded'}${m.id === brief.chairId ? ' · chair' : ''} |`
    )
    .join('\n')
  const step = (t: TraceStep): string =>
    t.kind === 'tool'
      ? `- 🔧 \`${t.name}\`${t.detail ? ` ${t.detail.replace(/\s+/g, ' ')}` : ''}`
      : t.text
        ? `- 💭 ${t.text.replace(/\s+/g, ' ')}`
        : `- 💭 thought privately${t.tokens ? ` (~${t.tokens} tokens)` : ''}`
  const turns = s.turns
    .map((t) => {
      const who = t.speaker === HUMAN ? 'Host' : `${t.label} (${seat(t.speaker)})`
      const parts = [`## Turn ${t.n} · ${who}`]
      if (t.trace?.length) parts.push(`### Trace\n${t.trace.map(step).join('\n')}`)
      parts.push(`### Message\n${t.text || '_(empty)_'}`)
      if (t.vote) parts.push(`### Vote\n\`\`\`json\n${JSON.stringify(t.vote, null, 2)}\n\`\`\``)
      if (t.error) parts.push(`**Error:** ${t.error}`)
      if (t.costUsd) parts.push(`_reported cost $${t.costUsd.toFixed(4)}_`)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')
  const usage = Object.entries(s.usage ?? {})
    .map(
      ([id, u]) =>
        `| ${labels[id] ?? id} | ${u.input} | ${u.cached} | ${u.output} | ${u.costUsd != null ? `$${u.costUsd.toFixed(4)}${u.estimated ? ' (est.)' : ''}` : '—'} |`
    )
    .join('\n')
  return `# Transcript

**Question:** ${brief.task}

${new Date(s.createdAt).toLocaleString()} · ${brief.maxTurns} turn budget · session ${s.id}${brief.attachments?.length ? `\n\n**Attachments:** ${brief.attachments.map((a) => basename(a)).join(', ')}` : ''}

## Seats
| Label | Lens | CLI | Model |
|---|---|---|---|
${seats}

---

${turns}
${usage ? `\n---\n\n## Usage\n| Seat | Input | Cached | Output | Cost |\n|---|---|---|---|---|\n${usage}\n` : ''}`
}

export function phaseOf(n: number, members: number, budget: number): Phase {
  if (n <= members) return 'open'
  if (n > budget - members) return 'decide'
  if (n > Math.floor(budget * 0.6)) return 'converge'
  return 'debate'
}

// The renderer picks the id so it can attribute events that arrive before the invoke resolves.
export function runDebate(
  brief: Brief,
  send: Send,
  id: string = randomUUID(),
  prior?: Session,
  run: typeof runMember = runMember
): string {
  stop()
  if (!prior && brief.attachments?.length)
    brief = { ...brief, attachments: keepAttachments(id, brief.attachments) }
  const attachDir = brief.attachments?.length ? dirname(brief.attachments[0]) : undefined
  const me: NonNullable<typeof current> = {
    id,
    cancelled: false,
    paused: false,
    concluding: false,
    host: () => {},
    finish: () => {},
    refreshBoard: () => {},
    heard: new Map(),
    raise: () => {}
  }
  current = me
  const labels = makeLabels(brief.members)
  const session: Session = prior ?? {
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
  session.status = 'running'
  const members = brief.members
  const N = members.length
  const chairMember = members.find((m) => m.id === brief.chairId) ?? members[0]
  const cliSessions = (session.cliSessions ??= {})
  const seen: Record<string, number> = {} // how much of the transcript each member has been shown
  const lastError: Record<string, string | undefined> = {}
  const transcript = session.turns
  transcript.forEach((t, i) => {
    if (t.speaker !== HUMAN) seen[t.speaker] = i + 1
  })
  // a resumed session picks up after its last member turn
  const first = session.converged
    ? brief.maxTurns + 1
    : Math.max(0, ...transcript.filter((t) => t.speaker !== HUMAN).map((t) => t.n)) + 1
  const emit = (e: DebateEvent): void => {
    if (current === me) send(e)
  }
  // Every CLI call goes through here, so members, the whiteboard writer and the chair are all counted.
  const spent = (session.usage ??= {})
  // Saved with the session, so a resume after an app restart still knows where each Claude session's running cost stood.
  const costs = (session.cliCosts ??= {})
  const runner: typeof runMember = async (cli, a, ...rest) => {
    const r = await run(cli, { ...a, costBefore: a.resume ? costs[a.resume] : undefined }, ...rest)
    if (r.sessionId && r.costTotal !== undefined) costs[r.sessionId] = r.costTotal
    if (r.usage) {
      const bucket = rest[1].slice(id.length + 1) // `${id}:${member id | 'whiteboard' | 'chair'}`
      spent[bucket] = addUsage(spent[bucket], r.usage)
      emit({ sessionId: id, type: 'usage', usage: spent })
    }
    return r
  }

  const hostMessages = (session.hostMessages ??= [])
  const requestedTurns = new Set(
    hostMessages
      .filter(
        (message) =>
          message.kind === 'ask' && message.status === 'delivered' && message.turn !== undefined
      )
      .map((message) => message.turn)
  )
  let rotation = Math.max(0, first - 1 - requestedTurns.size)
  let chairStarted = false
  let preparing: Member | undefined // the member whose turn is running
  let yielded: Member | undefined // stopped by a raised hand; it speaks again next
  const cutOff = (x: Member): boolean => yielded === x // set from the IPC handler, outside this flow
  me.raise = (on) => {
    me.paused = on
    if (!on) return me.wake?.()
    if (preparing && !chairStarted) {
      yielded = preparing
      killRun(`${id}:${preparing.id}`)
    }
  }
  let live: { n: number; label: string; text: string } | undefined
  const writer = brief.board ?? { cli: chairMember.cli, model: chairMember.model }
  let writerModel = writer.model ?? (brief.board ? undefined : chairMember.resolvedModel)
  const board = createBoardWriter({
    previous: session.whiteboard,
    generate: async (prompt, resume) => {
      const r = await runner(
        writer.cli,
        { prompt, model: writer.model, resume },
        () => {},
        `${id}:whiteboard`,
        (model) => (writerModel = model)
      )
      return { text: r.text, sessionId: r.sessionId }
    },
    cancel: () => killRun(`${id}:whiteboard`),
    publish: (whiteboard) => {
      if (me.cancelled || current !== me) return
      // parseBoard stamps the default model; record who actually wrote it
      whiteboard.model = modelName(writerModel) ?? CLI_META[writer.cli].name
      session.whiteboard = whiteboard
      session.shape = {
        converging: whiteboard.agreed.map((note) => ({ point: note.text, supporters: [] })),
        open: whiteboard.disputed.map((note) => ({ point: note.text, sides: '' }))
      }
      emit({ sessionId: id, type: 'shape', turn: whiteboard.throughTurn, shape: session.shape })
      save(session)
      emit({ sessionId: id, type: 'whiteboard', board: whiteboard })
    },
    status: (status, error) => emit({ sessionId: id, type: 'board-status', status, error })
  })
  const updateBoard = (immediate = false): void => {
    if (transcript.length || live?.text)
      board.update(
        {
          task: brief.task,
          turns: transcript.map((t) => ({ n: t.n, label: t.label, text: t.text })),
          live
        },
        immediate
      )
  }
  me.refreshBoard = () => updateBoard(true)
  me.host = (input) => {
    if (chairStarted || me.concluding) throw new Error('The meeting is already concluding.')
    if (
      !input ||
      !['thought', 'ask', 'focus'].includes(input.kind) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 4000 ||
      typeof input.id !== 'string' ||
      !input.id ||
      input.id.length > 100
    )
      throw new Error('Write a message of up to 4,000 characters.')
    if (input.kind === 'ask' && !members.some((m) => m.id === input.targetId))
      throw new Error('Choose an agent in this meeting.')
    if (hostMessages.some((m) => m.id === input.id)) return
    const message: HostMessage = {
      id: input.id,
      kind: input.kind,
      text: input.text.trim(),
      targetId: input.kind === 'ask' ? input.targetId : undefined,
      status: 'queued'
    }
    hostMessages.push(message)
    save(session)
    emit({ sessionId: id, type: 'host-message', message })
  }
  me.finish = () => {
    if (me.concluding || chairStarted) return
    me.concluding = true
    me.paused = false
    me.wake?.()
    emit({ sessionId: id, type: 'concluding' })
  }
  const drainHuman = (n: number, memberId: string, all = false): void => {
    for (const message of hostMessages.filter(
      (m) => m.status === 'queued' && (all || m.kind !== 'ask' || m.targetId === memberId)
    )) {
      const prefix =
        message.kind === 'focus'
          ? 'Focus the discussion on: '
          : message.kind === 'ask'
            ? `Question for ${labels[message.targetId!]}: `
            : ''
      const t: Turn = {
        n,
        speaker: HUMAN,
        label: 'The Human',
        text: prefix + message.text,
        vote: null
      }
      transcript.push(t)
      if (message.kind === 'focus') session.focus = message.text
      message.status = 'delivered'
      message.deliveredTo = labels[memberId]
      message.turn = n
      emit({ sessionId: id, type: 'human', turn: t })
      emit({ sessionId: id, type: 'host-message', message: { ...message } })
    }
    save(session)
  }

  // Voices: the next member thinks while the previous one is still talking, and audio never falls more
  // than one turn behind (the loop waits for the turn before last to finish playing).
  let audio: Promise<unknown> = Promise.resolve() // fillers and answers reach the player in turn order
  const played: Promise<void>[] = []
  const voiceOf = (m: Member): string | undefined =>
    brief.voices && m.voice && getKey('openrouter') ? m.voice : undefined
  const voiceError = (e: unknown): void => {
    if (!me.cancelled)
      emit({
        sessionId: id,
        type: 'voice-error',
        message: e instanceof Error ? e.message : String(e)
      })
  }
  const sayFiller = (m: Member, n: number, voice: string): void => {
    audio = audio.then(() => {
      const data = filler(voice)
      if (data)
        emit({
          sessionId: id,
          type: 'voice',
          memberId: m.id,
          turn: n,
          format: 'mp3',
          data,
          last: false
        })
    })
  }
  const sayAnswer = (m: Member, n: number, voice: string, text: string): void => {
    const sent = audio.then(() =>
      readAloud(voice, text, `${id}:voice`, (data, last) =>
        emit({ sessionId: id, type: 'voice', memberId: m.id, turn: n, format: 'pcm', data, last })
      )
    )
    audio = sent.catch(voiceError)
    played.push(
      sent.then(
        (bytes) =>
          new Promise<void>((res) => {
            if (!bytes) return res()
            // the renderer acks; the timer covers a closed window. 48,000 bytes = 1 s of audio
            const t = setTimeout(done, (bytes / 48_000) * 1000 + 15_000)
            function done(): void {
              clearTimeout(t)
              me.heard.delete(n)
              res()
            }
            me.heard.set(n, done)
          }),
        () => undefined
      )
    )
  }

  const hold = async (): Promise<void> => {
    while (me.paused && !me.cancelled) await new Promise<void>((r) => (me.wake = r))
    if (me.cancelled) throw new Error('stopped')
  }

  updateBoard()
  ;(async () => {
    try {
      for (let n = first; n <= brief.maxTurns; n++) {
        await hold()
        await played.at(-2)
        await hold()
        if (me.concluding) break
        const asked = hostMessages.find(
          (message) => message.status === 'queued' && message.kind === 'ask'
        )
        const requested = members.find((member) => member.id === asked?.targetId)
        // a member cut off by the raised hand goes again, unless the human asked someone else
        const m = requested ?? yielded ?? members[rotation++ % N]
        yielded = undefined
        const phase = transcript.some((t) => t.speaker === m.id)
          ? phaseOf(n, N, brief.maxTurns)
          : 'open'
        drainHuman(n, m.id)
        live = { n, label: labels[m.id], text: '' }
        let sampled = 0
        // no CLI session (resumed, or the CLI never gave one) = no memory: show everything
        const since = cliSessions[m.id] ? transcript.slice(seen[m.id] ?? 0) : transcript
        const seenBefore = seen[m.id]
        seen[m.id] = transcript.length
        preparing = m
        emit({ sessionId: id, type: 'turn-start', memberId: m.id, turn: n, phase })
        const voice = voiceOf(m)
        // only the opening turn needs covering: later seats think while the previous one talks
        if (voice && n === first) sayFiller(m, n, voice)
        const basePrompt =
          phase === 'open'
            ? P.opening(brief, m, labels, since)
            : (cliSessions[m.id] ? '' : P.intro(brief, m, labels) + '\n') +
              P.turn(brief, m, labels, since, phase, n, session.shape)
        const prompt =
          basePrompt +
          visualContext(session.whiteboard) +
          (session.focus
            ? `\n\nThe host's current focus: ${session.focus}\nPrioritize this question and keep your contribution relevant to it.`
            : '')
        const trace: TraceStep[] = []
        try {
          const r = await runner(
            m.cli,
            {
              prompt,
              model: m.model,
              // attachments only = the attachments folder is the workspace; with a project it's an extra read dir
              cwd: brief.projectPath ?? attachDir,
              dirs: brief.projectPath && attachDir ? [attachDir] : undefined,
              resume: cliSessions[m.id]
            },
            (t) => {
              emit({ sessionId: id, type: 'delta', memberId: m.id, turn: n, text: t })
              if (live) {
                live.text += t
                if (live.text.length - sampled >= 500) {
                  sampled = live.text.length
                  updateBoard()
                }
              }
            },
            `${id}:${m.id}`,
            (model) => {
              m.resolvedModel = model
              save(session)
              emit({ sessionId: id, type: 'member-model', memberId: m.id, model })
            },
            (kind) => emit({ sessionId: id, type: 'activity', memberId: m.id, turn: n, kind }),
            // the human's Trace panel: tool calls and reasoning, never shown to the other members
            (step) => {
              if (trace.length >= 200) return // ponytail: a runaway turn's tail isn't worth the session file
              trace.push(step)
              emit({ sessionId: id, type: 'trace', memberId: m.id, turn: n, step })
            }
          )
          cliSessions[m.id] = r.sessionId ?? cliSessions[m.id]
          const t: Turn = {
            n,
            speaker: m.id,
            label: labels[m.id],
            text: stripVote(r.text),
            vote: extractVote(r.text),
            costUsd: r.costUsd,
            trace: trace.length ? trace : undefined
          }
          transcript.push(t)
          seen[m.id] = transcript.length
          lastError[m.id] = undefined
          emit({ sessionId: id, type: 'turn-done', turn: t })
          if (voice) sayAnswer(m, n, voice, r.text)
        } catch (e) {
          if (me.cancelled) throw e
          if (cutOff(m)) {
            // not an error: the human took the floor. Same turn number, same member, after them.
            preparing = undefined
            seen[m.id] = seenBefore
            live = undefined
            emit({ sessionId: id, type: 'turn-cancelled', memberId: m.id, turn: n })
            n--
            continue
          }
          const message = e instanceof Error ? e.message : String(e)
          lastError[m.id] = message
          emit({ sessionId: id, type: 'turn-error', memberId: m.id, turn: n, message })
        }
        preparing = undefined
        if (cutOff(m)) yielded = undefined // it finished before the hand went up
        live = undefined
        updateBoard(true)
        save(session)
        if (me.cancelled) throw new Error('stopped')
        if (n % N === 0) {
          // a full cycle after the openings with nobody disagreeing = done talking
          const votes = latestVotes(transcript)
          const converged =
            n > N &&
            !hostMessages.some((message) => message.status === 'queued') &&
            new Set(
              transcript
                .filter((t) => t.speaker !== HUMAN)
                .slice(-N)
                .map((t) => t.speaker)
            ).size === N &&
            members.every(
              (x) => !lastError[x.id] && votes[x.id] && votes[x.id]!.disagreements.length === 0
            )
          if (converged) {
            session.converged = true
            break
          }
        }
      }
      await hold()
      chairStarted = true
      drainHuman(Math.max(0, ...transcript.map((t) => t.n)), chairMember.id, true)
      updateBoard(true)
      emit({ sessionId: id, type: 'chair-start', memberId: chairMember.id })
      const votes = latestVotes(transcript)
      const r = await runner(
        chairMember.cli,
        {
          prompt:
            P.chair(
              brief,
              labels,
              transcript,
              votes,
              lastError,
              me.concluding
                ? 'The host asked to conclude now. Base the decision on the discussion so far, preserve uncertainty, and explicitly note any members who have not given a position.'
                : ''
            ) + visualContext(session.whiteboard),
          model: chairMember.model
        },
        (t) => emit({ sessionId: id, type: 'delta', memberId: chairMember.id, turn: 0, text: t }),
        `${id}:chair`,
        (model) => {
          chairMember.resolvedModel = model
          save(session)
          emit({ sessionId: id, type: 'member-model', memberId: chairMember.id, model })
        },
        (kind) => emit({ sessionId: id, type: 'activity', memberId: chairMember.id, turn: 0, kind })
      )
      if (me.cancelled) throw new Error('stopped')
      const body = r.text.trim()
      const cited = sources(body, transcript)
      const markdown = `${body}\n\n${cited ? `${cited}\n\n` : ''}${appendix(session, votes)}`
      const dir = brief.projectPath
        ? join(brief.projectPath, 'consortium')
        : join(userData, 'consortium')
      mkdirSync(dir, { recursive: true })
      const path = join(
        dir,
        `${slug(brief.task)}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.md`
      )
      writeFileSync(path, markdown)
      writeFileSync(path.replace(/\.md$/, '.transcript.md'), fullTranscript(session))
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
      board.dispose()
      emit({ sessionId: id, type: 'board-status', status: 'idle' })
      if (current === me) current = null
    }
  })()
  return id
}
