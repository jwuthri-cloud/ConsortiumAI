import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize } from '../src/shared/summary'
import type { Session } from '../src/shared/types'

const base: Session = {
  version: 2,
  id: 's',
  createdAt: '2026-10-01T10:00:00Z',
  brief: {
    task: 'Should we ship a customer data export this quarter? Two renewals asked for it.\nMore context.',
    projectPath: '/r/acme',
    members: [
      { id: 'a', cli: 'claude', persona: 'strategist', model: 'opus' },
      { id: 'b', cli: 'codex', persona: 'skeptic' }
    ],
    chairId: 'a',
    maxTurns: 30
  },
  labels: {},
  turns: [
    { n: 1, speaker: 'a', label: 'S', text: '', vote: null },
    { n: 2, speaker: 'human', label: 'H', text: '', vote: null },
    { n: 2, speaker: 'b', label: 'K', text: '', vote: null }
  ],
  shape: { converging: [{ point: 'CSV behind a **flag**', supporters: [] }], open: [] },
  converged: false,
  status: 'stopped'
}

test('unfinished: title from the question, outcome from where the table leans', () => {
  const s = summarize(base)
  assert.equal(s.title, 'Should we ship a customer data export this quarter?')
  assert.equal(s.outcome, 'Leaning toward: CSV behind a flag')
  assert.deepEqual(s.team, [
    { cli: 'claude', persona: 'strategist' },
    { cli: 'codex', persona: 'skeptic' }
  ])
  assert.equal(s.turn, 2)
  assert.equal(s.projectPath, '/r/acme')
  assert.equal(summarize({ ...base, shape: null, turns: [] }).outcome, undefined)
  assert.equal(s.usage, undefined) // saved before usage tracking
  assert.equal(s.files, undefined)
  assert.deepEqual(
    summarize({ ...base, brief: { ...base.brief, attachments: ['/a/b/notes.pdf', '/a/shot.png'] } })
      .files,
    ['notes.pdf', 'shot.png']
  )
  const spent = summarize({
    ...base,
    usage: {
      a: { input: 100, cached: 0, output: 10, costUsd: 0.5 },
      chair: { input: 50, cached: 0, output: 5, costUsd: 0.25, estimated: true }
    }
  }).usage!
  assert.deepEqual([spent.input + spent.output, spent.costUsd, spent.estimated], [165, 0.75, true])
})

test('decided: title and outcome come from the consortium document', () => {
  const markdown =
    '# Consortium: Customer data export\n\n## Decision\n**Build** a capped CSV export, e.g. async. Then pilot it.\n\n## Rationale\nBecause.'
  const s = summarize({ ...base, status: 'done', consortium: { markdown, path: '' } })
  assert.equal(s.title, 'Customer data export')
  assert.equal(s.outcome, 'Build a capped CSV export, e.g. async.')
  const sourced = summarize({
    ...base,
    status: 'done',
    consortium: {
      markdown:
        '# Consortium: X\n\n## Recommendation\nShip it [T1, T3]. Later.\n\n## Trade-offs\n-',
      path: ''
    }
  })
  assert.equal(sourced.outcome, 'Ship it.')
})

test('long titles clip on a word', () => {
  const t = summarize({ ...base, brief: { ...base.brief, task: 'word '.repeat(40) } }).title
  assert.ok(t.length <= 91 && t.endsWith('word…'), t)
})
