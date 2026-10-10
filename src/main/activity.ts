import type { ActivityKind, Cli } from '../shared/types'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})

function toolActivity(value: unknown): ActivityKind {
  const name = typeof value === 'string' ? value.toLowerCase() : ''
  if (/search|grep|glob|find|list_directory|list_files/.test(name)) return 'searching'
  if (/read|view|open_file/.test(name)) return 'reading'
  return 'tool'
}

// Coarse status for the seat ("reading", "searching"). The tool calls and reasoning themselves go
// to the human's Trace panel (trace.ts); none of it reaches another member's prompt.
export function streamActivity(cli: Cli, raw: unknown): ActivityKind | undefined {
  const event = object(raw)
  if (cli === 'claude') {
    if (event.type === 'system' && event.subtype === 'init') return 'thinking'
    if (event.type === 'stream_event') {
      const inner = object(event.event)
      if (inner.type === 'content_block_start') {
        const block = object(inner.content_block)
        if (block.type === 'thinking') return 'thinking'
        if (block.type === 'tool_use') return toolActivity(block.name)
        if (block.type === 'text') return 'responding'
      }
      if (inner.type === 'content_block_delta') {
        const delta = object(inner.delta)
        if (delta.type === 'thinking_delta') return 'thinking'
        if (delta.type === 'text_delta') return 'responding'
      }
    }
    if (event.type === 'user') {
      const content = object(event.message).content
      if (Array.isArray(content) && content.some((b) => object(b).type === 'tool_result'))
        return 'reviewing'
    }
  }
  if (cli === 'codex') {
    if (event.type === 'thread.started' || event.type === 'turn.started') return 'thinking'
    if (['item.started', 'item.updated', 'item.completed'].includes(String(event.type))) {
      const item = object(event.item)
      if (item.type === 'reasoning') return 'thinking'
      if (item.type === 'agent_message') return 'responding'
      if (
        ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(
          String(item.type)
        )
      ) {
        if (event.type === 'item.completed') return 'reviewing'
        if (item.type === 'web_search') return 'searching'
        return toolActivity(item.tool)
      }
    }
  }
  if (cli === 'gemini') {
    if (event.type === 'init') return 'thinking'
    if (event.type === 'tool_use') return toolActivity(event.tool_name)
    if (event.type === 'tool_result') return 'reviewing'
    if (event.type === 'message' && event.role === 'assistant') return 'responding'
  }
  if (cli === 'grok') {
    if (event.type === 'text') return 'responding'
    if (event.type === 'tool_use' || event.type === 'tool_call')
      return toolActivity(event.name ?? event.tool_name)
    if (event.type === 'tool_result') return 'reviewing'
    if (event.type === 'thinking' || event.type === 'reasoning') return 'thinking'
  }
  return undefined
}
