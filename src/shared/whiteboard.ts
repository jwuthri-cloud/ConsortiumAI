import type { BoardVisual } from './boardVisuals'
export const WHITEBOARD_MODEL = 'gpt-6.1-sol'
// The default whiteboard writer: summarizing needs a fast model, not the chair's.
export const BOARD_WRITER = { cli: 'claude', model: 'claude-haiku-5-5' } as const
export const BOARD_COLUMNS = ['agreed', 'disputed', 'questions', 'actions'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]
export type BoardNote = { id: string; text: string; sources: number[] }
export type Moderation = {
  kind: 'refocus' | 'resolve' | 'clarify'
  message: string
  nextMemberId?: string
  sources: number[]
}
export type Whiteboard = {
  moderation?: Moderation
  visuals?: BoardVisual[]
  recommendation: string
  agreed: BoardNote[]
  disputed: BoardNote[]
  questions: BoardNote[]
  actions: BoardNote[]
  revision: number
  updatedAt: string
  throughTurn: number
  provisional?: boolean
  model: string
}
export type BoardStatus = 'idle' | 'updating' | 'error'
export type HostInput = {
  id: string
  kind: 'thought' | 'ask' | 'focus'
  text: string
  targetId?: string
  boardNote?: { id: string; revision: number; text: string }
}
export type HostMessage = HostInput & {
  recorded?: boolean // human text is already persisted; absent in older queued messages
  status: 'queued' | 'delivered'
  deliveredTo?: string
  turn?: number
}
