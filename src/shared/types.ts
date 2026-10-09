import type { Whiteboard, BoardStatus, HostInput, HostMessage } from './whiteboard'
import type { Usage } from './usage'
export type Cli = 'claude' | 'codex' | 'gemini' | 'grok'

export const CLI_META: Record<Cli, { name: string; color: string }> = {
  claude: { name: 'Claude Code', color: '#E08A66' },
  codex: { name: 'Codex', color: '#43C79A' },
  gemini: { name: 'Gemini CLI', color: '#7F93FF' },
  grok: { name: 'Grok Build', color: '#C9D0DC' }
}

export type PersonaId =
  'strategist' | 'engineer' | 'researcher' | 'designer' | 'skeptic' | 'customer'

export type Member = {
  id: string
  cli: Cli
  model?: string
  resolvedModel?: string
  persona: PersonaId
}

export type Brief = {
  task: string
  projectPath?: string
  attachments?: string[] // files the human attached; copied into the session's folder at start
  members: Member[]
  chairId: string
  maxTurns: number // budget across all members; the last cycle is always final statements
  board?: { cli: Cli; model?: string } // who writes the live whiteboard; unset = the chair's CLI and model
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

export type Turn = {
  n: number // 1..maxTurns for members; the current member turn number for human interjections
  speaker: string // member id, or HUMAN
  label: string
  text: string
  vote: Vote | null
  costUsd?: number
  error?: string
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
  check(cli: Cli): Promise<{ ok: boolean; message: string; model?: string }>
  models(cli: Cli): Promise<string[]>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  deleteSession(id: string): Promise<void>
  onEvent(cb: (e: DebateEvent) => void): () => void
}
