import type { Vote } from './types'

const FENCE = /```json\s*([\s\S]*?)```/g

// The last fenced json block in a member's answer is its vote. Anything malformed → null, never throws.
export function extractVote(text: string): Vote | null {
  const raw = [...text.matchAll(FENCE)].at(-1)?.[1]
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.position !== 'string') return null
    const confidence = Number(v.confidence)
    return {
      position: v.position,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      agrees_with: Array.isArray(v.agrees_with)
        ? v.agrees_with.filter((s: unknown) => typeof s === 'string')
        : [],
      disagreements: Array.isArray(v.disagreements)
        ? v.disagreements
            .filter((d: unknown) => d && typeof (d as { with?: unknown }).with === 'string')
            .map((d: { with: string; on?: unknown }) => ({
              with: d.with,
              on: typeof d.on === 'string' ? d.on : ''
            }))
        : []
    }
  } catch {
    return null
  }
}

// What other members (and the UI) read: the answer without its vote block.
export function stripVote(text: string): string {
  const blocks = [...text.matchAll(FENCE)]
  const last = blocks.at(-1)
  if (!last || last.index === undefined) return text.trim()
  return (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim()
}

// First {...} object in free text (the clerk's JSON-only replies sometimes arrive fenced or with a preamble).
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
