import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowed,
  boardBlocks,
  briefFor,
  canvasMarkdown,
  parseSteer,
  type BoardView,
  type SlackConfig
} from '../src/main/slack'
import type { Whiteboard } from '../src/shared/whiteboard'

const config: SlackConfig = {
  allow: ['U1'],
  presets: {
    default: { members: [{ cli: 'claude' }, { cli: 'codex' }] },
    infra: { members: [{ cli: 'gemini' }, { cli: 'grok' }, { cli: 'codex' }], maxTurns: 9 }
  },
  channels: { C_INFRA: 'infra' }
}

test('allow: listed ids, or "*" for anyone in a channel the bot is in', () => {
  assert.equal(allowed(config, 'U1'), true)
  assert.equal(allowed(config, 'U2'), false)
  assert.equal(allowed({ ...config, allow: ['*'] }, 'U2'), true)
})

test('presets: explicit beats the channel beats "default"; the question is the task', () => {
  const clis = (channel: string, text: string): string[] =>
    briefFor(config, channel, text).members.map((m) => m.cli)
  assert.deepEqual(clis('C_ANY', 'Ship a CSV export?'), ['claude', 'codex'])
  assert.deepEqual(clis('C_INFRA', 'Move to ARM?'), ['gemini', 'grok', 'codex'])
  assert.deepEqual(clis('C_INFRA', 'default: Move to ARM?'), ['claude', 'codex'])
  assert.equal(briefFor(config, 'C_ANY', 'infra:  Move to ARM?').task, 'Move to ARM?')
  // a colon that isn't a preset stays in the question; inherited keys aren't presets
  assert.equal(briefFor(config, 'C_ANY', 'Why: speed or cost?').task, 'Why: speed or cost?')
  assert.equal(briefFor(config, 'C_ANY', 'toString: x').task, 'toString: x')
  assert.throws(() => briefFor({ ...config, presets: {} }, 'C_ANY', 'x'), /no preset "default"/)
  assert.throws(() => briefFor(config, 'C_ANY', '   '), /task/)
})

test('steering: focus, ask a member by persona, or a thought for the table', () => {
  const labels = { m1: 'The Strategist', m2: 'The Skeptic', m3: 'The Skeptic 2' }
  assert.deepEqual(parseSteer('focus: the migration cost', labels), {
    kind: 'focus',
    text: 'the migration cost'
  })
  assert.deepEqual(parseSteer('skeptic: what breaks first?', labels), {
    kind: 'ask',
    text: 'what breaks first?',
    targetId: 'm2'
  })
  assert.deepEqual(parseSteer('<@UBOT> The Skeptic 2: and you?', labels), {
    kind: 'ask',
    text: 'and you?',
    targetId: 'm3'
  })
  assert.deepEqual(parseSteer('Note: budget is fixed', labels), {
    kind: 'thought',
    text: 'Note: budget is fixed'
  })
  assert.deepEqual(parseSteer('see https://x.dev/a', labels), {
    kind: 'thought',
    text: 'see https://x.dev/a'
  })
})

const board: Whiteboard = {
  recommendation: 'Ship <CSV> & JSON',
  agreed: [{ id: 'a', text: 'Start with CSV', sources: [1, 3] }],
  disputed: [],
  questions: [{ id: 'q', text: 'x'.repeat(5000), sources: [] }],
  actions: [{ id: 'z', text: 'Write the spec', sources: [2] }],
  revision: 1,
  updatedAt: '',
  throughTurn: 3,
  model: 'm'
}
const view: BoardView = {
  question: 'Ship a CSV export? '.repeat(20),
  board,
  phase: 'debate',
  turn: 4,
  maxTurns: 12,
  usage: { m1: { input: 1, cached: 0, output: 1, costUsd: 0.5 } },
  state: 'running'
}
type Any = { type: string; text?: { text: string }; elements?: { text?: { text: string } }[] }

test('the board renders as blocks: cites, escaping, limits, footer and controls', () => {
  const blocks = boardBlocks(view) as Any[]
  const texts = blocks.map((b) => b.text?.text ?? '')
  assert.equal(blocks[0].type, 'header')
  assert.ok(texts[0].length <= 150)
  assert.match(texts[1], /Ship &lt;CSV&gt; &amp; JSON/)
  assert.ok(texts.some((t) => t.includes('• Start with CSV [T1, T3]')))
  assert.ok(!texts.some((t) => t.includes('Disputed'))) // empty columns are left out
  const open = texts.find((t) => t.startsWith('*Open questions*'))!
  assert.equal(open.length, 3000)
  assert.ok(open.endsWith('…'))
  const footer = blocks.find((b) => b.type === 'context')!.elements![0] as { text: string }
  assert.equal(footer.text, 'debate · turn 4/12 · $0.50')
  const buttons = blocks.at(-1)!.elements!.map((e) => e.text!.text)
  assert.deepEqual(buttons, ['Pause', 'Conclude', 'Stop'])
  const paused = boardBlocks({ ...view, state: 'paused' }) as Any[]
  assert.equal(paused.at(-1)!.elements![0].text!.text, 'Resume')
  // over: no controls, and the footer carries the state and the note
  const done = boardBlocks({ ...view, state: 'decided', note: '<https://x|Doc>' }) as Any[]
  assert.ok(!done.some((b) => b.type === 'actions'))
  const foot = done.at(-1)!.elements![0] as { text: string }
  assert.equal(foot.text, 'decided · turn 4/12 · $0.50\n<https://x|Doc>')
  // before the clerk's first board
  assert.ok(boardBlocks({ ...view, board: undefined }).some((b) => b.type === 'context'))
})

test('with a canvas, the root keeps the gist: recommendation, counts, a link and the controls', () => {
  const blocks = boardBlocks({ ...view, canvas: 'https://x.slack.com/docs/T1/F1' }) as Any[]
  const texts = blocks.map((b) => b.text?.text ?? b.elements?.[0]?.text ?? '')
  assert.match(texts[1], /Recommendation/)
  assert.ok(!texts.some((t) => String(t).includes('Start with CSV')))
  const counts = blocks.find((b) => b.type === 'context')!.elements![0] as { text: string }
  assert.equal(counts.text, 'Agreed 1 · Disputed 0 · Open questions 1 · Actions 1')
  const actions = blocks.at(-1)!.elements as { text: { text: string }; url?: string }[]
  assert.deepEqual(
    actions.map((e) => e.text.text),
    ['Open whiteboard', 'Pause', 'Conclude', 'Stop']
  )
  assert.equal(actions[0].url, 'https://x.slack.com/docs/T1/F1')
  // over: the whiteboard link stays, the controls go
  const done = boardBlocks({ ...view, canvas: 'u', state: 'stopped' }) as Any[]
  assert.equal(done.at(-1)!.elements!.length, 1)
})

test('the whiteboard canvas: sections with cites, moderator guidance, visuals as tables, footer', () => {
  const md = canvasMarkdown({
    ...view,
    question: 'Ship a CSV export?',
    note: ':page_facing_up: <https://x/doc|The decision>',
    board: {
      ...board,
      disputed: [{ id: 'd', text: 'Excel or\nplain CSV', sources: [2] }],
      moderation: { kind: 'resolve', message: 'Settle the format first.', sources: [2] },
      visuals: [
        {
          id: 'v1',
          kind: 'comparison',
          title: 'Formats',
          caption: 'Trade-offs',
          sources: [1],
          options: ['CSV', 'JSON'],
          rows: [{ id: 'r', label: 'Size', cells: ['small | flat', 'larger'] }]
        },
        {
          id: 'v2',
          kind: 'diagram',
          title: 'Flow',
          caption: '',
          sources: [1],
          nodes: [
            { id: 'a', label: 'Export', detail: '', status: 'agreed', sources: [1], column: 0 },
            { id: 'b', label: 'Download', detail: '', status: 'proposed', sources: [1], column: 1 }
          ],
          edges: [{ from: 'a', to: 'b', label: '' }]
        }
      ]
    }
  })
  assert.ok(!md.startsWith('>')) // the title holds the whole question
  assert.match(md, /^## Recommendation\nShip <CSV> & JSON$/m)
  assert.match(md, /^> \*\*Moderator:\*\* Settle the format first\. \[T2\]$/m)
  assert.match(md, /^## Agreed\n- Start with CSV \[T1, T3\]$/m)
  assert.match(md, /^## Disputed\n- Excel or plain CSV \[T2\]$/m)
  assert.match(md, /^## Actions\n- Write the spec \[T2\]$/m)
  assert.match(
    md,
    /### Formats\nTrade-offs \[T1\]\n\n\| Criterion \| CSV \| JSON \|\n\| --- \| --- \| --- \|\n\| Size \| small \\\| flat \| larger \|/
  )
  assert.match(
    md,
    /\| From \| Link \| To \|\n\| --- \| --- \| --- \|\n\| Export \| → \| Download \|/
  )
  assert.match(
    md,
    /---\ndebate · turn 4\/12 · \$0\.50\n\n:page_facing_up: \[The decision\]\(https:\/\/x\/doc\)$/
  )
  // a question longer than the title opens the canvas; before the first board, a placeholder
  const early = canvasMarkdown({ ...view, board: undefined })
  assert.match(early, /^> Ship a CSV export\? Ship/)
  assert.match(early, /The clerk writes the board/)
})
