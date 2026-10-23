import type { Whiteboard, BoardStatus, HostMessage } from '@shared/whiteboard'
import {
  HUMAN,
  type ActivityKind,
  type Brief,
  type DebateEvent,
  type Phase,
  type Session,
  type Shape,
  type Turn,
  type Vote
} from '@shared/types'
import { makeLabels } from '@shared/personas'
import type { Usage } from '@shared/usage'

export type TurnState = Turn & { status: 'running' | 'done' | 'error'; startedAt?: number }
export type Stage = Phase | 'done' | 'stopped' | 'failed'
export type ActivityState = {
  memberId: string
  turn: number
  kind: ActivityKind
  startedAt: number
  updatedAt: number
}
export type State = {
  focusTurn?: number // member turn to scroll to when the meeting room opens from a citation
  whiteboard?: Whiteboard
  boardStatus: BoardStatus
  boardError?: string
  hostMessages: HostMessage[]
  concluding: boolean
  activity?: ActivityState
  screen: 'convene' | 'chamber' | 'consortium'
  sessionId?: string
  brief?: Brief
  labels: Record<string, string>
  stage: Stage
  turn: number // last member turn started; 0 before the first
  turns: TurnState[]
  speaking?: string // member id currently talking (or the chair)
  shape: Shape | null
  converged: boolean
  chair: { text: string; status: 'idle' | 'running' | 'done' }
  consortium?: { markdown: string; path: string }
  revealed: boolean // the consortium screen has been shown once; the chamber no longer auto-advances
  error?: string
  usage: Record<string, Usage> // member id, 'whiteboard' or 'chair'
  voiceError?: string // the last read-aloud failure (bad key, no credits…); text carries on
}

export type Action =
  | DebateEvent
  | { type: 'convene'; brief: Brief; sessionId: string }
  | { type: 'open'; session: Session }
  | { type: 'home' }
  | { type: 'resume' }
  | { type: 'show-consortium' }
  | { type: 'show-chamber'; turn?: number }

export const initial: State = {
  boardStatus: 'idle',
  hostMessages: [],
  concluding: false,
  screen: 'convene',
  labels: {},
  stage: 'open',
  turn: 0,
  turns: [],
  shape: null,
  converged: false,
  chair: { text: '', status: 'idle' },
  revealed: false,
  usage: {}
}

// each member's latest vote, in transcript order
export function latestVotes(turns: TurnState[]): Record<string, Vote | null> {
  const v: Record<string, Vote | null> = {}
  for (const t of turns)
    if (t.speaker !== HUMAN && t.status === 'done' && t.vote) v[t.speaker] = t.vote
  return v
}

export function lastTurnOf(turns: TurnState[], memberId: string): TurnState | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].speaker === memberId) return turns[i]
  return undefined
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'convene':
      return {
        ...initial,
        screen: 'chamber',
        sessionId: a.sessionId,
        brief: a.brief,
        labels: makeLabels(a.brief.members)
      }
    case 'open': {
      const stage: Stage =
        a.session.status === 'done'
          ? 'done'
          : a.session.status === 'stopped'
            ? 'stopped'
            : a.session.status === 'failed'
              ? 'failed'
              : 'debate'
      const turns = a.session.turns.map(
        (t) => ({ ...t, status: t.error ? 'error' : 'done' }) as TurnState
      )
      return {
        ...initial,
        screen: a.session.consortium ? 'consortium' : 'chamber',
        sessionId: a.session.id,
        brief: a.session.brief,
        labels: a.session.labels,
        turns,
        turn: turns.filter((t) => t.speaker !== HUMAN).length,
        shape: a.session.shape,
        whiteboard: a.session.whiteboard,
        hostMessages: a.session.hostMessages ?? [],
        converged: a.session.converged,
        stage,
        chair: a.session.consortium
          ? { text: a.session.consortium.markdown, status: 'done' }
          : { text: '', status: 'idle' },
        consortium: a.session.consortium,
        revealed: true,
        usage: a.session.usage ?? {}
      }
    }
    case 'home':
      return { ...initial }
    case 'resume':
      // drop the turn that was cut off; the debate re-runs it
      return {
        ...s,
        stage: 'debate',
        concluding: false,
        error: undefined,
        turns: s.turns.filter((t) => t.status !== 'running'),
        chair: { text: '', status: 'idle' }
      }
    case 'show-consortium':
      return { ...s, screen: 'consortium', revealed: true }
    case 'show-chamber':
      return { ...s, screen: 'chamber', focusTurn: a.turn }
  }
  if (a.sessionId !== s.sessionId) return s
  switch (a.type) {
    case 'human-priority':
      return {
        ...s,
        converged: false,
        whiteboard: s.whiteboard ? { ...s.whiteboard, moderation: undefined } : undefined,
        speaking: undefined,
        activity: undefined,
        chair: { text: '', status: 'idle' },
        turns: s.turns.filter((t) => t.status !== 'running')
      }
    case 'whiteboard':
      return { ...s, whiteboard: a.board, boardStatus: 'idle', boardError: undefined }
    case 'board-status':
      return { ...s, boardStatus: a.status, boardError: a.error ?? s.boardError }
    case 'host-message':
      return {
        ...s,
        hostMessages: [...s.hostMessages.filter((m) => m.id !== a.message.id), a.message]
      }
    case 'concluding':
      return { ...s, concluding: true }
    case 'member-model':
      return s.brief
        ? {
            ...s,
            brief: {
              ...s.brief,
              members: s.brief.members.map((m) =>
                m.id === a.memberId ? { ...m, resolvedModel: a.model } : m
              )
            }
          }
        : s
    case 'trace': {
      const turns = s.turns.slice()
      const i = turns.findIndex(
        (t) => t.status === 'running' && t.speaker === a.memberId && t.n === a.turn
      )
      if (i < 0) return s
      turns[i] = { ...turns[i], trace: [...(turns[i].trace ?? []), a.step] }
      return { ...s, turns }
    }
    case 'activity':
      if (!s.activity || a.memberId !== s.speaking || a.turn !== s.activity.turn) return s
      return { ...s, activity: { ...s.activity, kind: a.kind, updatedAt: Date.now() } }
    case 'turn-start':
      return {
        ...s,
        stage: a.phase,
        turn: a.turn,
        speaking: a.memberId,
        activity: {
          memberId: a.memberId,
          turn: a.turn,
          kind: 'starting',
          startedAt: Date.now(),
          updatedAt: Date.now()
        },
        turns: [
          ...s.turns,
          {
            n: a.turn,
            speaker: a.memberId,
            label: s.labels[a.memberId] ?? a.memberId,
            startedAt: Date.now(),
            text: '',
            vote: null,
            status: 'running'
          }
        ]
      }
    case 'delta': {
      if (a.memberId !== s.speaking || !s.activity || s.activity.turn !== a.turn) return s
      const activity: ActivityState = { ...s.activity, kind: 'responding', updatedAt: Date.now() }
      if (a.turn === 0)
        return {
          ...s,
          activity,
          chair: { ...s.chair, text: s.chair.text + a.text, status: 'running' }
        }
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.memberId)
      if (i < 0) return s
      turns[i] = { ...turns[i], text: turns[i].text + a.text }
      return { ...s, turns, activity }
    }
    case 'turn-done': {
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.turn.speaker)
      const done: TurnState = { ...a.turn, status: 'done' }
      if (i < 0) turns.push(done)
      else turns[i] = done
      return { ...s, turns, speaking: undefined, activity: undefined }
    }
    case 'turn-error': {
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.memberId)
      if (i >= 0) turns[i] = { ...turns[i], status: 'error', error: a.message }
      return { ...s, turns, speaking: undefined, activity: undefined }
    }
    case 'turn-cancelled':
      return {
        ...s,
        turns: s.turns.filter(
          (t) => !(t.status === 'running' && t.speaker === a.memberId && t.n === a.turn)
        ),
        speaking: undefined,
        activity: undefined
      }
    case 'human':
      return { ...s, turns: [...s.turns, { ...a.turn, status: 'done' }] }
    case 'shape':
      return { ...s, shape: a.shape }
    case 'chair-start':
      return {
        ...s,
        stage: 'decide',
        speaking: a.memberId,
        activity: {
          memberId: a.memberId,
          turn: 0,
          kind: 'starting',
          startedAt: Date.now(),
          updatedAt: Date.now()
        },
        chair: { text: '', status: 'running' }
      }
    case 'consortium':
      return {
        ...s,
        consortium: { markdown: a.markdown, path: a.path },
        stage: 'done',
        speaking: undefined,
        activity: undefined,
        converged: s.converged,
        chair: { text: a.markdown, status: 'done' }
      }
    case 'stopped':
      return { ...s, stage: 'stopped', speaking: undefined, activity: undefined }
    case 'failed':
      return { ...s, stage: 'failed', error: a.message, speaking: undefined, activity: undefined }
    case 'usage':
      return { ...s, usage: a.usage }
    case 'voice-error':
      return { ...s, voiceError: a.message }
  }
  return s
}
