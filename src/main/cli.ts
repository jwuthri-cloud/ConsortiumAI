import { streamActivity } from './activity'
import { tidy, traceParser } from './trace'
import { promisify } from 'node:util'
import { streamModel, codexSessionModel, codexThreadUsage } from './modelMetadata'
import { minus, priced, readUsage, type Usage } from '../shared/usage'
import { modelName } from '../shared/models'
import { spawn, execSync, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir, homedir } from 'node:os'
import { mkdirSync, accessSync, readdirSync, readFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { ActivityKind, ApiProvider, Cli, TraceStep } from '../shared/types'

// Think-only runs (no project attached) get an empty directory, so a CLI that still has read tools finds nothing to read.
function emptyDir(): string {
  const d = join(tmpdir(), 'consortium-empty')
  mkdirSync(d, { recursive: true })
  return d
}

export type RunArgs = {
  prompt: string
  model?: string
  cwd?: string
  dirs?: string[] // extra read-only folders (attachments); codex's read-only sandbox and grok read them by absolute path
  resume?: string
  costBefore?: number // claude: the resumed session's last running cost (see costTotal)
}
export type RunResult = {
  text: string
  sessionId?: string
  costUsd?: number // this run only
  costTotal?: number // claude: the session's running cost, which Claude Code reports instead of the run's
  model?: string
  usage?: Usage // this run only, priced
}

type Ev =
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; text?: string; sessionId?: string; costUsd?: number; usage?: Usage }
  | { type: 'error'; message: string }
  | null

// One entry per CLI: how to build the argv and how to read one JSONL line.
// No project attached (cwd undefined) = think-only, all tools off. Project attached = read-only tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ADAPTERS: Record<Spawned, { args(a: RunArgs): string[]; parse(l: any): Ev }> = {
  claude: {
    args: ({ prompt, model, cwd, dirs, resume }) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      ...(cwd ? ['--tools', 'Read,Glob,Grep', '--max-turns', '25'] : ['--tools', '']),
      ...(dirs?.length ? ['--add-dir', ...dirs] : []),
      ...(model ? ['--model', model] : []),
      ...(resume ? ['--resume', resume] : [])
    ],
    parse: (l) => {
      if (l.type === 'system' && l.subtype === 'init')
        return { type: 'session', sessionId: l.session_id }
      if (l.type === 'stream_event' && l.event?.delta?.type === 'text_delta')
        return { type: 'delta', text: l.event.delta.text }
      if (l.type === 'result')
        return l.is_error
          ? { type: 'error', message: String(l.result || l.subtype || 'claude failed') }
          : { type: 'done', text: l.result, costUsd: l.total_cost_usd, usage: readUsage(l.usage) }
      return null
    }
  },
  codex: {
    // the reasoning summary feeds the Trace panel (codex shares none by default)
    args: ({ prompt, model, cwd, resume }) => [
      '-c',
      'model_reasoning_summary="detailed"',
      ...(resume
        ? [
            'exec',
            'resume',
            resume,
            prompt,
            '--json',
            '--skip-git-repo-check',
            ...(model ? ['-m', model] : [])
          ]
        : [
            'exec',
            prompt,
            '--json',
            '-s',
            'read-only',
            '--skip-git-repo-check',
            '-C',
            cwd ?? emptyDir(),
            ...(model ? ['-m', model] : [])
          ])
    ],
    parse: (l) => {
      if (l.type === 'thread.started') return { type: 'session', sessionId: l.thread_id }
      if (l.type === 'item.completed' && l.item?.type === 'agent_message')
        return { type: 'delta', text: l.item.text + '\n\n' }
      // a resumed thread reports its running total; runMember subtracts what came before
      if (l.type === 'turn.completed') return { type: 'done', usage: readUsage(l.usage) }
      if (l.type === 'turn.failed' || l.type === 'error')
        return { type: 'error', message: l.error?.message ?? l.message ?? 'codex failed' }
      return null
    }
  },
  grok: {
    args: ({ prompt, model, cwd, resume }) => [
      '-p',
      prompt,
      '--output-format',
      'streaming-json',
      '--permission-mode',
      'plan',
      '--disable-web-search',
      '--no-subagents',
      ...(cwd ? ['--cwd', cwd, '--max-turns', '25'] : ['--tools', '']),
      ...(model ? ['-m', model] : []),
      ...(resume ? ['-r', resume] : [])
    ],
    parse: (l) => {
      if (l.type === 'text') return { type: 'delta', text: String(l.data ?? '') }
      if (l.type === 'end')
        return {
          type: 'done',
          sessionId: l.sessionId,
          costUsd: l.total_cost_usd,
          usage: readUsage(l.usage) // ponytail: grok's field names unverified
        }
      if (l.type === 'error') return { type: 'error', message: l.message ?? 'grok failed' }
      return null
    }
  },
  gemini: {
    // --skip-trust: headless runs refuse untrusted folders, and we only ever run in the project or an empty dir
    args: ({ prompt, model, cwd, dirs, resume }) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--skip-trust',
      ...[cwd, ...(dirs ?? [])].filter(Boolean).flatMap((d) => ['--include-directories', d!]),
      ...(model ? ['-m', model] : []),
      ...(resume ? ['--resume', resume] : [])
    ],
    parse: (l) => {
      if (l.type === 'init') return { type: 'session', sessionId: l.session_id }
      if (l.type === 'message' && l.role === 'assistant')
        return l.delta === false
          ? { type: 'done', text: String(l.content ?? '') } // a whole message replaces the chunks
          : { type: 'delta', text: String(l.content ?? '') }
      if (l.type === 'result')
        return l.error || (l.status && l.status !== 'success')
          ? { type: 'error', message: String(l.error?.message ?? l.error ?? l.status) }
          : { type: 'done', text: l.response, usage: readUsage(l.stats) } // ponytail: unverified, gemini isn't signed in here
      if (l.type === 'error')
        return { type: 'error', message: String(l.message ?? JSON.stringify(l)) }
      return null
    }
  }
}

type Spawned = Exclude<Cli, 'harness'> // the harness runs in-process (harness.ts)
const CLIS: Spawned[] = ['claude', 'codex', 'gemini', 'grok']

function isExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Where the CLIs usually live when the app is launched from Finder and PATH is bare:
// curl installers, nvm/bun/volta globals, Homebrew.
function knownDirs(): string[] {
  const h = homedir()
  const nvm = join(h, '.nvm', 'versions', 'node')
  let nvmBins: string[] = []
  try {
    nvmBins = readdirSync(nvm)
      .sort()
      .reverse()
      .map((v) => join(nvm, v, 'bin'))
  } catch {
    /* no nvm */
  }
  return [
    join(h, '.local', 'bin'),
    join(h, '.claude', 'local'),
    join(h, '.grok', 'bin'),
    join(h, '.bun', 'bin'),
    join(h, '.volta', 'bin'),
    ...nvmBins,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin', // the ChatGPT app keeps its own, often newer, codex
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
}

function version(bin: string): number[] {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return (out.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
  } catch {
    return []
  }
}
const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1)
  return false
}

let bins: Partial<Record<Cli, string>> | null = null
export function detectBins(): Partial<Record<Cli, string>> {
  if (bins) return bins
  const found: Partial<Record<Cli, string>> = {}
  const dirs = [
    ...new Set([...(process.env.PATH ?? '').split(':').filter(Boolean), ...knownDirs()])
  ]
  for (const cli of CLIS) {
    // several installs of the same CLI is common (nvm versions, app bundles); a stale one gets
    // rejected by the backend for new models, so take the newest
    const hits = [...new Set(dirs.map((d) => join(d, cli)).filter(isExec))]
    if (hits.length === 1) found[cli] = hits[0]
    else if (hits.length > 1) {
      let best = hits[0]
      let bestV = version(best)
      for (const h of hits.slice(1)) {
        const v = version(h)
        if (newer(v, bestV)) [best, bestV] = [h, v]
      }
      found[cli] = best
    }
  }
  // ponytail: last resort for exotic setups — an interactive login shell, errors ignored
  if (Object.keys(found).length < CLIS.length) {
    try {
      const out = execSync(
        `/bin/zsh -lic "${CLIS.map((c) => `command -v ${c}`).join('; ')}; true"`,
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\/.*\/(claude|codex|gemini|grok))$/)
        if (m && !found[m[2] as Cli]) found[m[2] as Cli] = m[1]
      }
    } catch {
      /* bare names then; spawn reports ENOENT */
    }
  }
  bins = { ...found, harness: 'built-in' }
  return bins
}

// Model suggestions per seat. The CLI is the authority where it can list (grok); otherwise
// OpenRouter's public catalogue, converted to the ids the CLIs use. Free text still wins.
const ALIASES: Record<Cli, string[]> = {
  claude: ['opus', 'sonnet', 'fable', 'haiku'],
  codex: [],
  gemini: ['auto', 'pro', 'flash'],
  grok: [],
  harness: []
}
const OR_PREFIX: Record<Cli, string> = {
  claude: 'anthropic/',
  codex: 'openai/',
  gemini: 'google/',
  grok: 'x-ai/',
  harness: ''
}
const NOT_CHAT =
  /image|audio|tts|realtime|transcribe|embedding|moderation|dall-e|banana|whisper|sora|veo|search-preview/
type Listing = {
  id: string
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string }
}
let openrouter: Promise<Listing[]> | null = null
function openrouterCatalog(): Promise<Listing[]> {
  openrouter ??= fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(6000) })
    .then((r) => r.json() as Promise<{ data: Listing[] }>)
    .then((j) => j.data)
    .catch(() => {
      openrouter = null
      return []
    })
  return openrouter
}

export type Price = { prompt: number; completion: number; cacheRead?: number } // $ per token
const norm = (id: string): string => id.toLowerCase().replace(/\./g, '-')
// List price of an OpenRouter id. Direct-provider ids match too: claude-opus-5-5 ≈ claude-opus-5.5.
export async function openrouterPrice(id: string): Promise<Price | undefined> {
  const p = (await openrouterCatalog()).find((m) => norm(m.id) === norm(id))?.pricing
  const [prompt, completion, cacheRead] = [p?.prompt, p?.completion, p?.input_cache_read].map(
    Number
  )
  // missing = NaN; variable-price routers (openrouter/auto) say -1
  if (!(prompt >= 0 && completion >= 0)) return undefined
  return { prompt, completion, cacheRead: cacheRead >= 0 ? cacheRead : undefined }
}

// An OpenRouter id as the CLI (or that vendor's own API) names it; undefined = not one of its models
function asCli(cli: Spawned, id: string): string | undefined {
  if (!id.startsWith(OR_PREFIX[cli]) || id.includes(':') || NOT_CHAT.test(id)) return undefined
  let name = id.slice(OR_PREFIX[cli].length)
  if (cli === 'claude') name = name.replace(/\./g, '-') // anthropic/claude-opus-5.5 → claude-opus-5-5
  if (cli === 'codex' && !/gpt|codex|^o\d/.test(name)) return undefined
  if (cli === 'gemini' && !name.startsWith('gemini')) return undefined
  return name
}
// direct API keys use the same model ids as the vendor's CLI
const VENDOR_CLI: [ApiProvider, Spawned][] = [
  ['anthropic', 'claude'],
  ['openai', 'codex'],
  ['google', 'gemini'],
  ['xai', 'grok']
]

export async function listModels(cli: Cli): Promise<string[]> {
  if (cli === 'harness') {
    const all = (await openrouterCatalog()).map((m) => m.id)
    return [
      ...all
        .filter((id) => !id.includes(':') && !NOT_CHAT.test(id))
        .map((id) => `openrouter:${id}`),
      ...VENDOR_CLI.flatMap(([p, c]) =>
        all.flatMap((id) => asCli(c, id) ?? []).map((n) => `${p}:${n}`)
      )
    ]
  }
  const ids: string[] = [...ALIASES[cli]]
  // What the account can actually use beats any catalogue: grok lists it, codex caches it.
  if (cli === 'grok') {
    try {
      const out = execSync(`"${detectBins().grok ?? 'grok'}" models`, {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*\*\s*(\S+)/)
        if (m) ids.push(m[1])
      }
      if (ids.length) return ids
    } catch {
      /* fall through to OpenRouter */
    }
  }
  if (cli === 'codex') {
    try {
      const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'))
      const models: { slug: string; visibility?: string }[] = Array.isArray(cache)
        ? cache
        : cache.models
      for (const m of models) if (m.slug && m.visibility !== 'hide') ids.push(m.slug)
      if (ids.length) return ids
    } catch {
      /* no cache yet: OpenRouter below, and "check" will tell */
    }
  }
  for (const { id } of await openrouterCatalog()) {
    const name = asCli(cli, id)
    if (name && !ids.includes(name)) ids.push(name)
  }
  return ids
}

// CLIs wrap API errors in JSON (sometimes JSON inside JSON); show the innermost message.
export function humanError(raw: string): string {
  let s = raw.trim()
  for (let i = 0; i < 3; i++) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) break
    try {
      const o = JSON.parse(s.slice(a, b + 1))
      const msg = o?.error?.message ?? o?.message ?? o?.error
      if (typeof msg !== 'string') break
      s = msg.trim()
    } catch {
      break
    }
  }
  return s.replace(/\s+/g, ' ').slice(0, 400)
}

const procs = new Map<string, ChildProcess>()
const aborts = new Map<string, AbortController>() // in-process runs (the harness)
export function track(key: string, c: AbortController): () => void {
  aborts.set(key, c)
  return () => {
    if (aborts.get(key) === c) aborts.delete(key)
  }
}

function kill(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export function killRun(key: string): void {
  const child = procs.get(key)
  if (child) kill(child)
  aborts.get(key)?.abort()
}

export function killAll(): void {
  for (const c of procs.values()) kill(c)
  procs.clear()
  for (const c of aborts.values()) c.abort()
  aborts.clear()
}

export async function runMember(
  cli: Cli,
  a: RunArgs,
  onDelta: (t: string) => void,
  key: string,
  onModel: (model: string) => void = () => {},
  onActivity: (kind: ActivityKind) => void = () => {},
  onTrace: (step: TraceStep) => void = () => {}
): Promise<RunResult> {
  if (cli === 'harness')
    return (await import('./harness')).runHarness(a, onDelta, key, onModel, onActivity, onTrace)
  const bin = detectBins()[cli] ?? cli
  const trace = traceParser(cli)
  let model: string | undefined
  let finished = false
  let lastActivity: ActivityKind | undefined
  let activityAt = 0
  const reportActivity = (kind: ActivityKind | undefined): void => {
    const now = Date.now()
    if (kind && (kind !== lastActivity || now - activityAt >= 1000)) {
      lastActivity = kind
      activityAt = now
      onActivity(kind)
    }
  }
  const reportModel = (value: string | undefined): void => {
    if (!finished && value && value !== model) {
      model = value
      onModel(value)
    }
  }
  // Grok exposes the selected default through its own model catalogue.
  // Start the process immediately; a failed lookup must never prevent a meeting.
  const defaultLookup =
    cli === 'grok' && !a.model
      ? promisify(execFile)(bin, ['models'], {
          timeout: 8000,
          env: { ...process.env, NO_COLOR: '1' }
        })
          .then(({ stdout }) => modelName(stdout.match(/Default model:\s*(\S+)/)?.[1]))
          .catch(() => undefined)
      : Promise.resolve(undefined)
  // read before the resume appends to the same rollout
  const before = cli === 'codex' && a.resume ? await codexThreadUsage(a.resume) : undefined
  const child = spawn(bin, ADAPTERS[cli].args(a), {
    // gemini always starts in the empty dir: it auto-loads any .env in its cwd (stale GEMINI_API_KEY → "API key not valid")
    // and sees the project through --include-directories instead
    cwd: cli === 'gemini' ? emptyDir() : (a.cwd ?? emptyDir()),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' }
  })
  procs.set(key, child)
  let text = ''
  let final: string | undefined
  let sessionId: string | undefined
  let modelLookup: Promise<void> | undefined
  const lookupModel = (): Promise<void> => {
    if (cli !== 'codex' || !sessionId) return Promise.resolve()
    modelLookup ??= codexSessionModel(sessionId)
      .then(reportModel)
      .finally(() => {
        modelLookup = undefined
      })
    return modelLookup
  }
  const modelTimer = setInterval(() => {
    if (!model) void lookupModel()
  }, 1500)
  void defaultLookup.then((value) => {
    if (!model) reportModel(value)
  })
  let costUsd: number | undefined
  let usage: Usage | undefined
  let errMsg: string | undefined
  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000)
  })
  const closed = new Promise<number | null>((res) => child.on('close', res))
  const spawnErr = new Promise<never>((_, rej) => child.on('error', rej))
  spawnErr.catch(() => {})
  const timer = setTimeout(() => kill(child), 20 * 60_000)
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      let ev: Ev
      try {
        const raw = JSON.parse(line)
        reportModel(streamModel(cli, raw))
        reportActivity(streamActivity(cli, raw))
        for (const step of trace(raw)) onTrace(tidy(step, [a.cwd, ...(a.dirs ?? [])]))
        ev = ADAPTERS[cli].parse(raw)
      } catch {
        continue
      }
      if (!ev) continue
      if (ev.type === 'session') sessionId = ev.sessionId
      else if (ev.type === 'delta') {
        text += ev.text
        onDelta(ev.text)
      } else if (ev.type === 'done') {
        final = ev.text
        costUsd = ev.costUsd ?? costUsd
        usage = ev.usage ?? usage
        if (ev.sessionId) sessionId = ev.sessionId
      } else errMsg = ev.message
    }
    const code = await Promise.race([closed, spawnErr])
    const out = (final ?? text).trim()
    const tail = stderr
      .split('\n')
      .filter((s) => s.trim() && !/ERROR rmcp|Reading additional input/.test(s))
      .slice(-3)
      .join(' ')
      .trim()
    if (errMsg) throw new Error(humanError(errMsg))
    if (out.startsWith('[API Error')) throw new Error(humanError(out)) // gemini reports API failures as prose
    if (!out) throw new Error(humanError(tail) || `${cli} exited with code ${code} and no output`)
    if (code !== 0 && !final) throw new Error(tail || `${cli} exited with code ${code}`)
    await lookupModel()
    if (!model) reportModel(await defaultLookup)
    // Claude Code reports a resumed session's running cost; this run is the difference.
    // Claude Code's total_cost_usd is cumulative for a resumed session (its token counts are per run)
    const costTotal = cli === 'claude' ? costUsd : undefined
    if (costTotal !== undefined)
      costUsd = Math.max(0, costTotal - (a.resume ? (a.costBefore ?? 0) : 0))
    const spent = usage && priced({ ...minus(usage, before), costUsd }, model)
    return { text: out, sessionId, costUsd, costTotal, model, usage: spent }
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${cli} is not installed (or not on PATH)`)
    throw e
  } finally {
    finished = true
    clearTimeout(timer)
    clearInterval(modelTimer)
    procs.delete(key)
  }
}

export async function checkCli(
  cli: Cli,
  model?: string
): Promise<{ ok: boolean; message: string; model?: string }> {
  const key = `check:${cli}:${model ?? ''}`
  const t = setTimeout(() => killRun(key), 120_000)
  try {
    const r = await runMember(
      cli,
      {
        prompt: 'Reply with the single word OK and nothing else.',
        model: model?.trim() || undefined
      },
      () => {},
      key
    )
    return { ok: true, message: r.text.slice(0, 80), model: r.model }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
  }
}
