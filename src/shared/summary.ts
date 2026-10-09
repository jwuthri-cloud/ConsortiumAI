import { HUMAN, type Session, type SessionSummary } from './types'
import { stripCites } from './cite'
import { sumUsage } from './usage'

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : max) + '…'
}

function plain(md: string): string {
  return stripCites(md)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ponytail: "ends at . ! ? before a capital or the end" trips on "e.g. Foo"; good enough for a card.
function firstSentence(text: string): string {
  return text.match(/^.*?[.!?](?=\s+[A-Z("“]|\s*$)/)?.[0] ?? text
}

function section(md: string, heading: string): string | undefined {
  return md.match(
    new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##?\\s|$(?![\\s\\S]))`, 'im')
  )?.[1]
}

// What the meeting library shows for one saved session.
export function summarize(s: Session): SessionSummary {
  const md = s.consortium?.markdown ?? ''
  const titled = md.match(/^#\s+(?:Consortium:\s*)?(.+)$/m)?.[1]
  // "Recommendation" since the sourced decision doc; older sessions say "Decision"
  const decision = plain(section(md, 'Recommendation') ?? section(md, 'Decision') ?? '')
  const leaning = s.shape?.converging[0]?.point
  return {
    id: s.id,
    createdAt: s.createdAt,
    task: s.brief.task,
    title: clip(plain(titled ?? firstSentence(s.brief.task.split('\n')[0])), 90),
    outcome: decision
      ? clip(firstSentence(decision), 180)
      : leaning
        ? clip(`Leaning toward: ${plain(leaning)}`, 180)
        : undefined,
    projectPath: s.brief.projectPath,
    files: s.brief.attachments?.length
      ? s.brief.attachments.map((f) => f.split('/').pop() ?? f)
      : undefined,
    team: s.brief.members.map(({ cli, persona }) => ({ cli, persona })),
    turn: Math.max(0, ...s.turns.filter((t) => t.speaker !== HUMAN).map((t) => t.n)),
    maxTurns: s.brief.maxTurns,
    usage: sumUsage(Object.values(s.usage ?? {})),
    status: s.status
  }
}
