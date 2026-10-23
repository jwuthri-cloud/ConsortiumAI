// The one check that fails if the vote parsing breaks: npx tsx scripts/check.ts
import { extractVote, stripVote, extractJson, stance, withoutLocations } from '../src/shared/vote'

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

// no paths or URLs in what the table says (lines from a real turn)
const clean = (input: string, want: string): void =>
  console.assert(
    withoutLocations(input) === want,
    `withoutLocations:\n  got  ${JSON.stringify(withoutLocations(input))}\n  want ${JSON.stringify(want)}`
  )
clean(
  'The builder already requests a small patch and a replay of the failing conversation (`python/dagster/connectly_dagster/lib/agent_builder_v2_client.py:261`). Stronger prompting alone isn’t my first move.',
  'The builder already requests a small patch and a replay of the failing conversation. Stronger prompting alone isn’t my first move.'
)
clean(
  'without feeding those failures back for correction (`python/dagster/assets/agent_self_heal.py:1261`).',
  'without feeding those failures back for correction.'
)
clean('Two spots disagree (see `src/a.ts:3`, `src/b.py:9-12`) here.', 'Two spots disagree here.')
clean(
  'Per [the release notes](https://github.com/electron/electron/releases/tag/v44.7.0), 44 is current.',
  'Per the release notes, 44 is current.'
)
clean(
  'Electron 44 is current (https://github.com/electron/electron/releases).',
  'Electron 44 is current.'
)
clean(
  'The runner in `src/main/cli.ts` spawns it; see src/main/cli.ts:436 too.',
  'The runner in `cli.ts` spawns it; see cli.ts too.'
)
clean(
  'Keep the /api/v1 route, and/or package.json, at 3.5:1 and v1.2.3, e.g. node.js.',
  'Keep the /api/v1 route, and/or package.json, at 3.5:1 and v1.2.3, e.g. node.js.'
)
