import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunks, plain } from '../src/shared/voices'

const TURN = `## My view
I **disagree** with the Skeptic [T3]: see [the doc](https://x.dev) and \`src/app.ts:12\`.
- Ship it behind a flag.
- Watch it for 2.5 days, e.g. through the dashboard.

\`\`\`json
{"position":"Ship behind a flag","confidence":0.7,"agrees_with":[],"disagreements":[]}
\`\`\``

test('plain keeps the answer and drops the vote, markdown and citations', () => {
  const p = plain(TURN)
  assert.equal(
    p,
    'My view\nI disagree with the Skeptic: see the doc and app.ts in src.\nShip it behind a flag.\nWatch it for 2.5 days, e.g. through the dashboard.'
  )
  assert.ok(!p.includes('position'))
  assert.equal(plain('Fine.\n{"position":"x","confidence":1}'), 'Fine.')
})

test('chunks keep sentences whole, start short and respect the cap', () => {
  const s = 'This costs 3.5 days, e.g. Stripe did it. '
  const parts = chunks(s.repeat(30), 320)
  assert.ok(parts[0].length <= 160)
  assert.ok(parts.every((p) => p.length <= 320))
  assert.ok(parts.every((p) => p.endsWith('did it.')))
  assert.equal(parts.join(' '), s.repeat(30).trim())
})

test('a sentence longer than the cap is cut at a comma or space', () => {
  const long = Array.from({ length: 60 }, (_, i) => `item ${i}`).join(', ') + '.'
  const parts = chunks(long, 100)
  assert.ok(parts.every((p) => p.length <= 100))
  assert.equal(parts.join(' '), long)
})

test('paths and links are shortened for the ear', () => {
  assert.equal(
    plain('See `agent_teams/workers/tools.py:42` and src/main/voice.ts:10-20.'),
    'See tools.py in agent teams and voice.ts in src.'
  )
  assert.equal(
    plain('Read /Users/julien/Repos/app/agent-teams/config.yaml first.'),
    'Read config.yaml in agent teams first.'
  )
  assert.equal(
    plain('Docs: https://docs.langchain.com/oss/js/deepagents/overview.'),
    'Docs: docs.langchain.com.'
  )
  assert.equal(
    plain('See [the guide](https://x.dev/a/b) and https://www.example.com/x?y=1'),
    'See the guide and example.com'
  )
  assert.equal(
    plain('Use CI/CD and/or a read/write lock on README.md.'),
    'Use CI/CD and/or a read/write lock on README.md.'
  )
  assert.equal(plain('Edit ./setup.py now.'), 'Edit setup.py now.')
})
