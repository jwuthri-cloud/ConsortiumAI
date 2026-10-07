export type Cli = 'claude' | 'codex' | 'gemini' | 'grok'

export const CLI_META: Record<Cli, { name: string; color: string }> = {
  claude: { name: 'Claude Code', color: '#E08A66' },
  codex: { name: 'Codex', color: '#43C79A' },
  gemini: { name: 'Gemini CLI', color: '#7F93FF' },
  grok: { name: 'Grok Build', color: '#C9D0DC' }
}

export type PersonaId =
  'strategist' | 'engineer' | 'researcher' | 'designer' | 'skeptic' | 'customer'

export type Member = { id: string; cli: Cli; model?: string; persona: PersonaId }

export type Brief = {
  task: string
  projectPath?: string
  members: Member[]
  chairId: string
  maxTurns: number // budget across all members; the last cycle is always final statements
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
}

export type DebateEvent = { sessionId: string } & (
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
)

export type SessionSummary = {
  id: string
  createdAt: string
  task: string
  status: Session['status']
}

// What the preload exposes as window.api
export type Api = {
  start(brief: Brief, sessionId: string): Promise<void>
  stop(): Promise<void>
  interject(text: string): Promise<void>
  pickFolder(): Promise<string | null>
  reveal(path: string): Promise<void>
  detect(): Promise<Partial<Record<Cli, string>>>
  check(cli: Cli): Promise<{ ok: boolean; message: string }>
  models(cli: Cli): Promise<string[]>
  listSessions(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | null>
  onEvent(cb: (e: DebateEvent) => void): () => void
}
