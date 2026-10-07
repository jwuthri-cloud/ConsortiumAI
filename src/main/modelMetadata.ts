import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Cli } from '../shared/types'
import { modelName } from '../shared/models'
import { readUsage, type Usage } from '../shared/usage'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {})
const name = (value: unknown): string | undefined =>
  typeof value === 'string' ? modelName(value) : undefined

// Read protocol metadata, never model-looking strings in generated prose or tool output.
export function streamModel(cli: Cli, value: unknown): string | undefined {
  const event = object(value)
  if (cli === 'claude') {
    if (event.type === 'system' && event.subtype === 'init') return name(event.model)
    if (event.type === 'assistant') return name(object(event.message).model)
    if (event.type === 'stream_event' && object(event.event).type === 'message_start')
      return name(object(object(event.event).message).model)
  }
  if (cli === 'gemini') {
    if (event.type === 'init') return name(event.model)
    if (event.type === 'result') {
      const models = object(object(event.stats).models)
      const primary = Object.entries(models).sort(
        (a, b) => Number(object(b[1]).output_tokens ?? 0) - Number(object(a[1]).output_tokens ?? 0)
      )
      return name(primary[0]?.[0])
    }
  }
  if (cli === 'grok' && ['init', 'start', 'end', 'session'].includes(String(event.type)))
    return name(event.model) ?? name(object(event.data).model)
  if (cli === 'codex' && event.type === 'turn_context') return name(object(event.payload).model)
  return undefined
}

async function codexRollout(sessionId: string, root: string): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined
  const directory = join(root, 'sessions')
  const files = await readdir(directory, { recursive: true })
  const file = files.find((f) => f.endsWith(`-${sessionId}.jsonl`))
  return file && join(directory, file)
}

// The thread's running token total so far, from its last token_count event.
export async function codexThreadUsage(
  sessionId: string,
  root = process.env.CODEX_HOME || join(homedir(), '.codex')
): Promise<Usage | undefined> {
  try {
    const file = await codexRollout(sessionId, root)
    if (!file) return undefined
    const last = (await readFile(file, 'utf8'))
      .split('\n')
      .findLast((l) => l.includes('"token_count"'))
    return last ? readUsage(JSON.parse(last).payload?.info?.total_token_usage) : undefined
  } catch {
    return undefined
  }
}

// Codex's exec JSON omits its model. Its own rollout records the resolved model for
// each turn. Match the exact thread UUID, including on resume; never infer from a
// different conversation or today's configured default.
export async function codexSessionModel(
  sessionId: string,
  root = process.env.CODEX_HOME || join(homedir(), '.codex')
): Promise<string | undefined> {
  try {
    const file = await codexRollout(sessionId, root)
    if (!file) return undefined
    const input = createReadStream(file, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    let model: string | undefined
    try {
      for await (const line of lines) {
        if (!line.includes('"turn_context"')) continue
        try {
          model = streamModel('codex', JSON.parse(line)) ?? model
        } catch {
          /* partial line */
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    return model
  } catch {
    return undefined
  }
}
