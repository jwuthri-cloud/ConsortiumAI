import type { Whiteboard, BoardStatus, HostInput, HostMessage } from './whiteboard'
import type { Usage } from './usage'
export type Cli = 'claude' | 'codex' | 'gemini' | 'grok' | 'harness'

export const CLI_META: Record<Cli, { name: string; color: string }> = {
  claude: { name: 'Claude Code', color: '#E08A66' },
  codex: { name: 'Codex', color: '#43C79A' },
  gemini: { name: 'Gemini CLI', color: '#7F93FF' },
  grok: { name: 'Grok Build', color: '#C9D0DC' },
  harness: { name: 'Harness', color: '#F0A3C4' }
}

// The harness seat's model is "provider:model". Every provider is reached through its
// OpenAI-compatible endpoint; `or` is its prefix in OpenRouter's catalogue (for prices and suggestions).
export type ApiProvider = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'xai'
export type KeySource = 'saved' | 'env' | null // saved = in the keychain; env = an environment variable
export const API_PROVIDERS: Record<
  ApiProvider,
  { name: string; url: string; env: string; or: string }
> = {
  openrouter: {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY',
    or: ''
  },
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1',
    env: 'OPENAI_API_KEY',
    or: 'openai/'
  },
  anthropic: {
    name: 'Anthropic',
    url: 'https://api.anthropic.com/v1',
    env: 'ANTHROPIC_API_KEY',
    or: 'anthropic/'
  },
  google: {
    name: 'Google',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY',
    or: 'google/'
  },
  xai: { name: 'xAI', url: 'https://api.x.ai/v1', env: 'XAI_API_KEY', or: 'x-ai/' }
}

// "openrouter:anthropic/claude-opus-5.5" → provider + the id that provider expects
// A bare id (no known provider) goes to OpenRouter.
export function splitModel(value = ''): { provider: ApiProvider; model: string } {
  const [, p, rest] = value.trim().match(/^([a-z]+):(.*)$/) ?? []
  return p && p in API_PROVIDERS
    ? { provider: p as ApiProvider, model: rest.trim() }
    : { provider: 'openrouter', model: value.trim() }
}

export type PersonaId =
  'strategist' | 'engineer' | 'researcher' | 'designer' | 'skeptic' | 'customer'

export type Member = {
  id: string
  cli: Cli
  model?: string
  resolvedModel?: string
  persona: PersonaId
  voice?: string // an ElevenLabs voice (shared/voices.ts); used when the brief reads turns aloud
}

export type Brief = {
  task: string
  projectPath?: string
  attachments?: string[] // files the human attached; copied into the session's folder at start
  members: Member[]
  chairId: string
  maxTurns: number // budget across all members; the last cycle is always final statements
  board?: { cli: Cli; model?: string } // who writes the live whiteboard; unset = the chair's CLI and model
  voices?: boolean // read each member's answer aloud in its seat's voice (needs an OpenRouter key)
}

export type Vote = {
  position: string
  confidence: number
  agrees_with: string[]
  disagreements: { with: string; on: string }[]
}

export type Shape = {
  converging: { point: string; supporters: string[] }[]
  open: { point: string; sides: string }[]
}

// open = opening statements · debate = free discussion · converge = settle the open points · decide = final statements
export type Phase = 'open' | 'debate' | 'converge' | 'decide'

export const HUMAN = 'human'

// What a member did behind its answer, shown to the human only: never in another member's prompt.
// thinking without text = the CLI keeps it private and only says how long it thought.
export type TraceStep =
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'thinking'; text?: string; tokens?: number }

export type Turn = {
  n: number // 1..maxTurns for members; the current member turn number for human interjections
  speaker: string // member id, or HUMAN
  label: string
  text: string
  vote: Vote | null
  costUsd?: number
  error?: string
  trace?: TraceStep[]
}

export type Session = {
  version: 2
  id: string
  createdAt: string
  brief: Brief
  labels: Record<string, string>
  turns: Turn[]
  shape: Shape | null
  converged: boolean
  consortium?: { markdown: string; path: string }
  status: 'running' | 'done' | 'stopped' | 'failed'
  whiteboard?: Whiteboard
  hostMessages?: HostMessage[]
  focus?: string
  cliSessions?: Record<string, string | undefined> // member id → CLI session, so a resume keeps each member's memory
  cliCosts?: Record<string, number> // Claude session → its running cost, so a resumed turn counts only itself
  usage?: Record<string, Usage> // member id, 'whiteboard' or 'chair' → tokens and cost so far
}

export type ActivityKind =
  'starting' | 'thinking' | 'reading' | 'searching' | 'tool' | 'reviewing' | 'responding'

export type DebateEvent = { sessionId: string } & (
  | { type: 'whiteboard'; board: Whiteboard }
  | { type: 'board-status'; status: BoardStatus; error?: string }
  | { type: 'host-message'; message: HostMessage }
  | { type: 'concluding' }
  | { type: 'activity'; memberId: string; turn: number; kind: ActivityKind }
  | { type: 'trace'; memberId: string; turn: number; step: TraceStep }
  | { type: 'member-model'; memberId: string; model: string }
  | { type: 'turn-start'; memberId: string; turn: number; phase: Phase }
  | { type: 'delta'; memberId: string; turn: number; text: string } // turn 0 = the chair
  | { type: 'turn-done'; turn: Turn }
  | { type: 'turn-error'; memberId: string; turn: number; message: string }
  | { type: 'human'; turn: Turn }
  | { type: 'shape'; turn: number; shape: Shape | null }
  | { type: 'chair-start'; memberId: string }
  | { type: 'consortium'; markdown: string; path: string }
  | { type: 'stopped' }
  | { type: 'failed'; message: string }
  | { type: 'usage'; usage: Record<string, Usage> }
  // audio for the player: a filler clip (mp3) when a turn starts, then the answer (24 kHz s16le pcm)
  // in order; `last` marks the answer's final piece, which the renderer acks with api.spoken
  | {
      type: 'voice'
      memberId: string
      turn: number
      format: 'mp3' | 'pcm'
      data: Uint8Array
      last: boolean
    }
  | { type: 'voice-error'; message: string }
)

export type SessionSummary = {
  id: string
  createdAt: string
  task: string
  title: string // the chair's title once decided, else the question's first sentence
  outcome?: string // the decision's first sentence, or where an unfinished table was leaning
  projectPath?: string
  team: Pick<Member, 'cli' | 'persona'>[]
  turn: number // last member turn reached
  maxTurns: number
  usage?: Usage // the whole meeting: members, whiteboard and chair
  files?: string[] // names of the files attached to the question
  status: Session['status']
}

// What the preload exposes as window.api
export type Api = {
  start(brief: Brief, sessionId: string): Promise<void>
  stop(): Promise<void>
  resume(sessionId: string): Promise<void> // continue an unfinished session where it stopped
  pause(on: boolean): Promise<void> // takes effect before the next turn
  spoken(sessionId: string, turn: number): Promise<void> // a turn's answer has finished playing
  interject(text: string): Promise<void>
  host(input: HostInput): Promise<void>
  conclude(): Promise<void>
  refreshBoard(): Promise<void>
  pickFolder(): Promise<string | null>
  pickFiles(): Promise<string[]>
  saveFile(name: string, data: ArrayBuffer): Promise<string> // pasted or recorded bytes → a temp file
  pathForFile(file: File): string // a dropped file → its path on disk
  transcribe(path: string): Promise<string> // local Whisper large-v3-turbo
  reveal(path: string): Promise<void>
  detect(): Promise<Partial<Record<Cli, string>>>
  check(cli: Cli, model?: string): Promise<{ ok: boolean; message: string; model?: string }>
  keys(): Promise<Record<ApiProvider, KeySource>> // where each provider's key comes from; never the key
  setKey(provider: ApiProvider, key: string): Promise<void> // empty = forget it
  models(cli: Cli): Promise<string[]>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  onEvent(cb: (e: DebateEvent) => void): () => void
}
