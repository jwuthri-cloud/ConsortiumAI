import type { BoardVisual } from './boardVisuals'
export const WHITEBOARD_MODEL = 'gpt-6.1-sol'
export const BOARD_COLUMNS = ['agreed', 'disputed', 'questions', 'actions'] as const
export type BoardColumn = (typeof BOARD_COLUMNS)[number]
export type BoardNote = { id: string; text: string; sources: number[] }
export type Whiteboard = {
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
}
export type HostMessage = HostInput & {
  status: 'queued' | 'delivered'
  deliveredTo?: string
  turn?: number
}
