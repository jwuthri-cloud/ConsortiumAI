import type { Brief, Member, Phase, Shape, Turn, Vote } from '../shared/types'
import { PERSONAS } from '../shared/personas'

type Labels = Record<string, string>

const VOTE =
  '{"position":"<your current recommendation in one sentence>","confidence":<0 to 1>,"agrees_with":["<labels you now agree with on the recommendation>"],"disagreements":[{"with":"<label>","on":"<the point still contested, a few words>"}]}'

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + ' …' : text
}

function said(turns: Turn[], max = 1500): string {
  return turns.map((t) => `**${t.label}:** ${clip(t.text, max)}`).join('\n\n')
}

function notes(shape: Shape | null): string {
  if (!shape || (!shape.converging.length && !shape.open.length)) return ''
  const c = shape.converging
    .map((x) => `- ${x.point} (${x.supporters.join(', ') || 'unclear'})`)
    .join('\n')
  const o = shape.open.map((x) => `- ${x.point}${x.sides ? ` — ${x.sides}` : ''}`).join('\n')
  return `## Clerk's notes — where the table stands\nConverging:\n${c || '- nothing yet'}\nStill open:\n${o || '- nothing'}\n\n`
}

function projectRule(brief: Brief): string {
  return brief.projectPath
    ? `A project is attached at ${brief.projectPath}. Inspect its code read-only when a claim depends on it. Never create, modify or delete anything.`
    : 'No project is attached. Do not use tools; reason from the question and what you know.'
}

export function opening(brief: Brief, m: Member, labels: Labels, earlier: Turn[]): string {
  const all = brief.members.map((x) => labels[x.id]).join(', ')
  return `You are ${labels[m.id]}, one of ${brief.members.length} members at a consortium table advising a human decision-maker. The members are: ${all}.
Your lens: ${PERSONAS[m.persona].lens}
Never reveal or guess which AI model or company is behind any member, including yourself.
This is a live conversation, not a report. Members speak in short turns, in order, and react to what was just said. A clerk keeps notes between turns; a chair writes the final decision. The human may speak at any time.
${projectRule(brief)}

## The question
${brief.task}
${earlier.length ? `\n## Said so far\n${said(earlier)}\n` : ''}
## Your opening — at most 150 words
Your recommendation and the one or two strongest reasons for it${earlier.length ? '. React to what was said if it matters' : ''}. Speak plainly, first person, no headings, no bullet walls.

End with a fenced \`\`\`json block and nothing after it:
${VOTE}
Leave "agrees_with" and "disagreements" empty unless you already disagree with something said.`
}

const PHASE_LINE: Record<Phase, string> = {
  open: '',
  debate:
    'React to specific points — name the member and the point. Challenge it, concede it, ask one sharp question, or propose a concrete way to settle an open disagreement. Do not restate your whole position; add something new, or say PASS if you have nothing to add.',
  converge:
    'The table is running out of time. Speak only to the open points: concede where you have been persuaded, say exactly what would settle each remaining disagreement, and do not open new topics.',
  decide:
    'This is your FINAL statement. In one or two sentences: your final recommendation, what you concede, and what you still disagree with. Nothing else.'
}

export function turn(
  brief: Brief,
  m: Member,
  labels: Labels,
  since: Turn[],
  phase: Phase,
  n: number,
  shape: Shape | null
): string {
  const words = phase === 'decide' ? 80 : 150
  return `Turn ${n} of ${brief.maxTurns}. You are ${labels[m.id]}.
${notes(shape)}## Since you last spoke
${said(since) || '(nobody spoke)'}

## Your turn — at most ${words} words
${PHASE_LINE[phase]}

End with a fenced \`\`\`json block and nothing after it:
${VOTE}
Leave "disagreements" empty only if you genuinely have no remaining disagreement with anyone.`
}

export function clerk(
  brief: Brief,
  labels: Labels,
  recent: Turn[],
  votes: Record<string, Vote | null>
): string {
  const all = brief.members.map((x) => labels[x.id]).join(', ')
  const positions = brief.members
    .map((x) => `- ${labels[x.id]}: ${votes[x.id]?.position ?? '(no position yet)'}`)
    .join('\n')
  return `You are the clerk of a consortium. Below are the members' current positions and the latest turns of their conversation on a question. Do not use tools. Reply with ONLY a JSON object — no prose, no code fence — of this exact shape:
{"converging":[{"point":"<a short point most members now support>","supporters":["<labels>"]}],"open":[{"point":"<a contested point, short>","sides":"<label> vs <label>"}]}
At most 4 converging points and 4 open points. Use only these labels: ${all}.

## Question
${brief.task}

## Current positions
${positions}

## Latest turns
${said(recent, 900)}`
}

export function chair(
  brief: Brief,
  labels: Labels,
  transcript: Turn[],
  votes: Record<string, Vote | null>,
  errors: Record<string, string | undefined>,
  human: string
): string {
  const finals = brief.members
    .map((x) => {
      const v = votes[x.id]
      const dis = v?.disagreements.map((d) => `${d.with} (${d.on})`).join(', ') || 'nobody'
      const stale = errors[x.id]
        ? ` — DID NOT RESPOND in its last turn (${errors[x.id]!.slice(0, 120)}); treat its position as stale`
        : ''
      return `- ${labels[x.id]} — confidence ${v ? v.confidence.toFixed(2) : 'n/a'}; still disagrees with: ${dis}${stale}\n  ${v?.position ?? '(no position)'}`
    })
    .join('\n')
  // keep the whole conversation when it fits, otherwise the openings plus the most recent turns
  let turns = transcript
  const total = transcript.reduce((a, t) => a + t.text.length, 0)
  if (total > 60000) {
    const n = brief.members.length
    const keepTail = Math.max(n * 4, transcript.length - Math.ceil((total - 60000) / 800))
    turns = [...transcript.slice(0, n), ...transcript.slice(-keepTail)]
  }
  const memberTurns = transcript.filter((t) => t.speaker !== 'human').length
  return `You are the chair of a consortium of ${brief.members.length} AI members who discussed the question below over ${memberTurns} turns at the table. Never reveal which AI models were involved; refer to members only by their labels. Do not use tools. Write the final consortium document in markdown with exactly these sections and nothing else:
# Consortium: <short title>
## Decision
## Rationale
## Plan
## Dissent
(Every remaining disagreement, attributed by label and stated faithfully — not smoothed over. "None" if the members fully converged.)
## Open questions for the human

## The question
${brief.task}
${brief.projectPath ? `Project: ${brief.projectPath}\n` : ''}${human ? `\n## Message from the human (arrived after the last turn; weigh it in the decision)\n${human}\n` : ''}
## Final positions
${finals}

## Transcript
${said(turns, 1200)}`
}
