import type { Cli, TraceStep } from '../shared/types'

// What a member did behind its answer: tool calls and, where the CLI shares it, its reasoning.
// It goes to the human's Trace panel and the saved session, never into another member's prompt.

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

// A tool's arguments in one line: the command, the search and where, or the file.
export function toolDetail(input: unknown): string | undefined {
  const o = object(typeof input === 'string' ? safeJson(input) : input)
  const path =
    str(o.file_path) ?? str(o.absolute_path) ?? str(o.path) ?? str(o.dir_path) ?? str(o.directory)
  const query = str(o.pattern) ?? str(o.query) ?? str(o.glob)
  const command = str(o.command) ?? (Array.isArray(o.args) ? o.args.join(' ') : undefined)
  if (command) return command
  if (str(o.url)) return String(o.url)
  if (query) return path ? `"${query}" in ${path}` : `"${query}"`
  const from = Number(o.start_line ?? o.offset) || 0 // gemini's read_file / Claude's Read
  const to = Number(o.end_line) || 0
  if (path) return from ? `${path}:${from}${to ? `-${to}` : ''}` : path
  return Object.keys(o).length ? JSON.stringify(o) : undefined
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return { value: s }
  }
}

// codex runs every command as `/bin/zsh -lc "…"`; show the command itself
const unwrapShell = (cmd: string): string =>
  cmd
    .replace(/^\/bin\/\w*sh -l?c\s+/, '')
    .replace(/^"([\s\S]*)"$/, '$1')
    .replace(/\\(["\\$`])/g, '$1') // what the shell unescapes inside double quotes

// One parser per run: Claude Code reports how long it thought in separate events before the
// (empty) thinking block, so the parser carries that count across lines.
export function traceParser(cli: Cli): (raw: unknown) => TraceStep[] {
  let thinkingTokens = 0
  return (raw) => {
    const e = object(raw)
    if (cli === 'claude') {
      if (e.type === 'system' && e.subtype === 'thinking_tokens')
        thinkingTokens = Number(e.estimated_tokens) || thinkingTokens
      if (e.type !== 'assistant') return []
      const content = object(e.message).content
      return (Array.isArray(content) ? content : []).flatMap((b): TraceStep[] => {
        const block = object(b)
        if (block.type === 'tool_use')
          return [{ kind: 'tool', name: String(block.name), detail: toolDetail(block.input) }]
        if (block.type !== 'thinking') return []
        const text = str(block.thinking)
        // Claude Code keeps the thinking text private in headless runs; it still counts it
        const step: TraceStep = text
          ? { kind: 'thinking', text }
          : { kind: 'thinking', tokens: thinkingTokens || undefined }
        thinkingTokens = 0
        return [step]
      })
    }
    if (cli === 'codex') {
      const item = object(e.item)
      if (e.type === 'item.started' && item.type === 'command_execution')
        return [{ kind: 'tool', name: 'shell', detail: unwrapShell(String(item.command ?? '')) }]
      if (e.type !== 'item.completed') return []
      if (item.type === 'reasoning' && str(item.text))
        return [{ kind: 'thinking', text: String(item.text) }]
      if (item.type === 'web_search')
        return [{ kind: 'tool', name: 'web_search', detail: str(item.query) }]
      if (item.type === 'mcp_tool_call')
        return [
          { kind: 'tool', name: `${item.server}.${item.tool}`, detail: toolDetail(item.arguments) }
        ]
      return []
    }
    if (cli === 'gemini') {
      if (e.type === 'tool_use')
        return [{ kind: 'tool', name: String(e.tool_name), detail: toolDetail(e.parameters) }]
      return []
    }
    if (cli === 'grok') {
      // ponytail: grok's event names unverified (its free quota ran out); same guesses as activity.ts
      if (e.type === 'tool_use' || e.type === 'tool_call')
        return [
          {
            kind: 'tool',
            name: String(e.name ?? e.tool_name ?? 'tool'),
            detail: toolDetail(e.input ?? e.arguments ?? e.parameters)
          }
        ]
      const text = str(e.data) ?? str(e.text) ?? str(e.content)
      if ((e.type === 'thinking' || e.type === 'reasoning') && text)
        return [{ kind: 'thinking', text }]
    }
    return []
  }
}

// Paths relative to the attached folders, and sizes a session file can carry.
export function tidy(step: TraceStep, dirs: (string | undefined)[]): TraceStep {
  if (step.kind === 'thinking')
    return step.text ? { ...step, text: step.text.slice(0, 4000) } : step
  let detail = step.detail
  for (const d of dirs) if (d && detail) detail = detail.split(`${d}/`).join('').split(d).join('.')
  return { ...step, detail: detail?.slice(0, 300) }
}
