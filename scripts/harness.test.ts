import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitModel } from '../src/shared/types'
import { modelName } from '../src/shared/models'
import { callUsage, toolActivity } from '../src/main/harness'
import { listModels, openrouterPrice } from '../src/main/cli'

// The OpenRouter catalogue, as the harness sees it (no network in tests).
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      data: [
        {
          id: 'anthropic/claude-opus-5.5',
          pricing: { prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002' }
        },
        {
          id: 'anthropic/claude-opus-5.5:batch',
          pricing: { prompt: '0.000002', completion: '0.00001' }
        },
        { id: 'z-ai/glm-5.3', pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.00001' } },
        { id: 'openai/dall-e-4', pricing: { prompt: '0', completion: '0' } }
      ]
    })
  )

test('splitModel reads provider:model and defaults bare ids to OpenRouter', () => {
  assert.deepEqual(splitModel('openrouter:anthropic/claude-opus-5.5'), {
    provider: 'openrouter',
    model: 'anthropic/claude-opus-5.5'
  })
  assert.deepEqual(splitModel('anthropic:claude-opus-5-5'), {
    provider: 'anthropic',
    model: 'claude-opus-5-5'
  })
  assert.deepEqual(splitModel('openrouter:meta/llama-5:free'), {
    provider: 'openrouter',
    model: 'meta/llama-5:free'
  })
  assert.deepEqual(splitModel('z-ai/glm-5.3'), { provider: 'openrouter', model: 'z-ai/glm-5.3' })
  assert.deepEqual(splitModel('openai:'), { provider: 'openai', model: '' })
  assert.deepEqual(splitModel(undefined), { provider: 'openrouter', model: '' })
})

test('the table shows the model, not the route to it', () => {
  assert.equal(modelName('openrouter:anthropic/claude-opus-5.5'), 'claude-opus-5.5')
  assert.equal(modelName('xai:grok-4.7'), 'grok-4.7')
  assert.equal(modelName('openrouter:openrouter/auto'), undefined)
  assert.equal(modelName('claude-opus-5-5[1m]'), 'claude-opus-5-5')
})

test('tool calls become activity', () => {
  assert.equal(toolActivity('read_file'), 'reading')
  assert.equal(toolActivity('ls'), 'reading')
  assert.equal(toolActivity('grep'), 'searching')
  assert.equal(toolActivity('glob'), 'searching')
  assert.equal(toolActivity('write_todos'), 'thinking')
  assert.equal(toolActivity('task'), 'tool')
})

test('usage: list price per call, tokens only when the price is unknown', () => {
  const usage_metadata = {
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    input_token_details: { cache_read: 400 }
  }
  const est = callUsage({ usage_metadata }, { prompt: 4e-6, completion: 2e-5, cacheRead: 2e-7 })!
  assert.equal(est.estimated, true)
  assert.ok(Math.abs(est.costUsd! - (600 * 4e-6 + 400 * 2e-7 + 200 * 2e-5)) < 1e-12)
  // no cache price: cached tokens at the input price
  assert.ok(
    Math.abs(
      callUsage({ usage_metadata }, { prompt: 1e-6, completion: 1e-6 })!.costUsd! - 1200e-6
    ) < 1e-12
  )
  assert.deepEqual(callUsage({ usage_metadata }), { input: 1000, cached: 400, output: 200 })
  assert.equal(callUsage({}), undefined)
})

test('list prices match OpenRouter ids and direct-provider ids alike', async () => {
  assert.deepEqual(await openrouterPrice('anthropic/claude-opus-5.5'), {
    prompt: 4e-6,
    completion: 2e-5,
    cacheRead: 2e-7
  })
  assert.equal((await openrouterPrice('anthropic/claude-opus-5-5'))?.prompt, 4e-6) // anthropic:claude-opus-5-5
  assert.equal((await openrouterPrice('z-ai/glm-5.3'))?.cacheRead, undefined)
  assert.equal(await openrouterPrice('openrouter/auto'), undefined) // variable price
  assert.equal(await openrouterPrice('nobody/nothing'), undefined)
})

test('harness model suggestions: every OpenRouter chat model, plus direct-provider ids', async () => {
  const ids = await listModels('harness')
  assert.ok(ids.includes('openrouter:anthropic/claude-opus-5.5'))
  assert.ok(ids.includes('openrouter:z-ai/glm-5.3'))
  assert.ok(ids.includes('anthropic:claude-opus-5-5'))
  assert.ok(ids.includes('openai:gpt-6-sol'))
  assert.ok(!ids.some((id) => id.includes(':batch') || id.includes('dall-e')))
})
