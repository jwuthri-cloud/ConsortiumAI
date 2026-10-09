import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addUsage,
  fmtTokens,
  fmtUsd,
  minus,
  priced,
  readUsage,
  sumUsage
} from '../src/shared/usage'

test('claude and codex usage normalize to the same shape', () => {
  // claude stream-json result: cache reads/writes sit outside input_tokens
  assert.deepEqual(
    readUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 2436,
      cache_read_input_tokens: 535,
      output_tokens: 4
    }),
    { input: 2973, cached: 535, output: 4 }
  )
  // codex turn.completed: cached sits inside input_tokens
  assert.deepEqual(
    readUsage({ input_tokens: 18670, cached_input_tokens: 13184, output_tokens: 5 }),
    { input: 18670, cached: 13184, output: 5 }
  )
  assert.equal(readUsage({}), undefined)
  assert.equal(readUsage(null), undefined)
})

test('a resumed codex thread counts only this run', () => {
  const first = { input: 18670, cached: 13184, output: 5 }
  const total = { input: 39890, cached: 31616, output: 11 }
  assert.deepEqual(minus(total, first), { input: 21220, cached: 18432, output: 6 })
})

test('pricing keeps reported cost, estimates the rest, and sums', () => {
  assert.equal(
    priced({ input: 1, cached: 0, output: 1, costUsd: 0.02 }, 'gpt-6-astra').costUsd,
    0.02
  )
  const est = priced({ input: 1_000_000, cached: 500_000, output: 100_000 }, 'gpt-6-astra')
  assert.equal(est.costUsd, 10.5) // 0.5M × $10 + 0.5M × $1 + 0.1M × $50
  assert.equal(est.estimated, true)
  assert.equal(priced({ input: 5, cached: 0, output: 5 }, 'mystery-1').costUsd, undefined)
  assert.equal(priced({ input: 1e6, cached: 0, output: 0 }, 'gemini-3.8-flash').costUsd, 0.75)
  const total = sumUsage([est, undefined, { input: 10, cached: 0, output: 0, costUsd: 0.5 }])!
  assert.equal(total.costUsd, 11)
  assert.equal(total.input, 1_000_010)
  assert.equal(fmtUsd(total), '≈$11.00')
  assert.equal(fmtUsd(addUsage(undefined, { input: 1, cached: 0, output: 0 })), '—')
  assert.deepEqual(
    [fmtTokens(950), fmtTokens(1234), fmtTokens(45_600), fmtTokens(2_345_678)],
    ['950', '1.2k', '46k', '2.35M']
  )
})
