import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fullTranscript } from '../src/main/debate'
import type { Session } from '../src/shared/types'

test('transcript: seats with models, then every turn with its trace, message and vote', () => {
  const s = {
    id: 's1',
    createdAt: '2026-10-10T07:40:00Z',
    brief: {
      task: 'Which topic?',
      maxTurns: 4,
      chairId: 'a',
      members: [{ id: 'a', cli: 'claude', persona: 'strategist', resolvedModel: 'claude-opus-5-5' }]
    },
    labels: { a: 'The Strategist' },
    turns: [
      {
        n: 1,
        speaker: 'a',
        label: 'The Strategist',
        text: 'Eval awareness.',
        vote: { position: 'x', confidence: 0.7, agrees_with: [], disagreements: [] },
        trace: [{ kind: 'tool', name: 'Read', detail: 'README.md' }]
      },
      { n: 1, speaker: 'human', label: 'Host', text: 'Go narrower.', vote: null }
    ],
    usage: { a: { input: 10, cached: 0, output: 5, costUsd: 0.01 } }
  } as unknown as Session
  const md = fullTranscript(s)
  assert.match(md, /\| The Strategist \| Strategist \| Claude Code \| claude-opus-5-5 · chair \|/)
  assert.equal(md.match(/^## Turn /gm)?.length, 2)
  assert.match(md, /🔧 `Read` README\.md/)
  assert.match(md, /"confidence": 0\.7/)
  assert.match(md, /## Turn 1 · Host\n\n### Message\nGo narrower\./)
  assert.match(md, /\| The Strategist \| 10 \| 0 \| 5 \| \$0\.0100 \|/)
})
