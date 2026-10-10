import { demoVisuals } from './demoVisuals'
import type { HostMessage, Whiteboard } from '@shared/whiteboard'
import {
  HUMAN,
  type Api,
  type Brief,
  type Cli,
  type DebateEvent,
  type Member,
  type Phase,
  type Session,
  type TraceStep,
  type Turn,
  type Vote
} from '@shared/types'
import { makeLabels } from '@shared/personas'
import { modelName } from '@shared/models'
import { summarize } from '@shared/summary'
import { addUsage, priced, type Usage } from '@shared/usage'

// Illustrative model IDs for the browser demo only. Electron uses CLI metadata.
const DEMO_MODELS = {
  claude: 'claude-opus-4-6',
  codex: 'gpt-6-astra',
  gemini: 'gemini-3.1-pro-preview',
  grok: 'grok-4.7',
  harness: 'openrouter:z-ai/glm-5.2'
}

// Scripted conversation for previewing the renderer in a plain browser (no Electron, no CLIs).
const listeners = new Set<(e: DebateEvent) => void>()
const emit = (e: DebateEvent): void => listeners.forEach((l) => l(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const OPENINGS = [
  'Ship the export now, scoped to CSV behind a feature flag. Export is on every procurement checklist we have lost on, and the small version is days of work, not weeks.',
  'Defer it. Nothing in the tracker shows a customer asking for export this quarter, and the billing rework already has our only backend engineer who knows the data model.',
  'Three comparable products shipped export in their second year, and churn interviews in two of them cite "my data is locked in" as a top-five reason. The evidence favours a small version early.',
  'Who asked? Show me two tickets before we build anything. If export matters it will show up in support within a month of saying no.'
]
const REPLIES = [
  'The Engineer is right that the API is unproven — I concede that. But a CSV download touches no public contract. Can we agree the API is a separate decision?',
  'Fine on the CSV if it is capped and async; my objection was always the API surface. I still want the billing rework to keep priority.',
  'One data point for the Skeptic: our two largest renewals asked about export in their security review last year. That is the ticket you wanted.',
  'That changes my mind on the CSV. I hold that the JSON API stays off the table until a named customer needs it.',
  'PASS — nothing to add, the open point is only timing.',
  'Timing: after the billing rework, which lands in three weeks. Is that acceptable to everyone?',
  'Yes.',
  'Yes, with the cap.'
]

// A few saved meetings so the preview's library has something to search, filter and continue.
const TEAM: Member[] = [
  { id: 'd1', cli: 'claude', persona: 'strategist' },
  { id: 'd2', cli: 'codex', persona: 'engineer' },
  { id: 'd3', cli: 'gemini', persona: 'researcher' },
  { id: 'd4', cli: 'grok', persona: 'skeptic' }
]
const demo = (
  id: string,
  daysAgo: number,
  task: string,
  status: Session['status'],
  turns: number,
  extra: {
    projectPath?: string
    decision?: string
    leaning?: string
    team?: Member[]
    usage?: Record<string, Usage>
    attachments?: string[]
    votes?: Record<string, Pick<Vote, 'agrees_with' | 'disagreements'>> // each member's final vote
  } = {}
): Session => {
  const members = extra.team ?? TEAM
  const labels = makeLabels(members)
  return {
    version: 2,
    id,
    createdAt: new Date(Date.now() - daysAgo * 864e5).toISOString(),
    brief: {
      task,
      projectPath: extra.projectPath,
      attachments: extra.attachments,
      members,
      chairId: members[0].id,
      maxTurns: 30
    },
    labels,
    turns: Array.from({ length: turns }, (_, i) => {
      const m = members[i % members.length]
      const text = [...OPENINGS, ...REPLIES][i % (OPENINGS.length + REPLIES.length)]
      const v = i >= turns - members.length ? extra.votes?.[m.id] : undefined
      const vote = v ? { position: text, confidence: 0.8, ...v } : null
      return { n: i + 1, speaker: m.id, label: labels[m.id], text, vote }
    }),
    shape: extra.leaning
      ? { converging: [{ point: extra.leaning, supporters: [] }], open: [] }
      : null,
    converged: false,
    status,
    usage: extra.usage,
    consortium: extra.decision
      ? { markdown: extra.decision, path: '/Users/you/consortium/demo.md' }
      : undefined
  }
}
const DEMO: Session[] = [
  demo(
    'demo-1',
    0,
    'Should we move the billing service from cron jobs to a queue?',
    'stopped',
    12,
    {
      projectPath: '/Users/you/Repos/acme',
      leaning: 'Move retries to a queue first; keep the nightly cron for reconciliation',
      usage: {
        d1: { input: 96_000, cached: 71_000, output: 4_100, costUsd: 0.41 },
        d2: { input: 88_000, cached: 66_000, output: 3_200, costUsd: 0.45, estimated: true }
      }
    }
  ),
  demo('demo-2', 2, 'Should we ship a customer data export this quarter?', 'done', 22, {
    projectPath: '/Users/you/Repos/acme',
    // members name each other loosely ("Strategist", "the strategist"); the matrix still reads them
    votes: {
      d1: {
        agrees_with: ['The Engineer', 'The Researcher'],
        disagreements: [{ with: 'The Skeptic', on: 'waiting for tickets first' }]
      },
      d2: { agrees_with: ['Strategist', 'Researcher'], disagreements: [] },
      d3: { agrees_with: ['the strategist', 'The Engineer'], disagreements: [] },
      d4: {
        agrees_with: ['The Engineer'],
        disagreements: [{ with: 'The Strategist', on: 'timing before the billing rework' }]
      }
    },
    usage: {
      d1: { input: 210_000, cached: 160_000, output: 9_800, costUsd: 1.12 },
      chair: { input: 41_000, cached: 0, output: 2_300, costUsd: 0.38 }
    },
    decision:
      '# Consortium: Customer data export\n\n## Recommendation\nBuild a capped, asynchronous CSV export behind a feature flag, right after the billing rework. No JSON API this quarter: export is a procurement checklist item, and the small version costs days [T1, T3].\n\n## Trade-offs\n- **Gains:** unblocks the two renewals that asked [T2]; the job reuses the queue in `src/jobs/queue.ts:42` [T4].\n- **Gives up:** a JSON API integrators could build on [T2].\n- **Rejected:** shipping before the billing rework, which touches the same invoice tables [T5].\n\n## Next actions\n1. Flagged CSV export, async job, rate limited [T4].\n2. Pilot with the two renewal accounts that asked [T2].\n3. Revisit the JSON API when a named customer needs it [T6].\n\n## Unresolved questions\n- The Engineer accepts the CSV only if the billing rework keeps priority [T5].\n- Which cap per export?\n\n## Sources\n- [T1] The Strategist — “Ship the CSV export.”\n- [T2] The Engineer — “Two renewals asked for it.”'
  }),
  demo(
    'demo-3',
    5,
    'Pricing page: lead with the free tier, or with the team plan? We have three weeks of funnel data attached.',
    'done',
    18,
    {
      team: TEAM.slice(0, 3),
      attachments: ['/Users/you/Desktop/funnel-sep.csv', '/Users/you/Desktop/pricing-page.png'],
      decision:
        '# Consortium: Pricing page lead offer\n\n## Decision\nLead with the team plan and keep the free tier one click away. The funnel shows free sign-ups rarely convert.\n\n## Rationale\n…'
    }
  ),
  demo('demo-4', 9, 'Is it time to split the web app into its own repository?', 'failed', 6, {
    projectPath: '/Users/you/Repos/consortium'
  })
]

let activeRun:
  | {
      id: string
      stopped: boolean
      paused: boolean
      wake?: () => void
      pending: HostMessage[]
      concluding: boolean
      board?: Whiteboard
      members: Brief['members']
      writing?: boolean
    }
  | undefined
const hold = async (run: NonNullable<typeof activeRun>): Promise<void> => {
  while (run.paused && !run.stopped) await new Promise<void>((r) => (run.wake = r))
}

export const mockApi: Api = {
  async start(brief: Brief, sessionId: string) {
    if (activeRun) activeRun.stopped = true
    const run: NonNullable<typeof activeRun> = {
      id: sessionId,
      stopped: false,
      paused: false,
      pending: [],
      concluding: false,
      members: brief.members
    }
    activeRun = run
    const labels = makeLabels(brief.members)
    const N = brief.members.length
    const L = (i: number): string => labels[brief.members[i % N].id]
    let n = 0
    let rotation = 0
    // fake usage so the preview's token meter moves; codex/gemini/grok priced like the real app does
    const spent: Record<string, Usage> = {}
    const spend = (key: string, cli: Cli, chars: number): void => {
      const u = { input: 6000 + n * 900, cached: 4000 + n * 700, output: Math.round(chars / 4) }
      spent[key] = addUsage(
        spent[key],
        priced(
          cli === 'claude' ? { ...u, costUsd: u.input * 3e-6 + u.output * 15e-6 } : u,
          DEMO_MODELS[cli]
        )
      )
      emit({ sessionId, type: 'usage', usage: { ...spent } })
    }
    const speak = async (phase: Phase, text: string, vote: Vote): Promise<void> => {
      await hold(run)
      if (run.stopped || run.concluding) return
      const asked = run.pending.find((message) => message.kind === 'ask')
      const m =
        brief.members.find((member) => member.id === asked?.targetId) ??
        brief.members[rotation++ % N]
      for (const message of run.pending.filter(
        (message) => message.kind !== 'ask' || message.targetId === m.id
      )) {
        const text = message.text
        message.status = 'delivered'
        message.turn = n + 1
        message.deliveredTo = labels[m.id]
        emit({ sessionId, type: 'host-message', message: { ...message } })
        run.pending = run.pending.filter((p) => p.id !== message.id)
        emit({
          sessionId,
          type: 'human',
          turn: { n: n + 1, speaker: HUMAN, label: 'You', text, vote: null }
        })
      }
      n++
      emit({
        sessionId,
        type: 'member-model',
        memberId: m.id,
        model: modelName(m.model) ?? DEMO_MODELS[m.cli]
      })
      emit({ sessionId, type: 'turn-start', memberId: m.id, turn: n, phase })
      emit({ sessionId, type: 'activity', memberId: m.id, turn: n, kind: 'thinking' })
      // what the Trace tab shows: a few illustrative steps per turn
      const trace: TraceStep[] = []
      const step = (s: TraceStep): void => {
        trace.push(s)
        emit({ sessionId, type: 'trace', memberId: m.id, turn: n, step: s })
      }
      step(
        m.cli === 'claude'
          ? { kind: 'thinking', tokens: 180 + n * 40 }
          : {
              kind: 'thinking',
              text: 'Weighing the small CSV export against the billing rework: both touch the invoice tables, so order matters more than scope.'
            }
      )
      await sleep(900)
      if (run.stopped) return
      if (brief.projectPath) {
        emit({ sessionId, type: 'activity', memberId: m.id, turn: n, kind: 'searching' })
        step({
          kind: 'tool',
          name: m.cli === 'codex' ? 'shell' : 'grep',
          detail: m.cli === 'codex' ? "rg -n 'export' src/jobs" : '"export" in src/jobs'
        })
        await sleep(1100)
        if (run.stopped) return
        emit({ sessionId, type: 'activity', memberId: m.id, turn: n, kind: 'reading' })
        step({ kind: 'tool', name: 'read_file', detail: 'src/jobs/queue.ts:30-60' })
        await sleep(1100)
        if (run.stopped) return
        emit({ sessionId, type: 'activity', memberId: m.id, turn: n, kind: 'reviewing' })
        await sleep(900)
      }
      if (run.stopped) return
      const words = text.split(' ')
      for (let i = 0; i < words.length; i++) {
        if (run.stopped) return
        emit({ sessionId, type: 'delta', memberId: m.id, turn: n, text: (i ? ' ' : '') + words[i] })
        await sleep(30)
      }
      if (run.stopped) return
      const t: Turn = { n, speaker: m.id, label: labels[m.id], text, vote, costUsd: 0.03, trace }
      emit({ sessionId, type: 'turn-done', turn: t })
      spend(m.id, m.cli, text.length)
      emit({ sessionId, type: 'board-status', status: 'updating' })
      run.board = {
        visuals: demoVisuals(n),
        model: (() => {
          const w = brief.board ?? brief.members.find((x) => x.id === brief.chairId)!
          return modelName(w.model) ?? DEMO_MODELS[w.cli]
        })(),
        revision: n,
        updatedAt: new Date().toISOString(),
        throughTurn: n,
        recommendation:
          n > 4
            ? 'A small CSV export first. Keep the API as a separate decision.'
            : 'Exploring whether a focused data export is worth prioritizing.',
        agreed:
          n > 4
            ? [{ id: 'csv', text: 'Scope the first release to a capped CSV export.', sources: [5] }]
            : [],
        disputed:
          n >= 2
            ? [
                {
                  id: 'timing',
                  text: 'Export demand versus protecting time for the billing rework.',
                  sources: [1, 2]
                }
              ]
            : [],
        questions: [
          {
            id: 'demand',
            text: 'Which customers need export, and what evidence supports the priority?',
            sources: [1]
          }
        ],
        actions: [
          {
            id: 'proposal',
            text: 'Proposal: test a small export behind a feature flag.',
            sources: [1]
          }
        ]
      }
      emit({ sessionId, type: 'whiteboard', board: run.board })
      emit({ sessionId, type: 'board-status', status: 'idle' })
    }
    for (let i = 0; i < N && !run.concluding; i++)
      await speak('open', OPENINGS[i % OPENINGS.length], {
        position: OPENINGS[i % OPENINGS.length].split('.')[0] + '.',
        confidence: 0.6 + 0.05 * i,
        agrees_with: [],
        disagreements: i % 2 ? [{ with: L(i + 1), on: 'JSON API vs CSV only' }] : []
      })
    if (run.stopped) return
    if (!run.concluding)
      emit({
        sessionId,
        type: 'shape',
        turn: n,
        shape: {
          converging: [{ point: 'Export ships behind a feature flag', supporters: [L(0), L(2)] }],
          open: [
            { point: 'JSON API vs CSV only', sides: `${L(1)} vs ${L(0)}` },
            { point: 'Priority against the billing rework', sides: `${L(1)} vs ${L(2)}` }
          ]
        }
      })
    const budget = brief.maxTurns
    for (let k = 0; n < budget && k < REPLIES.length && !run.concluding; k++) {
      const phase: Phase =
        n + 1 > budget - N ? 'decide' : n + 1 > budget * 0.6 ? 'converge' : 'debate'
      const last = k >= REPLIES.length - N
      await speak(phase, REPLIES[k], {
        position: 'Ship a capped CSV export after the billing rework; no JSON API this quarter.',
        confidence: 0.7 + 0.03 * k,
        agrees_with: [L(k + 1)],
        disagreements: last ? [] : [{ with: L(k + 1), on: 'timing' }]
      })
      if (run.stopped) return
      if (k === 3 && !run.concluding) {
        const t: Turn = {
          n,
          speaker: HUMAN,
          label: 'The Human',
          text: 'Billing rework lands in three weeks. Export cannot slip past the quarter.',
          vote: null
        }
        emit({ sessionId, type: 'human', turn: t })
        emit({
          sessionId,
          type: 'shape',
          turn: n,
          shape: {
            converging: [
              {
                point: 'Capped, async CSV export behind a flag',
                supporters: [L(0), L(1), L(2), L(3)]
              },
              {
                point: 'No JSON API until a named customer needs it',
                supporters: [L(0), L(1), L(3)]
              }
            ],
            open: [{ point: 'Timing against the billing rework', sides: `${L(1)} vs ${L(2)}` }]
          }
        })
      }
    }
    if (run.stopped) return
    if (!run.concluding)
      emit({
        sessionId,
        type: 'shape',
        turn: n,
        shape: {
          converging: [
            {
              point: 'Capped, async CSV export behind a flag',
              supporters: [L(0), L(1), L(2), L(3)]
            },
            {
              point: 'No JSON API until a named customer needs it',
              supporters: [L(0), L(1), L(2), L(3)]
            },
            { point: 'Ship right after the billing rework', supporters: [L(0), L(1), L(2), L(3)] }
          ],
          open: []
        }
      })
    await hold(run)
    if (run.stopped) return
    run.writing = true
    const chair = brief.chairId
    for (const message of run.pending.splice(0)) {
      emit({
        sessionId,
        type: 'host-message',
        message: { ...message, status: 'delivered', deliveredTo: labels[chair] }
      })
      emit({
        sessionId,
        type: 'human',
        turn: { n, speaker: HUMAN, label: 'The Human', text: message.text, vote: null }
      })
    }
    emit({ sessionId, type: 'chair-start', memberId: chair })
    const doc = run.concluding
      ? `# Early meeting recap\n\n## Recommendation\nThe host ended discussion after ${n} turns. Review the positions heard so far before committing to a release.\n\n## Unresolved questions\nThis preview does not generate a new decision; the Electron app asks the chair to synthesize the actual conversation.\n`
      : `# Consortium: Customer data export\n\n## Recommendation\nBuild a capped, asynchronous CSV export behind a feature flag, starting right after the billing rework; no JSON API this quarter. Export is a procurement checklist item and a churn driver, and the small version costs days [T1, T3].\n\n## Trade-offs\n- **Gains:** unblocks the two renewals that asked [T2]; the async job reuses the existing queue in \`src/jobs/queue.ts:42\` [T4].\n- **Gives up:** a JSON API that integrators could build on; ${L(1)} argued it is the durable answer [T2].\n- **Rejected:** shipping before the billing rework, because both touch the same invoice tables [T5].\n\n## Next actions\n1. Flagged CSV export, async job, rate limited [T4].\n2. Pilot with the two renewal accounts that asked [T2].\n3. Revisit the JSON API when a named customer needs it [T6].\n\n## Unresolved questions\n- ${L(1)} accepts the CSV only on condition that the billing rework keeps priority [T5].\n- Which cap per export?\n`
    const words = doc.split(' ')
    for (let i = 0; i < words.length; i++) {
      if (run.stopped) return
      emit({ sessionId, type: 'delta', memberId: chair, turn: 0, text: (i ? ' ' : '') + words[i] })
      await sleep(18)
    }
    if (run.stopped) return
    spend('chair', brief.members.find((m) => m.id === chair)!.cli, doc.length)
    emit({
      sessionId,
      type: 'consortium',
      markdown: doc,
      path: '/Users/you/project/consortium/customer-data-export.md'
    })
    if (activeRun === run) activeRun = undefined
  },
  async stop() {
    if (activeRun) {
      activeRun.stopped = true
      activeRun.wake?.()
      emit({ sessionId: activeRun.id, type: 'stopped' })
      activeRun = undefined
    }
  },
  async resume(id) {
    const s = DEMO.find((x) => x.id === id)
    if (s) void mockApi.start(s.brief, id) // ponytail: replays the script from turn 1
  },
  async pause(on) {
    if (!activeRun) return
    activeRun.paused = on
    if (!on) activeRun.wake?.()
  },
  spoken: () => Promise.resolve(), // the demo has no voices
  async interject(text) {
    await mockApi.host({ id: crypto.randomUUID(), kind: 'thought', text })
  },
  async host(input) {
    if (!activeRun || activeRun.concluding || activeRun.writing)
      throw new Error('This meeting is concluding.')
    const message: HostMessage = { ...input, status: 'queued' }
    activeRun.pending.push(message)
    emit({ sessionId: activeRun.id, type: 'host-message', message })
  },
  async conclude() {
    if (!activeRun) return
    activeRun.concluding = true
    activeRun.paused = false
    activeRun.wake?.()
    emit({ sessionId: activeRun.id, type: 'concluding' })
  },
  async refreshBoard() {
    if (activeRun?.board)
      emit({ sessionId: activeRun.id, type: 'whiteboard', board: activeRun.board })
  },
  async pickFiles() {
    return ['/Users/you/Desktop/pricing-notes.pdf', '/Users/you/Desktop/funnel.png']
  },
  async saveFile(name) {
    return `/tmp/consortium-preview/${name}`
  },
  pathForFile(file) {
    return file.name
  },
  async transcribe() {
    await sleep(1200)
    return 'Should we ship a customer data export this quarter?'
  },
  async pickFolder() {
    return '/Users/you/Repos/acme'
  },
  async reveal() {
    /* preview only */
  },
  async detect() {
    return {
      claude: '/usr/local/bin/claude',
      codex: '/usr/local/bin/codex',
      gemini: '/usr/local/bin/gemini',
      grok: '/usr/local/bin/grok',
      harness: 'built-in'
    }
  },
  async check(cli, model) {
    await sleep(900)
    return { ok: true, message: 'OK', model: model || DEMO_MODELS[cli] }
  },
  async models(cli) {
    return [DEMO_MODELS[cli]]
  },
  async keys() {
    return { openrouter: 'saved', openai: 'env', anthropic: null, google: null, xai: null } as const
  },
  async setKey() {
    await sleep(300)
  },
  async listSessions() {
    return DEMO.map(summarize)
  },
  async loadSession(id) {
    return DEMO.find((x) => x.id === id) ?? null
  },
  async deleteSession(id) {
    const i = DEMO.findIndex((x) => x.id === id)
    if (i >= 0) DEMO.splice(i, 1)
  },
  onEvent(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
}
