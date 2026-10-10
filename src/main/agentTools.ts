import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import {
  FilesystemBackend,
  type EditResult,
  type GrepResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult
} from 'deepagents'

// The Deep-agent's tools beyond Deep Agents' own file tools: read-only git, web search, web pages.
// With internet access, a page could talk the agent into sending a secret out, so secrets are
// unreadable and local addresses unreachable.

const clip = (s: string, max = 30_000): string =>
  s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters cut)` : s

// ---------- secrets ----------

// .env (not .env.example), credentials, private keys
export const SECRET =
  /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa|dsa)[^/]*|[^/]*\.(pem|key|p12|pfx))$/i
const hidden = (p: string): string => `${p} may hold secrets, so it is not readable here.`

// The attached folders: read-only, secrets left out of reads and searches.
export class ReadOnlyFolder extends FilesystemBackend {
  async read(p: string, offset?: number, limit?: number): Promise<ReadResult> {
    return SECRET.test(p) ? { error: hidden(p) } : super.read(p, offset, limit)
  }
  async readRaw(p: string): Promise<ReadRawResult> {
    return SECRET.test(p) ? { error: hidden(p) } : super.readRaw(p)
  }
  async grep(
    pattern: string,
    dirPath?: string,
    glob?: string | null,
    maxCount?: number | null
  ): Promise<GrepResult> {
    const r = await super.grep(pattern, dirPath, glob, maxCount)
    return r.matches ? { ...r, matches: r.matches.filter((m) => !SECRET.test(m.path)) } : r
  }
  async write(p: string): Promise<WriteResult> {
    return { error: `${p}: the attached folders are read-only` }
  }
  async edit(p: string): Promise<EditResult> {
    return { error: `${p}: the attached folders are read-only` }
  }
}

// ---------- git ----------

const GIT_READS = [
  'log',
  'show',
  'diff',
  'blame',
  'status',
  'shortlog',
  'ls-files',
  'grep',
  'rev-parse',
  'describe',
  'for-each-ref',
  'branch',
  'tag'
]
// options that write a file, read one from outside the repo, run a program, or reach a secret
const NEVER =
  /^(--output|--no-index|--ext-diff|--open-files-in-pager|-O|--exec|--upload-pack|--contents|--untracked|--no-exclude-standard|--edit-description|--set-upstream|--unset-upstream|--file$|-f$)/
const EDITS_REF = /^(-[dDmMcCfu]|--(delete|move|copy|force))/

// The argv for a read-only git command, or the reason it is refused.
export function gitArgs(args: string[]): string[] | string {
  const [sub, ...rest] = args
  if (!sub || !GIT_READS.includes(sub))
    return `Only these git commands are allowed: ${GIT_READS.join(', ')}.`
  const bad = rest.find((a) => NEVER.test(a))
  if (bad) return `${bad} is not allowed: git is read-only here.`
  if (sub === 'branch' || sub === 'tag') {
    // without a name, branch and tag can only list
    const off = rest.find((a) => !a.startsWith('-') || EDITS_REF.test(a))
    if (off) return `git ${sub} can only list here (${off} is not allowed).`
  }
  const noPrograms = ['diff', 'show', 'log'].includes(sub)
    ? ['--no-ext-diff', '--no-textconv']
    : sub === 'blame'
      ? ['--no-textconv']
      : []
  // core.fsmonitor would run a configured hook on status
  return ['--no-pager', '-c', 'core.fsmonitor=false', sub, ...noPrograms, ...rest]
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const argv = gitArgs(args)
  if (typeof argv === 'string') return argv
  try {
    const { stdout, stderr } = await promisify(execFile)('git', argv, {
      cwd,
      timeout: 20_000,
      maxBuffer: 16 << 20,
      // GIT_OPTIONAL_LOCKS=0: status won't refresh (write) the index
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })
    return clip(stdout || stderr || '(no output)')
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return clip(`git failed: ${(err.stderr || err.message || '').trim()}`)
  }
}

export const gitTool = (cwd: string): StructuredToolInterface =>
  tool(async ({ args }: { args: string[] }) => runGit(cwd, args), {
    name: 'git',
    description: `Run a read-only git command in the attached project to read its history: who changed what, when and why. Pass the arguments without "git", e.g. ["log","--oneline","-20"], ["log","-p","-3","--","src/a.ts"], ["blame","-L","40,60","src/a.ts"], ["show","HEAD~2","--stat"]. Allowed: ${GIT_READS.join(', ')} (branch and tag only list).`,
    schema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'git arguments, without "git"'
        }
      },
      required: ['args']
    }
  })

// ---------- web ----------

const PRIVATE = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3]
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6')

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '')
  return isIP(v4) === 4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(ip, 'ipv6')
}

// ponytail: checked at lookup time; a DNS answer that changes before the fetch (rebinding) slips by
async function publicUrl(raw: string): Promise<URL> {
  const u = new URL(raw)
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('Only http and https links can be read.')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (!ips.length || ips.some(isPrivateIp))
    throw new Error(`${u.hostname} is a local or private address, which is off limits.`)
  return u
}

export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readCapped(r: Response, max = 3_000_000): Promise<string> {
  const reader = r.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let n = 0
  while (n < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    n += value.length
  }
  void reader.cancel().catch(() => {})
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchPage(raw: string): Promise<string> {
  try {
    let url = await publicUrl(raw)
    for (let hop = 0; hop < 5; hop++) {
      // redirects one hop at a time, so each one is checked for a private address too
      const r = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh) ConsortiumAI-DeepAgent/1.0',
          accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5'
        }
      })
      const next = r.headers.get('location')
      if (r.status >= 300 && r.status < 400 && next) {
        url = await publicUrl(new URL(next, url).href)
        continue
      }
      const type = r.headers.get('content-type') ?? ''
      if (!/text|json|xml|javascript/.test(type))
        return `${r.status} ${url.href}\n(${type || 'unknown content type'}; not text, not read)`
      const body = await readCapped(r)
      return clip(`${r.status} ${url.href}\n\n${/html/.test(type) ? htmlText(body) : body}`, 20_000)
    }
    return 'Too many redirects.'
  } catch (e) {
    return `Could not read ${raw}: ${e instanceof Error ? e.message : String(e)}`
  }
}

export const fetchTool = tool(async ({ url }: { url: string }) => fetchPage(url), {
  name: 'fetch_url',
  description:
    'Read a public web page or text file by URL (documentation, an issue, a changelog, an article). Returns its text, cut at 20,000 characters.',
  schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'http or https URL' } },
    required: ['url']
  }
})

// Web search through OpenRouter's web plugin (Exa), on the OpenRouter key: about $0.007 a search.
// ponytail: that cost isn't in the seat's usage; add it when search volume makes it matter.
const SEARCH_MODEL = 'google/gemini-3.5-flash-lite'

type Citation = { url: string; title?: string; content?: string }
export function searchResult(message: {
  content?: string | null
  annotations?: { type?: string; url_citation?: Citation }[]
}): string {
  const seen = new Set<string>()
  const sources = (message.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
    .map((a) => a.url_citation!)
    .filter((c) => !seen.has(c.url) && seen.add(c.url))
  const list = sources.map(
    (s) =>
      `- ${s.title || s.url}: ${s.url}${s.content ? `\n  ${s.content.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`
  )
  return clip(
    [message.content?.trim(), list.length && `Sources:\n${list.join('\n')}`]
      .filter(Boolean)
      .join('\n\n') || 'No results.'
  )
}

export async function webSearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'x-title': 'ConsortiumAI'
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        plugins: [{ id: 'web', engine: 'exa', max_results: 6 }],
        messages: [
          {
            role: 'user',
            content: `Search the web for: ${query}\nSummarize what the results say in a few short bullets, each ending with its source URL. Use only the results.`
          }
        ]
      })
    })
    const j = (await r.json()) as {
      error?: { message?: string }
      choices?: { message?: Parameters<typeof searchResult>[0] }[]
    }
    if (!r.ok) return `Search failed: ${j.error?.message ?? r.status}`
    return searchResult(j.choices?.[0]?.message ?? {})
  } catch (e) {
    return `Search failed: ${e instanceof Error ? e.message : String(e)}`
  }
}

export const searchTool = (key: string): StructuredToolInterface =>
  tool(async ({ query }: { query: string }) => webSearch(query, key), {
    name: 'web_search',
    description:
      'Search the internet. Returns a short summary of the top results with their URLs; read a result in full with fetch_url.',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'what to search for' } },
      required: ['query']
    }
  })
