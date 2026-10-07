import {
  HUMAN,
  type Api,
  type Brief,
  type DebateEvent,
  type Phase,
  type Turn,
  type Vote
} from '@shared/types'
import { makeLabels } from '@shared/personas'

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

export const mockApi: Api = {
  async start(brief: Brief, sessionId: string) {
    const labels = makeLabels(brief.members)
    const N = brief.members.length
    const L = (i: number): string => labels[brief.members[i % N].id]
    let n = 0
    const speak = async (phase: Phase, text: string, vote: Vote): Promise<void> => {
      n++
      const m = brief.members[(n - 1) % N]
      emit({ sessionId, type: 'turn-start', memberId: m.id, turn: n, phase })
      await sleep(300 + Math.random() * 900)
      const words = text.split(' ')
      for (let i = 0; i < words.length; i++) {
        emit({ sessionId, type: 'delta', memberId: m.id, turn: n, text: (i ? ' ' : '') + words[i] })
        await sleep(30)
      }
      const t: Turn = { n, speaker: m.id, label: labels[m.id], text, vote, costUsd: 0.03 }
      emit({ sessionId, type: 'turn-done', turn: t })
    }
    for (let i = 0; i < N; i++)
      await speak('open', OPENINGS[i % OPENINGS.length], {
        position: OPENINGS[i % OPENINGS.length].split('.')[0] + '.',
        confidence: 0.6 + 0.05 * i,
        agrees_with: [],
        disagreements: i % 2 ? [{ with: L(i + 1), on: 'JSON API vs CSV only' }] : []
      })
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
    for (let k = 0; n < budget && k < REPLIES.length; k++) {
      const phase: Phase =
        n + 1 > budget - N ? 'decide' : n + 1 > budget * 0.6 ? 'converge' : 'debate'
      const last = k >= REPLIES.length - N
      await speak(phase, REPLIES[k], {
        position: 'Ship a capped CSV export after the billing rework; no JSON API this quarter.',
        confidence: 0.7 + 0.03 * k,
        agrees_with: [L(k + 1)],
        disagreements: last ? [] : [{ with: L(k + 1), on: 'timing' }]
      })
      if (k === 3) {
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
    emit({
      sessionId,
      type: 'shape',
      turn: n,
      shape: {
        converging: [
          { point: 'Capped, async CSV export behind a flag', supporters: [L(0), L(1), L(2), L(3)] },
          {
            point: 'No JSON API until a named customer needs it',
            supporters: [L(0), L(1), L(2), L(3)]
          },
          { point: 'Ship right after the billing rework', supporters: [L(0), L(1), L(2), L(3)] }
        ],
        open: []
      }
    })
    const chair = brief.chairId
    emit({ sessionId, type: 'chair-start', memberId: chair })
    const doc = `# Consortium: Customer data export\n\n## Decision\nBuild a capped, asynchronous CSV export behind a feature flag, starting right after the billing rework; no JSON API this quarter.\n\n## Rationale\nExport is a procurement checklist item and a churn driver; the small version costs days. The public API is a long-lived contract nobody has asked for yet.\n\n## Plan\n1. Flagged CSV export, async job, rate limited.\n2. Pilot with the two renewal accounts that asked.\n3. Revisit the JSON API when a named customer needs it.\n\n## Dissent\n${L(1)} accepts the CSV only on condition that the billing rework keeps priority.\n\n## Open questions for the human\n- Which cap per export?\n`
    const words = doc.split(' ')
    for (let i = 0; i < words.length; i++) {
      emit({ sessionId, type: 'delta', memberId: chair, turn: 0, text: (i ? ' ' : '') + words[i] })
      await sleep(18)
    }
    emit({
      sessionId,
      type: 'consortium',
      markdown: doc,
      path: '/Users/you/project/consortium/customer-data-export.md'
    })
  },
  async stop() {
    /* preview only */
  },
  async interject() {
    /* preview only */
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
      grok: '/usr/local/bin/grok'
    }
  },
  async check() {
    await sleep(900)
    return { ok: true, message: 'OK' }
  },
  async models(cli) {
    return cli === 'claude' ? ['opus', 'sonnet', 'fable'] : [`${cli}-default`, `${cli}-pro`]
  },
  async listSessions() {
    return []
  },
  async loadSession() {
    return null
  },
  onEvent(cb) {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
}
