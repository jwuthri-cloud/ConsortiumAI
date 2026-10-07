import {
  HUMAN,
  type Brief,
  type DebateEvent,
  type Phase,
  type Session,
  type Shape,
  type Turn,
  type Vote
} from '@shared/types'
import { makeLabels } from '@shared/personas'

export type TurnState = Turn & { status: 'running' | 'done' | 'error'; startedAt?: number }
export type Stage = Phase | 'done' | 'stopped' | 'failed'
export type State = {
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
}

export type Action =
  | DebateEvent
  | { type: 'convene'; brief: Brief; sessionId: string }
  | { type: 'open'; session: Session }
  | { type: 'home' }
  | { type: 'show-consortium' }
  | { type: 'show-chamber' }

export const initial: State = {
  screen: 'convene',
  labels: {},
  stage: 'open',
  turn: 0,
  turns: [],
  shape: null,
  converged: false,
  chair: { text: '', status: 'idle' },
  revealed: false
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
        converged: a.session.converged,
        stage,
        chair: a.session.consortium
          ? { text: a.session.consortium.markdown, status: 'done' }
          : { text: '', status: 'idle' },
        consortium: a.session.consortium,
        revealed: true
      }
    }
    case 'home':
      return { ...initial }
    case 'show-consortium':
      return { ...s, screen: 'consortium', revealed: true }
    case 'show-chamber':
      return { ...s, screen: 'chamber' }
  }
  if (a.sessionId !== s.sessionId) return s
  switch (a.type) {
    case 'turn-start':
      return {
        ...s,
        stage: a.phase,
        turn: a.turn,
        speaking: a.memberId,
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
      if (a.turn === 0)
        return { ...s, chair: { ...s.chair, text: s.chair.text + a.text, status: 'running' } }
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.memberId)
      if (i < 0) return s
      turns[i] = { ...turns[i], text: turns[i].text + a.text }
      return { ...s, turns }
    }
    case 'turn-done': {
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.turn.speaker)
      const done: TurnState = { ...a.turn, status: 'done' }
      if (i < 0) turns.push(done)
      else turns[i] = done
      return { ...s, turns, speaking: undefined }
    }
    case 'turn-error': {
      const turns = s.turns.slice()
      const i = turns.findIndex((t) => t.status === 'running' && t.speaker === a.memberId)
      if (i >= 0) turns[i] = { ...turns[i], status: 'error', error: a.message }
      return { ...s, turns, speaking: undefined }
    }
    case 'human':
      return { ...s, turns: [...s.turns, { ...a.turn, status: 'done' }] }
    case 'shape':
      return { ...s, shape: a.shape }
    case 'chair-start':
      return { ...s, stage: 'decide', speaking: a.memberId, chair: { text: '', status: 'running' } }
    case 'consortium':
      return {
        ...s,
        consortium: { markdown: a.markdown, path: a.path },
        stage: 'done',
        speaking: undefined,
        converged: s.converged,
        chair: { text: a.markdown, status: 'done' }
      }
    case 'stopped':
      return { ...s, stage: 'stopped', speaking: undefined }
    case 'failed':
      return { ...s, stage: 'failed', error: a.message, speaking: undefined }
  }
  return s
}
