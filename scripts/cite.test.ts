import assert from 'node:assert/strict'
import test from 'node:test'
import { citedTurns, sources, stripCites } from '../src/shared/cite'
import type { Turn } from '../src/shared/types'

const turn = (n: number, speaker: string, text: string): Turn => ({
  n,
  speaker,
  label: speaker === 'human' ? 'You' : `The ${speaker}`,
  text,
  vote: null
})

test('citations: parse, strip, and list their sources', () => {
  const doc = 'Ship CSV [T3, T1]. Not now [T3][T9]. Plain [link](x) and [T](y).'
  assert.deepEqual(citedTurns(doc), [1, 3, 9])
  assert.equal(stripCites(doc), 'Ship CSV. Not now. Plain [link](x) and [T](y).')

  const turns = [
    turn(1, 'Skeptic', 'Too risky.\n\n```json\n{"position":"no"}\n```'),
    turn(3, 'human', 'a human turn shares n with a member turn'),
    turn(3, 'Engineer', 'Reuse   the queue.')
  ]
  // T9 was never spoken, so it is left out rather than invented
  assert.equal(
    sources(doc, turns),
    '## Sources\n- [T1] The Skeptic — “Too risky.”\n- [T3] The Engineer — “Reuse the queue.”'
  )
  assert.equal(sources('no citations', turns), '')
})
