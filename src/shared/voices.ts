// ElevenLabs premade voices, reached by name through OpenRouter's speech API.
export const TTS_MODEL = 'elevenlabs/eleven-v4-turbo'
export const VOICES = [
  'george',
  'sarah',
  'adam',
  'alice',
  'bella',
  'bill',
  'brian',
  'callum',
  'charlie',
  'chris',
  'daniel',
  'eric',
  'harry',
  'jessica',
  'laura',
  'liam',
  'lily',
  'matilda',
  'river',
  'roger',
  'will'
] as const

// Played while the meeting's first seat thinks (later seats think while the previous one talks). Pre-generated per voice into resources/voices/<voice>/<n>.mp3
// by scripts/voices.ts; changing this list means re-running it.
export const FILLERS = [
  'Let me look into it, give me a few seconds.',
  'One moment. I want to think this through properly.',
  'Hold on, let me go over what was just said.',
  "Give me a second, I'm checking something first.",
  'Right. Let me gather my thoughts on this.',
  "Bear with me, I'm reading through the details.",
  'Hmm. Let me weigh that before I answer.',
  'Let me work through this for a moment.',
  'Interesting. Give me a few seconds to be precise.',
  "I'll need a moment to look at this carefully."
]

// The first voice no other seat uses.
export function freeVoice(taken: (string | undefined)[]): string {
  return VOICES.find((v) => !taken.includes(v)) ?? VOICES[0]
}

// Links and file paths stay in the transcript (the chair cites them) but are shortened for the ear:
// https://docs.langchain.com/oss/js/… → "docs.langchain.com"; agent_teams/workers/tools.py:42 → "tools.py in agent teams".
const URL = /\bhttps?:\/\/[^\s)<>\]"']+/g
// a path: starts at / ./ ~/, or has two slashes, or ends in a file extension; "and/or", "CI/CD" are not
const PATH = /(?<![\w/])(?:~?\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+(?::\d+(?:[-–]\d+)?)?/g
function spokenUrl(u: string): string {
  try {
    const tail = u.match(/[.,;:!?]+$/)?.[0] ?? '' // sentence punctuation is not part of the link
    return (
      new globalThis.URL(u.slice(0, u.length - tail.length)).hostname.replace(/^www\./, '') + tail
    )
  } catch {
    return 'a link'
  }
}
function spokenPath(p: string): string {
  const clean = p.replace(/:\d+(?:[-–]\d+)?$/, '')
  const parts = clean.split('/').filter((x) => x && x !== '.' && x !== '..' && x !== '~')
  const file = parts.at(-1) ?? clean
  const nested = parts.length > 2 || /^[~/]/.test(clean)
  if (!/\.[a-z]\w{0,5}$/i.test(file) && !nested) return p // two words with a slash: leave it
  if (parts.length < 2) return file
  // relative paths say their top folder; absolute ones the folder the file sits in
  const folder = /^[~/]/.test(clean) ? parts.at(-2)! : parts[0]
  return `${file} in ${folder.replace(/[_-]+/g, ' ')}`
}

// What gets read aloud: the answer only. No vote block, no markdown, no [T3] citations
// (ElevenLabs v4 would read [brackets] as audio tags).
export function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // the vote block and any code
    .replace(/\{\s*"position"[\s\S]*$/, '') // an unfenced vote at the end
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/[ \t]*\[[^\]]*\]/g, '') // citations, audio-tag lookalikes
    .replace(URL, (u) => spokenUrl(u))
    .replace(PATH, (p) => spokenPath(p))
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '') // table rules
    .replace(/\|/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+•]|>)\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

// Sentence-sized pieces for speech: the first is short so the voice starts early, the rest fill in
// while it plays. A sentence longer than the cap is cut at a comma, else at a space.
const SENTENCE = /(?<=(?<!\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St))[.!?…]["')\]]?)\s+|\n+/
export function chunks(text: string, max = 320): string[] {
  const out: string[] = []
  let cur = ''
  const cap = (): number => (out.length ? max : Math.ceil(max / 2))
  const push = (): void => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (let s of text.split(SENTENCE).filter((x) => x?.trim())) {
    s = s.trim()
    if (cur && cur.length + 1 + s.length > cap()) push()
    while (s.length > cap()) {
      const room = cap() - (cur ? cur.length + 1 : 0)
      const head = s.slice(0, room)
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '))
      const at = cut > room / 3 ? cut + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : room
      cur = cur ? `${cur} ${s.slice(0, at).trim()}` : s.slice(0, at).trim()
      push()
      s = s.slice(at).trim()
    }
    cur = cur ? `${cur} ${s}` : s
  }
  push()
  return out
}
