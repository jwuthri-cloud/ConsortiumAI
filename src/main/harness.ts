import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CompositeBackend, StateBackend, createDeepAgent } from 'deepagents'
import { ChatOpenAI } from '@langchain/openai'
import {
  AIMessageChunk,
  isAIMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type UsageMetadata
} from '@langchain/core/messages'
import type { LLMResult } from '@langchain/core/outputs'
import { API_PROVIDERS, splitModel, type ActivityKind, type TraceStep } from '../shared/types'
import { priced, sumUsage, type Usage } from '../shared/usage'
import { getKey } from './keys'
import { dataDir } from './paths'
import { tidy, toolDetail } from './trace'
import { ReadOnlyFolder, fetchTool, gitTool, searchTool } from './agentTools'
import { humanError, openrouterPrice, track, type Price, type RunArgs, type RunResult } from './cli'

// The Deep-agent seat (id "harness"): a LangChain Deep Agent running in-process on an API key,
// instead of a spawned coding-agent CLI. Planning, subagents, read-only files and git, the web.

export function toolActivity(name = ''): ActivityKind {
  if (name === 'read_file' || name === 'ls' || name === 'git' || name === 'fetch_url')
    return 'reading'
  if (name === 'glob' || name === 'grep' || name === 'web_search') return 'searching'
  if (name === 'write_todos') return 'thinking'
  return 'tool'
}

// What the agent is told about its setup; the meeting's own prompt says what to do.
export function setupPrompt(mounts: string[], web: boolean, today = new Date()): string {
  return [
    `Today is ${today.toDateString()}.`,
    mounts.length
      ? `You can read these folders by their absolute paths, read-only: ${mounts.join(', ')}. The git tool reads the project's history (log, blame, show, diff).`
      : 'There are no files to read.',
    web
      ? 'You have internet access: web_search finds pages, fetch_url reads one. Use it when a claim depends on current facts or on something outside the project, and say which sources you relied on by name, without their URLs.'
      : 'fetch_url reads a public web page; web search needs an OpenRouter key, which is not set.',
    'Secrets (.env files, private keys, credentials) are blocked; never try to reach them or send project contents to a website.'
  ].join('\n')
}

type Call = { usage_metadata?: UsageMetadata }

// One model call → tokens and list-price cost.
// ponytail: not OpenRouter's own usage.cost: it is $0 on BYOK, and doubled in LangChain's merged message
export function callUsage(c: Call, price?: Price): Usage | undefined {
  const u = c.usage_metadata
  if (!u) return undefined
  const input = u.input_tokens ?? 0
  const cached = u.input_token_details?.cache_read ?? 0
  const output = u.output_tokens ?? 0
  if (!price) return { input, cached, output }
  const costUsd =
    (input - cached) * price.prompt +
    cached * (price.cacheRead ?? price.prompt) +
    output * price.completion
  return { input, cached, output, costUsd, estimated: true }
}

// Reasoning text, where the provider shares it: chat-completions `reasoning_content`
// (DeepSeek-style) or the Responses API's summary blocks. OpenRouter's own `reasoning` field
// isn't surfaced by LangChain. ponytail: add it when an OpenRouter model's thinking is wanted.
function reasoningOf(msg: AIMessageChunk): string {
  const r = msg.additional_kwargs?.reasoning_content
  const blocks = Array.isArray(msg.content) ? msg.content : []
  return (
    (typeof r === 'string' ? r : '') +
    blocks
      .map((b) => b as { type?: string; reasoning?: unknown })
      .filter((b) => b.type === 'reasoning' && typeof b.reasoning === 'string')
      .map((b) => b.reasoning as string)
      .join('')
  )
}

// ponytail: one JSON file per thread, rewritten each turn; a 40-turn meeting on a small-context model
// relies on Deep Agents' own summarisation to stay inside the window.
const threadFile = (home: string, thread: string): string => join(home, 'harness', `${thread}.json`)

export async function runHarness(
  a: RunArgs,
  onDelta: (t: string) => void,
  key: string,
  onModel: (model: string) => void,
  onActivity: (kind: ActivityKind) => void,
  onTrace: (step: TraceStep) => void = () => {}
): Promise<RunResult> {
  const { provider, model } = splitModel(a.model)
  const p = API_PROVIDERS[provider]
  if (!model)
    throw new Error('Pick a model for the Deep-agent, like openrouter:anthropic/claude-opus-5.5')
  const apiKey = a.apiKey ?? getKey(provider)
  if (!apiKey) throw new Error(`No ${p.name} API key. Paste one in the seat, or set ${p.env}.`)
  onModel(model)
  onActivity('starting')
  const price = openrouterPrice(p.or + model)

  // Each folder is mounted at its real absolute path, so the paths the prompts name work as is.
  const mounts = [a.cwd, ...(a.dirs ?? [])].filter((d): d is string => !!d)
  // web search runs on OpenRouter whatever the seat's provider; a run's own key is an OpenRouter one
  const searchKey = a.apiKey ?? getKey('openrouter')
  const home = a.home ?? dataDir()
  const agent = createDeepAgent({
    // ponytail: every provider through its OpenAI-compatible endpoint; add a native @langchain
    // package when a provider-only knob (Anthropic thinking budget, …) is needed
    model: new ChatOpenAI({
      model,
      apiKey,
      configuration: { baseURL: p.url },
      streamUsage: true,
      useResponsesApi: provider === 'openai', // its reasoning models only take tools there
      // a reasoning summary for the Trace panel; LangChain drops it for non-reasoning models
      reasoning: provider === 'openai' ? { summary: 'auto' } : undefined
    }),
    backend: mounts.length
      ? new CompositeBackend(
          new StateBackend(),
          Object.fromEntries(
            mounts.map((d) => [
              d.replace(/\/?$/, '/'),
              new ReadOnlyFolder({ rootDir: d, virtualMode: true })
            ])
          )
        )
      : undefined,
    permissions: [{ operations: ['write'], paths: ['/**'], mode: 'deny' }],
    tools: [
      ...(a.cwd ? [gitTool(a.cwd)] : []),
      fetchTool,
      ...(searchKey ? [searchTool(searchKey)] : [])
    ],
    systemPrompt: setupPrompt(mounts, !!searchKey)
  })

  const thread = a.resume && /^[\w-]+$/.test(a.resume) ? a.resume : randomUUID()
  let history: BaseMessage[] = []
  if (a.resume)
    try {
      history = mapStoredMessagesToChatMessages(
        JSON.parse(readFileSync(threadFile(home, thread), 'utf8'))
      )
    } catch {
      /* memory file gone: carry on from this turn */
    }

  const ctrl = new AbortController()
  const untrack = track(key, ctrl)
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(20 * 60_000)])
  const calls: Call[] = []
  let last: ActivityKind = 'starting'
  const activity = (k: ActivityKind): void => {
    if (k !== last) onActivity((last = k))
  }
  let text = ''
  let messages: BaseMessage[] = []
  // reasoning arrives in pieces; it becomes one Trace step when the model turns to a tool or its answer
  let reasoning = ''
  const flush = (): void => {
    if (reasoning.trim()) onTrace(tidy({ kind: 'thinking', text: reasoning.trim() }, mounts))
    reasoning = ''
  }
  try {
    const stream = await agent.stream(
      { messages: [...history, { role: 'user', content: a.prompt }] },
      {
        streamMode: ['messages', 'values'],
        subgraphs: true,
        signal,
        callbacks: [
          {
            // every model call, subagents included
            handleLLMEnd: (out: LLMResult) => {
              const msg = (out.generations[0]?.[0] as { message?: Call } | undefined)?.message
              if (msg) calls.push(msg)
            },
            // (tool, input, runId, parentRunId, tags, metadata, runName)
            handleToolStart: (...args: unknown[]) => {
              const name = String(args[6] ?? 'tool')
              flush()
              activity(toolActivity(name))
              onTrace(tidy({ kind: 'tool', name, detail: toolDetail(args[1]) }, mounts))
            }
          }
        ]
      }
    )
    for await (const [ns, mode, chunk] of stream as AsyncIterable<[string[], string, unknown]>) {
      if (mode === 'values') {
        if (!ns.length) messages = (chunk as { messages: BaseMessage[] }).messages
      } else if (!ns.some((s) => s.startsWith('tools:'))) {
        // the main agent's tokens come namespaced by its model call; tools:… is a subagent,
        // whose work reaches the main agent as a tool result
        const [msg] = chunk as [BaseMessage]
        if (!AIMessageChunk.isInstance(msg)) continue
        reasoning += reasoningOf(msg)
        if (msg.text) {
          flush()
          activity('responding')
          text += msg.text
          onDelta(msg.text)
        }
      }
    }
    flush()
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error('Deep-agent stopped')
    if (signal.aborted) throw new Error('Deep-agent timed out after 20 minutes')
    throw new Error(humanError(e instanceof Error ? e.message : String(e)) || 'Deep-agent failed')
  } finally {
    untrack()
  }

  const answer = messages.at(-1)
  const out = (answer && isAIMessage(answer) && answer.text) || text
  if (!out.trim()) throw new Error(`${model} returned no answer`)
  if (messages.length) {
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(
      threadFile(home, thread),
      JSON.stringify(mapChatMessagesToStoredMessages(messages))
    )
  }
  const known = await price
  const total = sumUsage(calls.map((c) => callUsage(c, known)))
  const usage = total && priced(total, model) // no catalogue price: the regex list prices, if any
  return { text: out.trim(), sessionId: thread, model, costUsd: usage?.costUsd, usage }
}
