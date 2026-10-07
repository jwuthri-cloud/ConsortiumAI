import { HUMAN, type Turn } from './types'

// The chair cites member turns as [T3] or [T3, T7]; the number is the member turn's n.
export const CITE = /\[(T\d+(?:\s*,\s*T\d+)*)\]/g

export const citedTurns = (text: string): number[] =>
  [
    ...new Set(
      [...text.matchAll(CITE)].flatMap((m) => m[1].split(',').map((t) => Number(t.trim().slice(1))))
    )
  ].sort((a, b) => a - b)

// for pasting a summary outside the app, where the turn numbers mean nothing
export const stripCites = (text: string): string =>
  text.replace(/[ \t]?\[T\d+(?:\s*,\s*T\d+)*\]/g, '')

// a turn's text without its trailing vote block
export const spoken = (text: string): string => text.replace(/```[\s\S]*$/, '').trim()

// Appended to the chair's document so the saved file explains its own citations.
export function sources(doc: string, turns: Turn[]): string {
  const lines = citedTurns(doc).flatMap((n) => {
    const t = turns.find((x) => x.n === n && x.speaker !== HUMAN && x.text)
    if (!t) return []
    const said = spoken(t.text).replace(/\s+/g, ' ')
    return [`- [T${n}] ${t.label} — “${said.length > 180 ? said.slice(0, 180) + '…' : said}”`]
  })
  return lines.length ? `## Sources\n${lines.join('\n')}` : ''
}
