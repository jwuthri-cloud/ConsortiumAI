import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tidy, toolDetail, traceParser } from '../src/main/trace'

// Lines as the CLIs print them (trimmed copies of real runs on this repo).
const repo = '/Users/me/repo'
const steps = (cli: Parameters<typeof traceParser>[0], lines: unknown[]): unknown[] => {
  const parse = traceParser(cli)
  return lines.flatMap(parse).map((s) => tidy(s, [repo]))
}

test('claude: tool calls, and how long it thought when the text is private', () => {
  assert.deepEqual(
    steps('claude', [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'runHarness', path: repo } }
          ]
        }
      },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 166 },
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] }
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: `${repo}/src/a.ts`, offset: 40 } }
          ]
        }
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'Check the caller.' }] }
      }
    ]),
    [
      { kind: 'tool', name: 'Grep', detail: '"runHarness" in .' },
      { kind: 'thinking', tokens: 166 },
      { kind: 'tool', name: 'Read', detail: 'src/a.ts:40' },
      { kind: 'thinking', text: 'Check the caller.' }
    ]
  )
})

test('codex: commands without the shell wrapper, and reasoning summaries', () => {
  assert.deepEqual(
    steps('codex', [
      { type: 'item.completed', item: { type: 'agent_message', text: 'Looking.' } },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          command: `/bin/zsh -lc "rg -n '\\\\brunHarness\\\\b' ."`
        }
      },
      { type: 'item.completed', item: { type: 'command_execution', command: '/bin/zsh -lc "ls"' } },
      {
        type: 'item.completed',
        item: { type: 'reasoning', text: '**Calculating time**\n\nAdd 2:38.' }
      }
    ]),
    [
      { kind: 'tool', name: 'shell', detail: "rg -n '\\brunHarness\\b' ." },
      { kind: 'thinking', text: '**Calculating time**\n\nAdd 2:38.' }
    ]
  )
})

test('gemini: tools with paths made relative and line ranges', () => {
  assert.deepEqual(
    steps('gemini', [
      {
        type: 'tool_use',
        tool_name: 'grep_search',
        parameters: { pattern: 'runHarness', dir_path: repo }
      },
      { type: 'tool_result', tool_id: 'x', status: 'success' },
      {
        type: 'tool_use',
        tool_name: 'read_file',
        parameters: { file_path: `${repo}/src/main/cli.ts`, start_line: 434, end_line: 438 }
      }
    ]),
    [
      { kind: 'tool', name: 'grep_search', detail: '"runHarness" in .' },
      { kind: 'tool', name: 'read_file', detail: 'src/main/cli.ts:434-438' }
    ]
  )
})

test('tool details: command, search, file, else the raw arguments', () => {
  assert.equal(toolDetail({ command: 'git log -3' }), 'git log -3')
  assert.equal(toolDetail('{"pattern":"*.ts"}'), '"*.ts"')
  assert.equal(
    toolDetail({ description: 'look', subagent_type: 'general' }),
    '{"description":"look","subagent_type":"general"}'
  )
  assert.equal(toolDetail({}), undefined)
})
