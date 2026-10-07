import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamModel, codexSessionModel } from '../src/main/modelMetadata'
import { modelName, memberModel } from '../src/shared/models'
import { reducer, initial } from '../src/renderer/src/state'
import type { Brief, Session } from '../src/shared/types'

test('labels remove configuration annotations without changing model IDs', () => {
  assert.equal(modelName('claude-opus-4-6[1m]'), 'claude-opus-4-6')
  assert.equal(modelName('gpt-5.4 · reasoning: high'), 'gpt-5.4')
  assert.equal(modelName('gpt-5.4 (thinking budget: 8192)'), 'gpt-5.4')
  assert.equal(modelName('gpt-5.4 xhigh'), 'gpt-5.4')
  assert.equal(modelName('gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview')
  for (const alias of ['auto', 'auto-gemini-3', 'opus[1m]', 'CLI default', ''])
    assert.equal(modelName(alias), undefined)
  assert.equal(memberModel({ model: 'opus', resolvedModel: 'claude-opus-4-6' }), 'claude-opus-4-6')
})

test('provider metadata resolves defaults and ignores generated model-looking text', () => {
  assert.equal(
    streamModel('claude', { type: 'system', subtype: 'init', model: 'claude-opus-4-6' }),
    'claude-opus-4-6'
  )
  assert.equal(
    streamModel('claude', {
      type: 'stream_event',
      event: { type: 'message_start', message: { model: 'claude-sonnet-4-6' } }
    }),
    'claude-sonnet-4-6'
  )
  assert.equal(streamModel('gemini', { type: 'init', model: 'auto-gemini-3' }), undefined)
  assert.equal(
    streamModel('gemini', {
      type: 'result',
      stats: {
        models: { 'gemini-flash': { output_tokens: 2 }, 'gemini-pro': { output_tokens: 200 } }
      }
    }),
    'gemini-pro'
  )
  assert.equal(streamModel('grok', { type: 'end', model: 'grok-4.7' }), 'grok-4.7')
  assert.equal(
    streamModel('codex', { type: 'item.completed', item: { text: 'model: fake' }, model: 'fake' }),
    undefined
  )
  assert.equal(streamModel('claude', { type: 'user', message: { model: 'fake' } }), undefined)
})

test('Codex resolves only the matching rollout and uses its latest turn model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'consortium-model-test-'))
  try {
    const id = '12345678-1234-1234-1234-123456789abc'
    const dir = join(root, 'sessions', '2026', '10', '07')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `rollout-date-${id}.jsonl`),
      [
        { type: 'turn_context', payload: { model: 'gpt-5.3-codex', effort: 'high' } },
        { type: 'response_item', payload: { model: 'fake' } },
        { type: 'turn_context', payload: { model: 'gpt-5.4', effort: 'low' } }
      ]
        .map(JSON.stringify)
        .join('\n') + '\n{partial'
    )
    await writeFile(
      join(dir, 'rollout-other-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      JSON.stringify({ type: 'turn_context', payload: { model: 'wrong' } })
    )
    assert.equal(await codexSessionModel(id, root), 'gpt-5.4')
    assert.equal(await codexSessionModel('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', root), undefined)
    assert.equal(await codexSessionModel('../config', root), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolved model reaches the room and survives saved-session rehydration', () => {
  const brief: Brief = {
    task: 'Test',
    members: [{ id: 'a', cli: 'codex', persona: 'engineer' }],
    chairId: 'a',
    maxTurns: 20
  }
  const start = reducer(initial, { type: 'convene', brief, sessionId: 'test' })
  assert.equal(
    reducer(start, { type: 'member-model', sessionId: 'other', memberId: 'a', model: 'wrong' }),
    start
  )
  const live = reducer(start, {
    type: 'member-model',
    sessionId: 'test',
    memberId: 'a',
    model: 'gpt-5.4'
  })
  assert.equal(memberModel(live.brief!.members[0]), 'gpt-5.4')
  assert.equal(brief.members[0].resolvedModel, undefined)
  const session: Session = JSON.parse(
    JSON.stringify({
      version: 2,
      id: 'test',
      createdAt: '',
      brief: live.brief,
      labels: { a: 'Engineer' },
      turns: [],
      shape: null,
      converged: false,
      status: 'done'
    })
  )
  assert.equal(
    memberModel(reducer(initial, { type: 'open', session }).brief!.members[0]),
    'gpt-5.4'
  )
})
