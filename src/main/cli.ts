import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir, homedir } from 'node:os'
import { mkdirSync, accessSync, readdirSync, readFileSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Cli } from '../shared/types'

// Think-only runs (no project attached) get an empty directory, so a CLI that still has read tools finds nothing to read.
function emptyDir(): string {
  const d = join(tmpdir(), 'consortium-empty')
  mkdirSync(d, { recursive: true })
  return d
}

export type RunArgs = { prompt: string; model?: string; cwd?: string; resume?: string }
export type RunResult = { text: string; sessionId?: string; costUsd?: number }

type Ev =
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; text?: string; sessionId?: string; costUsd?: number }
  | { type: 'error'; message: string }
  | null

// One entry per CLI: how to build the argv and how to read one JSONL line.
// No project attached (cwd undefined) = think-only, all tools off. Project attached = read-only tools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ADAPTERS: Record<Cli, { args(a: RunArgs): string[]; parse(l: any): Ev }> = {
  claude: {
    args: ({ prompt, model, cwd, resume }) => [
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
          : { type: 'done', text: l.result, costUsd: l.total_cost_usd }
      return null
    }
  },
  codex: {
    args: ({ prompt, model, cwd, resume }) =>
      resume
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
          ],
    parse: (l) => {
      if (l.type === 'thread.started') return { type: 'session', sessionId: l.thread_id }
      if (l.type === 'item.completed' && l.item?.type === 'agent_message')
        return { type: 'delta', text: l.item.text + '\n\n' }
      if (l.type === 'turn.completed') return { type: 'done' }
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
        return { type: 'done', sessionId: l.sessionId, costUsd: l.total_cost_usd }
      if (l.type === 'error') return { type: 'error', message: l.message ?? 'grok failed' }
      return null
    }
  },
  gemini: {
    // --skip-trust: headless runs refuse untrusted folders, and we only ever run in the project or an empty dir
    args: ({ prompt, model, cwd, resume }) => [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--skip-trust',
      ...(cwd ? ['--include-directories', cwd] : []),
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
          : { type: 'done', text: l.response }
      if (l.type === 'error')
        return { type: 'error', message: String(l.message ?? JSON.stringify(l)) }
      return null
    }
  }
}

const CLIS: Cli[] = ['claude', 'codex', 'gemini', 'grok']

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
  bins = found
  return bins
}

// Model suggestions per seat. The CLI is the authority where it can list (grok); otherwise
// OpenRouter's public catalogue, converted to the ids the CLIs use. Free text still wins.
const ALIASES: Record<Cli, string[]> = {
  claude: ['opus', 'sonnet', 'fable', 'haiku'],
  codex: [],
  gemini: ['auto', 'pro', 'flash'],
  grok: []
}
const OR_PREFIX: Record<Cli, string> = {
  claude: 'anthropic/',
  codex: 'openai/',
  gemini: 'google/',
  grok: 'x-ai/'
}
const NOT_CHAT =
  /image|audio|tts|realtime|transcribe|embedding|moderation|dall-e|banana|whisper|sora|veo|search-preview/
let openrouter: Promise<string[]> | null = null
function openrouterIds(): Promise<string[]> {
  openrouter ??= fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(6000) })
    .then((r) => r.json() as Promise<{ data: { id: string }[] }>)
    .then((j) => j.data.map((m) => m.id))
    .catch(() => {
      openrouter = null
      return []
    })
  return openrouter
}

export async function listModels(cli: Cli): Promise<string[]> {
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
  const all = await openrouterIds()
  for (const id of all) {
    if (!id.startsWith(OR_PREFIX[cli]) || id.includes(':') || NOT_CHAT.test(id)) continue
    let name = id.slice(OR_PREFIX[cli].length)
    if (cli === 'claude') name = name.replace(/\./g, '-') // anthropic/claude-opus-5.5 → claude-opus-5-5
    if (cli === 'codex' && !/gpt|codex|^o\d/.test(name)) continue
    if (cli === 'gemini' && !name.startsWith('gemini')) continue
    if (!ids.includes(name)) ids.push(name)
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

function kill(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export function killAll(): void {
  for (const c of procs.values()) kill(c)
  procs.clear()
}

export async function runMember(
  cli: Cli,
  a: RunArgs,
  onDelta: (t: string) => void,
  key: string
): Promise<RunResult> {
  const bin = detectBins()[cli] ?? cli
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
  let costUsd: number | undefined
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
        ev = ADAPTERS[cli].parse(JSON.parse(line))
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
        costUsd = ev.costUsd
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
    return { text: out, sessionId, costUsd }
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${cli} is not installed (or not on PATH)`)
    throw e
  } finally {
    clearTimeout(timer)
    procs.delete(key)
  }
}

export async function checkCli(cli: Cli): Promise<{ ok: boolean; message: string }> {
  const t = setTimeout(() => {
    const c = procs.get(`check:${cli}`)
    if (c) kill(c)
  }, 120_000)
  try {
    const r = await runMember(
      cli,
      { prompt: 'Reply with the single word OK and nothing else.' },
      () => {},
      `check:${cli}`
    )
    return { ok: true, message: r.text.slice(0, 80) }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(t)
  }
}
