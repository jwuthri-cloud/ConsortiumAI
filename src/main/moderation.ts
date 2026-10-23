import { HUMAN, type Member, type Turn } from '../shared/types'
import type { Whiteboard } from '../shared/whiteboard'

// Model guidance may steer the next contribution, but cannot starve a seat or override the host.
export function moderatedSpeaker(
  members: Member[],
  turns: Turn[],
  board: Whiteboard | undefined,
  usedRevision: number
): Member | undefined {
  if (!board?.moderation || board.provisional || board.revision <= usedRevision) return
  const recent = turns.filter((t) => t.speaker !== HUMAN)
  const latest = recent.at(-1)?.n ?? 0
  if (latest - board.throughTurn > members.length) return
  // Every member gets an opening before moderation changes the order.
  if (members.some((m) => !recent.some((t) => t.speaker === m.id))) return
  const overdue = members.find(
    (m) => !recent.slice(-members.length * 2).some((t) => t.speaker === m.id)
  )
  if (overdue) return overdue
  const candidate = members.find((m) => m.id === board.moderation?.nextMemberId)
  return candidate?.id !== recent.at(-1)?.speaker ? candidate : undefined
}

export function moderationContext(board: Whiteboard | undefined, latest: number): string {
  const guidance = board?.moderation
  if (!guidance || board.provisional || latest - board.throughTurn > 4) return ''
  return `\n\nModerator guidance (based on turn ${board.throughTurn}): ${guidance.message}\nAddress this point concretely. The human's latest message and focus take priority. Do not repeat an argument without new evidence.`
}
