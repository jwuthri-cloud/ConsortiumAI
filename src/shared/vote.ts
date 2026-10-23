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

// Members name each other loosely ("Strategist", "the strategist"): compare on the bare words.
const bare = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]/g, '')

export const sameLabel = (a: string, b: string): boolean => bare(a) === bare(b)

// Where a member's vote stands on another member, by label; undefined = no vote, or not mentioned.
export function stance(
  v: Vote | null | undefined,
  label: string
): 'agree' | 'disagree' | undefined {
  if (!v) return undefined
  if (v.disagreements.some((d) => sameLabel(d.with, label))) return 'disagree'
  if (v.agrees_with.some((x) => sameLabel(x, label))) return 'agree'
  return undefined
}

// The safety net behind the prompts' "no paths or URLs": a citation in parentheses goes, a link
// keeps its words, a URL goes, and any path left is cut to its file name.
// ponytail: patterns only (a slash plus an extension, or name.ext:line); a path spelled without
// either survives.
const PATH = String.raw`(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]\w{0,5}(?::\d+(?:-\d+)?)?|[\w.-]+\.[A-Za-z]\w{0,5}:\d+(?:-\d+)?`
const URL_ = String.raw`https?:\/\/[^\s()<>\]]*[^\s()<>\].,;:!?'"]`
const CITED = new RegExp(
  String.raw`[ \t]*\((?:(?:see|in|at|from|cf\.)\s+)?(?:\x60?(?:${PATH}|${URL_})\x60?(?:\s*(?:,|;|and)\s*)?)+\)`,
  'gi'
)
export function withoutLocations(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/|\.)[^)\s]*\)/g, '$1')
    .replace(CITED, '')
    .replace(new RegExp(`<?${URL_}>?`, 'g'), '')
    .replace(new RegExp(PATH, 'g'), (p) =>
      p
        .replace(/:\d+(?:-\d+)?$/, '')
        .split('/')
        .pop()!
    )
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
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
