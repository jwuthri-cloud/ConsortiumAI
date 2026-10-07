// End-to-end engine check with real CLIs, no Electron:
//   npx tsx scripts/smoke.ts [claude,codex] [maxTurns]   (SMOKE_PROJECT=/path to attach a project, SMOKE_TASK=... for the question)
import { configure, runDebate } from '../src/main/debate'
import type { Cli, DebateEvent, Member, PersonaId } from '../src/shared/types'

const clis = (process.argv[2] ?? 'claude,codex').split(',') as Cli[]
const maxTurns = Number(process.argv[3] ?? 10)
const personas: PersonaId[] = ['strategist', 'skeptic', 'engineer', 'researcher']
const members: Member[] = clis.map((cli, i) => ({
  id: `m${i}`,
  cli,
  persona: personas[i % personas.length],
  model: cli === 'claude' ? 'sonnet' : undefined
}))

configure(process.env.SMOKE_DIR ?? '/tmp/consortium-smoke')
const t0 = Date.now()
const log = (s: string): void =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`)
let deltas = 0

runDebate(
  {
    task:
      process.env.SMOKE_TASK ??
      'We run a small B2B SaaS. Should we build a customer data-export feature (CSV download plus a JSON API) this quarter, or defer it?',
    projectPath: process.env.SMOKE_PROJECT,
    members,
    chairId: 'm0',
    maxTurns
  },
  (e: DebateEvent) => {
    if (e.type === 'delta') {
      deltas++
      return
    }
    if (e.type === 'turn-start') log(`turn ${e.turn} ${e.phase.padEnd(8)} ${e.memberId} starts`)
    else if (e.type === 'turn-done')
      log(
        `turn ${e.turn.n} done ${e.turn.label}: ${e.turn.text.replace(/\s+/g, ' ').slice(0, 160)}… | vote=${JSON.stringify(e.turn.vote)} | ${e.turn.text.split(/\s+/).length} words, cost=${e.turn.costUsd ?? '-'} (${deltas} deltas)`
      )
    else if (e.type === 'turn-error') log(`ERROR turn ${e.turn} ${e.memberId}: ${e.message}`)
    else if (e.type === 'shape') log(`notes @${e.turn} ${JSON.stringify(e.shape)}`)
    else if (e.type === 'consortium') {
      log(`consortium → ${e.path}\n${e.markdown.slice(0, 1500)}\n…`)
      setTimeout(() => process.exit(0), 20_000) // let a last clerk pass land
    } else if (e.type === 'failed' || e.type === 'stopped') {
      log(`${e.type} ${'message' in e ? e.message : ''}`)
      process.exit(1)
    } else log(`${e.type} ${JSON.stringify({ ...e, sessionId: undefined })}`)
  }
)
