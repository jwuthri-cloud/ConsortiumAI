export type Usage = {
  input: number // every prompt token, cached ones included
  cached: number
  output: number
  costUsd?: number
  estimated?: boolean // priced from PRICES below, not reported by the CLI
}

// $ per million tokens: [input, cached input, output]. Standard-tier API list prices, Oct 2026.
// The CLIs bill your subscription, not these: they show what the meeting would cost on the API.
// Claude Code reports its own cost; everything else is estimated here.
// ponytail: four model families and no long-context tiers; add a row when a new model shows up as "—".
const PRICES: [RegExp, number, number, number][] = [
  [/gpt-6/i, 10, 1, 50],
  [/gpt-5\.6/i, 4, 0.4, 20],
  [/gemini-3(?:\.\d+)?-pro/i, 2, 0.2, 12],
  [/grok-4/i, 2, 0.5, 6] // cached rate assumed
]

const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)

// One CLI usage object → tokens. Anthropic counts cache reads and writes outside input_tokens;
// OpenAI and Gemini count them inside.
export function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const anthropic = 'cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u
  const cached = num(u.cache_read_input_tokens) + num(u.cached_input_tokens) + num(u.cached)
  const input = anthropic
    ? num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
    : num(u.input_tokens)
  const output = num(u.output_tokens)
  return input || output ? { input, cached, output } : undefined
}

// Codex reports a resumed thread's running total; this run is the difference.
export function minus(a: Usage, b?: Usage): Usage {
  if (!b) return a
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    output: Math.max(0, a.output - b.output)
  }
}

export function priced(u: Usage, model?: string): Usage {
  if (u.costUsd !== undefined) return u
  const p = model && PRICES.find(([re]) => re.test(model))
  if (!p) return u
  const [, inp, cache, out] = p
  const costUsd = ((u.input - u.cached) * inp + u.cached * cache + u.output * out) / 1e6
  return { ...u, costUsd, estimated: true }
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    costUsd:
      a.costUsd === undefined && b.costUsd === undefined
        ? undefined
        : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    estimated: a.estimated || b.estimated || undefined
  }
}

export const sumUsage = (all: (Usage | undefined)[]): Usage | undefined =>
  all.reduce<Usage | undefined>((acc, u) => (u ? addUsage(acc, u) : acc), undefined)

export const tokens = (u?: Usage): number => (u ? u.input + u.output : 0)

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(2)}M`
}

export function fmtUsd(u?: Usage): string {
  if (u?.costUsd === undefined) return '—'
  const s = u.costUsd < 0.01 ? '<$0.01' : `$${u.costUsd.toFixed(2)}`
  return u.estimated ? `≈${s}` : s
}
