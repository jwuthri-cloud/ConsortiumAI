import assert from 'node:assert/strict'
import test from 'node:test'
import { parseVisuals, visualContext, visualDiscussion } from '../src/shared/boardVisuals'
import { parseBoard, boardPrompt } from '../src/main/whiteboard'
import { demoVisuals } from '../src/renderer/src/demoVisuals'
import { initial, reducer } from '../src/renderer/src/state'
import type { Session } from '../src/shared/types'

const allowed = new Set(Array.from({ length: 12 }, (_, i) => i + 1))
const fixture = (): ReturnType<typeof demoVisuals> => demoVisuals(12)
const snapshot = {
  task: 'Export?',
  turns: [...allowed].map((n) => ({ n, label: `Member ${n % 3}`, text: 'Discussion evidence.' }))
}

test('visual formats survive validation and saved-session rehydration', () => {
  const visuals = parseVisuals(fixture(), allowed)
  assert.deepEqual(
    visuals.map((v) => v.kind),
    ['diagram', 'comparison', 'sequence']
  )
  const board = parseBoard(
    JSON.stringify({
      recommendation: 'Try CSV',
      agreed: [],
      disputed: [],
      questions: [],
      actions: [],
      visuals
    }),
    snapshot
  )
  const session: Session = {
    version: 2,
    id: 'visual-test',
    status: 'stopped',
    createdAt: '',
    brief: { task: 'Export?', members: [], chairId: '', maxTurns: 20 },
    labels: {},
    turns: [],
    shape: null,
    converged: false,
    whiteboard: board
  }
  assert.deepEqual(
    reducer(initial, { type: 'open', session: JSON.parse(JSON.stringify(session)) }).whiteboard
      ?.visuals,
    visuals
  )
  assert.deepEqual(parseVisuals(undefined, allowed), [])
  assert.deepEqual(parseVisuals([], allowed), [])
})

test('invalid graph links, duplicate IDs, unsupported citations, oversized payloads and comparison mismatches are rejected', () => {
  const valid = fixture()
  assert.throws(() => parseVisuals([...valid, valid[0]], allowed))
  assert.throws(() =>
    parseVisuals([{ ...valid[0], edges: [{ from: 'demand', to: 'missing' }] }], allowed)
  )
  assert.throws(() => parseVisuals([valid[0], valid[0]], allowed))
  assert.throws(() => parseVisuals([{ ...valid[0], sources: [99] }], allowed))
  assert.throws(() =>
    parseVisuals([{ ...valid[1], rows: [{ id: 'x', label: 'Scope', cells: ['one'] }] }], allowed)
  )
  assert.throws(() =>
    parseVisuals([{ ...valid[0], kind: 'html', html: '<script>alert(1)</script>' }], allowed)
  )
  const graph = valid[0]
  assert.equal(graph.kind, 'diagram')
  if (graph.kind === 'diagram') {
    assert.throws(() =>
      parseVisuals([{ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }], allowed)
    )
    assert.throws(() =>
      parseVisuals([{ ...graph, nodes: graph.nodes.map((n) => ({ ...n, sources: [] })) }], allowed)
    )
  }
})

test('source filtering and conservative statuses keep uncertain diagrams explicit', () => {
  const graph = fixture()[0]
  if (graph.kind !== 'diagram') throw new Error('Expected graph')
  const parsed = parseVisuals(
    [
      {
        ...graph,
        nodes: graph.nodes.map((n) => ({
          ...n,
          sources: [1, 99, '1', 1],
          column: 40,
          status: 'certain'
        }))
      }
    ],
    allowed
  )[0]
  assert.equal(parsed.kind, 'diagram')
  if (parsed.kind === 'diagram')
    for (const node of parsed.nodes) {
      assert.deepEqual(node.sources, [1])
      assert.equal(node.status, 'proposed')
      assert.equal(node.column, 3)
    }
})

test('discussion references the exact revision and selected element; agents and writer share stable visual IDs', () => {
  const graph = fixture()[0]
  if (graph.kind !== 'diagram') throw new Error('Expected graph')
  const message = visualDiscussion(graph, 7, graph.nodes[0])
  assert.match(message, /revision 7/)
  assert.match(message, /\[export-path\]/)
  assert.match(message, /\[demand\]/)
  assert.match(message, /Challenge its assumptions/)
  assert.match(message, /Snapshot being discussed/)
  assert.match(message, /#1 → #2: If validated/)
  assert.ok(message.length < 4000)
  const context = visualContext({ revision: 7, throughTurn: 10, visuals: fixture() })
  assert.match(context, /provisional synthesis, never independent evidence/)
  assert.match(context, /"id":"export-path"/)
  assert.match(context, /"from":"demand","to":"csv"/)
  assert.match(boardPrompt(snapshot), /Respond to members' visual proposals and corrections/)
})
