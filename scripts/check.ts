// The one check that fails if the vote parsing breaks: npx tsx scripts/check.ts
import { extractVote, stripVote, extractJson, stance } from '../src/shared/vote'

const answer =
  'Position text\n```json\n{"position":"p","confidence":"0.5","agrees_with":["The Skeptic"],"disagreements":[{"with":"The Engineer","on":"scope"},{"bad":1}]}\n```'
const v = extractVote(answer)
console.assert(
  v &&
    v.position === 'p' &&
    v.confidence === 0.5 &&
    v.disagreements.length === 1 &&
    v.agrees_with[0] === 'The Skeptic',
  'extractVote broken',
  JSON.stringify(v)
)
console.assert(stripVote(answer) === 'Position text', 'stripVote broken')
console.assert(extractVote('no block') === null, 'extractVote must be null without a block')
console.assert(
  extractVote('```json\nnot json\n```') === null,
  'extractVote must be null on bad json'
)
console.assert(extractJson<{ a: number }>('prefix {"a":1} suffix')?.a === 1, 'extractJson broken')
console.assert(extractJson('nothing') === null, 'extractJson must be null without an object')
console.log('ok')

// members name each other loosely; the agreement matrix must still find them
const loose = {
  position: 'p',
  confidence: 1,
  agrees_with: ['Strategist'],
  disagreements: [{ with: 'the engineer', on: 'x' }]
}
console.assert(
  stance(loose, 'The Strategist') === 'agree',
  'stance must match a label without "The"'
)
console.assert(stance(loose, 'The Engineer') === 'disagree', 'stance must ignore case and "the"')
console.assert(stance(loose, 'The Researcher') === undefined, 'stance must not invent a position')
console.assert(stance(null, 'The Strategist') === undefined, 'no vote, no stance')
