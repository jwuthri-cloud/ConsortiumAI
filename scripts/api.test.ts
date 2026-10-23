import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApi, toBrief } from '../src/main/api'
import type { runMember } from '../src/main/cli'

// A whole meeting through HTTP with the CLIs faked: every member agrees at once, the chair decides.
const VOTE =
  '```json\n{"position":"Ship the CSV","confidence":0.9,"agrees_with":[],"disagreements":[]}\n```'
let hold: Promise<void> = Promise.resolve()
const run: typeof runMember = async (_cli, _args, onDelta, key) => {
  await hold
  if (key.endsWith(':whiteboard')) return { text: 'not a board' } // the board keeps its last good state
  if (key.endsWith(':chair'))
    return { text: '# Consortium: Export\n\n## Recommendation\nShip the CSV.' }
  onDelta('Ship the CSV. ')
  return { text: `Ship the CSV.\n${VOTE}` }
}

const TOKEN = 'test-token'
async function api(): Promise<{ base: string; close: () => void }> {
  const server = createApi({ token: TOKEN, dir: await mkdtemp(join(tmpdir(), 'api-test-')), run })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close()
  }
}
const call = (base: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(base + path, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...init.headers
    }
  })
const brief = {
  task: 'Ship a CSV export?',
  members: [{ cli: 'claude' }, { cli: 'codex' }],
  maxTurns: 6
}

test('briefs: members need only a cli; the rest is filled in or refused', () => {
  const b = toBrief(brief)
  assert.deepEqual(
    b.members.map((m) => [m.id, m.cli, m.persona, m.model]),
    [
      ['m1', 'claude', 'strategist', 'claude-opus-5-5'],
      ['m2', 'codex', 'engineer', 'gpt-6.1-sol']
    ]
  )
  assert.equal(b.chairId, 'm1')
  for (const bad of [
    {},
    { task: 'x', members: [{ cli: 'claude' }] },
    { task: 'x', members: [{ cli: 'claude' }, { cli: 'cursor' }] },
    { task: 'x', members: [{ cli: 'claude' }, { cli: 'harness' }] }, // the Deep-agent needs a model
    { ...brief, projectPath: '/no/such/folder' },
    { ...brief, chairId: 'nobody' }
  ])
    assert.throws(() => toBrief(bad), JSON.stringify(bad))
})

test('every request needs the token', async () => {
  const { base, close } = await api()
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401)
    assert.equal(
      (await fetch(`${base}/health`, { headers: { authorization: 'Bearer nope' } })).status,
      401
    )
    const h = await call(base, '/health')
    assert.equal(h.status, 200)
    assert.equal(((await h.json()) as { ok: boolean }).ok, true)
  } finally {
    close()
  }
})

test('?wait=1 runs a meeting to its decision and answers with it', async () => {
  const { base, close } = await api()
  try {
    const r = await call(base, '/meetings?wait=1', { method: 'POST', body: JSON.stringify(brief) })
    assert.equal(r.status, 200)
    const out = (await r.json()) as { id: string; status: string; decision: string }
    assert.equal(out.status, 'done')
    assert.match(out.decision, /Ship the CSV/)
    const md = await call(base, `/meetings/${out.id}/decision`)
    assert.match(await md.text(), /## Recommendation/)
    const list = (await (await call(base, '/meetings')).json()) as { id: string }[]
    assert.ok(list.some((s) => s.id === out.id))
  } finally {
    close()
  }
})

test('events stream live and end with the decision; one meeting at a time', async () => {
  const { base, close } = await api()
  let release = (): void => {}
  hold = new Promise((r) => (release = r))
  try {
    const { id } = (await (
      await call(base, '/meetings', { method: 'POST', body: JSON.stringify(brief) })
    ).json()) as { id: string }
    const busy = await call(base, '/meetings', { method: 'POST', body: JSON.stringify(brief) })
    assert.equal(busy.status, 409)
    const stream = await call(base, `/meetings/${id}/events`)
    assert.equal(stream.headers.get('content-type'), 'text/event-stream')
    release()
    const text = await stream.text() // ends with the meeting
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    // connected after turn 1 had started: the stream still begins at the beginning
    const first = JSON.parse(text.match(/^event: turn-start\ndata: (.+)$/m)![1]) as { turn: number }
    assert.equal(first.turn, 1)
    assert.ok(types.includes('turn-start') && types.includes('turn-done'), types.join(','))
    assert.equal(types.at(-1), 'consortium')
    assert.equal((await call(base, `/meetings/${id}/stop`, { method: 'POST' })).status, 409) // already over
  } finally {
    hold = Promise.resolve()
    close()
  }
})
