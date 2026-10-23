import { useState } from 'react'
import type { Whiteboard as Board, BoardNote, HostInput } from '@shared/whiteboard'
import BoardVisual from './BoardVisual'
import { BOARD_COLUMNS, WHITEBOARD_MODEL } from '@shared/whiteboard'
import type { State } from './state'

const LABELS = {
  agreed: 'Finding agreement',
  disputed: 'Still in debate',
  questions: 'Questions to answer',
  actions: 'Possible next steps'
}
const HINTS = {
  agreed: 'Shared ground will collect here.',
  disputed: 'Different perspectives stay visible.',
  questions: 'What does the room still need to know?',
  actions: 'Proposed actions, not assigned commitments.'
}
export default function Whiteboard({
  state: s,
  onSource,
  onRefresh,
  onDiscuss,
  onSend
}: {
  state: State
  onSource: (turn: number) => void
  onRefresh: () => void
  onDiscuss: (text: string) => void
  onSend: (input: Omit<HostInput, 'id'>) => Promise<void>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [held, setHeld] = useState<Board>()
  const [answerBoard, setAnswerBoard] = useState<Board>()
  const [answerId, setAnswerId] = useState<string>()
  const [refocusing, setRefocusing] = useState(false)
  const [refocusError, setRefocusError] = useState('')
  const [mode, setMode] = useState<'canvas' | 'notes'>('canvas')
  const [visualId, setVisualId] = useState<string>()
  const board = answerBoard ?? held ?? s.whiteboard
  const [history, setHistory] = useState<{ current?: Board; previous?: Board }>({ current: board })
  if (history.current !== board) setHistory({ current: board, previous: history.current })
  const previous = history.current === board ? history.previous : history.current
  const changed = (key: (typeof BOARD_COLUMNS)[number], note: BoardNote): boolean =>
    !held && !!previous && previous[key].find((old) => old.id === note.id)?.text !== note.text
  const visuals = board?.visuals ?? []
  const visual = visuals.find((item) => item.id === visualId) ?? visuals[0]
  const canDiscuss = ['open', 'debate', 'converge', 'decide'].includes(s.stage)
  const newer = Math.max(
    0,
    (s.whiteboard?.revision ?? 0) - (held?.revision ?? s.whiteboard?.revision ?? 0)
  )
  const live = s.turns
    .slice()
    .reverse()
    .find((t) => t.status === 'running')
  const running = ['open', 'debate', 'converge', 'decide'].includes(s.stage)
  const columns =
    mode === 'canvas' ? (['questions', 'disputed', 'agreed', 'actions'] as const) : BOARD_COLUMNS
  return (
    <section
      className={`whiteboard-view ${expanded ? 'board-expanded' : ''}`}
      aria-label="Meeting whiteboard"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setExpanded(false)
      }}
    >
      <div className="board-heading">
        <button
          className="board-expand"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Exit expanded whiteboard' : 'Expand whiteboard'}
          title={expanded ? 'Return to meeting layout (Esc)' : 'Expand whiteboard'}
        >
          {expanded ? '↙' : '⤢'}
        </button>
        <div>
          <span className="board-eyebrow">THE SHARED PICTURE</span>
          <h2>
            The whiteboard
            <span className={`board-indicator ${s.boardStatus}`} />
          </h2>
        </div>
        <div className="board-meta">
          <span>
            {held
              ? `Revision ${held.revision} · frozen view`
              : s.boardStatus === 'updating'
                ? 'Updating from the conversation…'
                : board
                  ? `Updated ${new Date(board.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Listening for the first ideas'}
          </span>
          <small>
            {board?.model ?? WHITEBOARD_MODEL} ·{' '}
            {board
              ? `${board.provisional ? 'includes draft turn' : 'through turn'} ${board.throughTurn}`
              : 'live synthesis'}
          </small>
        </div>
        <button
          className="secondary-button"
          onClick={onRefresh}
          disabled={!running || s.boardStatus === 'updating' || !s.turns.length}
          aria-label="Refresh whiteboard"
        >
          ↻
        </button>
      </div>
      <div className="board-workspace-tools">
        <div className="board-mode" aria-label="Whiteboard content">
          <button onClick={() => setMode('canvas')} aria-pressed={mode === 'canvas'}>
            ◈ Visual canvas <span>{visuals.length || ''}</span>
          </button>
          <button onClick={() => setMode('notes')} aria-pressed={mode === 'notes'}>
            ≡ All notes
          </button>
        </div>
        <button
          className="board-freeze"
          disabled={!board}
          aria-pressed={!!held}
          onClick={() => setHeld(held ? undefined : s.whiteboard)}
        >
          {held ? `${newer ? `${newer} new · ` : ''}Return to live` : 'Freeze view'}
        </button>
      </div>
      {held && (
        <p className="board-held" role="status">
          Viewing revision {held.revision}. The meeting and live board continue updating.
        </p>
      )}
      {answerBoard && (
        <p className="board-held" role="status">
          The board stays still while you answer. The meeting continues; sending takes the floor.
        </p>
      )}
      {s.boardError && (
        <div className="board-error" role="alert">
          The whiteboard couldn’t update. Your meeting continues and the last board is kept.
          <details>
            <summary>Details</summary>
            {s.boardError}
          </details>
        </div>
      )}
      <div className={`board-moderator ${board?.moderation ? 'is-guiding' : ''}`} role="status">
        <span className="moderator-mark" aria-hidden="true">
          ◎
        </span>
        <div>
          <strong>
            {board?.moderation?.kind === 'refocus'
              ? 'Bringing the room back on track'
              : board?.moderation?.kind === 'resolve'
                ? 'Working through the disagreement'
                : board?.moderation?.kind === 'clarify'
                  ? 'Clarifying what matters'
                  : 'Meeting moderator'}
          </strong>
          <p>
            {board?.moderation?.message ??
              'Watching for drift, repeated arguments, and questions that need your input.'}
          </p>
          {board?.moderation && (
            <small>
              {held
                ? 'Guidance from this frozen revision'
                : `Guidance through turn ${board.throughTurn}`}
              {board.moderation.nextMemberId &&
                ` · Suggested speaker: ${s.labels[board.moderation.nextMemberId] ?? 'the room'}`}
            </small>
          )}
        </div>
        <button
          className="text-button"
          disabled={!canDiscuss || refocusing}
          onClick={async () => {
            setRefocusing(true)
            setRefocusError('')
            try {
              await onSend({
                kind: 'focus',
                text: 'Bring the discussion back to our original question. Identify the decision we need to make and the one unresolved point blocking it. Preserve the constraints I have already given.'
              })
            } catch {
              setRefocusError('Could not refocus the room. Please try again.')
            } finally {
              setRefocusing(false)
            }
          }}
        >
          {refocusing ? 'Taking the floor…' : 'Refocus the room ↗'}
        </button>
      </div>
      {refocusError && (
        <p className="board-error" role="alert">
          {refocusError}
        </p>
      )}
      <div className={`board-canvas ${mode === 'canvas' ? 'visual-workspace' : ''}`}>
        {mode === 'canvas' && (
          <div className="board-visual-area">
            {visual ? (
              <>
                <nav className="visual-tabs" aria-label="Meeting visuals">
                  {visuals.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setVisualId(item.id)}
                      aria-pressed={visual.id === item.id}
                    >
                      <span>
                        {item.kind === 'diagram' ? '⌘' : item.kind === 'comparison' ? '▥' : '↝'}
                      </span>
                      {item.title}
                    </button>
                  ))}
                </nav>
                <BoardVisual
                  key={visual.id}
                  visual={visual}
                  revision={board!.revision}
                  canDiscuss={canDiscuss}
                  onDiscuss={(text) => {
                    setExpanded(false)
                    onDiscuss(text)
                  }}
                  onSource={(turn) => {
                    setExpanded(false)
                    onSource(turn)
                  }}
                />
              </>
            ) : (
              <div className="visual-empty">
                <div className="visual-empty-glyph" aria-hidden="true">
                  <i />
                  <span>→</span>
                  <i />
                  <span>↗</span>
                  <i />
                </div>
                <h3>Give the ideas a shape.</h3>
                <p>
                  The room can sketch a flow, compare alternatives, or map a plan as the
                  conversation develops.
                </p>
                <small>
                  Visuals appear when there is enough detail to draw from. You can also ask the
                  room:
                </small>
                <div>
                  {[
                    'Sketch the proposed flow and identify its open questions.',
                    'Compare the alternatives and their tradeoffs.',
                    'Map a sequence of next steps, keeping assumptions explicit.'
                  ].map((request, i) => (
                    <button
                      key={request}
                      disabled={!canDiscuss}
                      onClick={() => {
                        setExpanded(false)
                        onDiscuss(request)
                      }}
                    >
                      {['Sketch a flow ↗', 'Compare options ↗', 'Map next steps ↗'][i]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {visual && (
              <p className="visual-footnote">
                Working sketch · select an element to inspect its sources or discuss a change.
                Revision {board?.revision}.
              </p>
            )}
          </div>
        )}
        <div className="board-notes-area">
          <div className="board-direction">
            <span>↗ CURRENT DIRECTION</span>
            <p>{board?.recommendation || 'Good ideas start with a question.'}</p>
            <small>
              {board
                ? 'Working synthesis · not the final decision'
                : 'As the room talks, the important ideas take shape here.'}
            </small>
          </div>
          <div className="board-columns">
            {columns.map((key, index) => (
              <section className={`board-column board-${key}`} key={key}>
                <h3>
                  <span>0{index + 1}</span>
                  {LABELS[key]}
                  <b>{board?.[key].length ?? 0}</b>
                </h3>
                {board?.[key].length ? (
                  board[key].map((note) => (
                    <article
                      className={`board-note ${changed(key, note) ? 'board-note-changed' : ''}`}
                      key={note.id}
                    >
                      {changed(key, note) && <span className="board-change-label">Updated</span>}
                      <p>{note.text}</p>
                      <div className="board-sources">
                        {note.sources.map((n) => (
                          <button
                            key={n}
                            onClick={() => {
                              setExpanded(false)
                              onSource(n)
                            }}
                          >
                            Turn {n} ↗
                          </button>
                        ))}
                      </div>
                      {key === 'questions' && (
                        <BoardAnswer
                          note={note}
                          revision={board.revision}
                          enabled={canDiscuss && (!answerId || answerId === note.id)}
                          messages={s.hostMessages}
                          onSend={onSend}
                          onEditing={(editing) => {
                            setAnswerBoard(editing ? board : undefined)
                            setAnswerId(editing ? note.id : undefined)
                          }}
                        />
                      )}
                      {key !== 'questions' && (
                        <button
                          className="board-discuss-note"
                          disabled={!canDiscuss}
                          onClick={() => {
                            setExpanded(false)
                            onDiscuss(`On “${note.text}” (whiteboard revision ${board.revision}): `)
                          }}
                        >
                          Discuss this ↗
                        </button>
                      )}
                    </article>
                  ))
                ) : (
                  <p className="board-empty">{HINTS[key]}</p>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>
      <div className="board-live">
        <span className="board-live-label">{live && running ? 'ON THE FLOOR' : 'IN THE ROOM'}</span>
        <p>
          {live && running
            ? `${live.label.replace(/^The /, '')}: ${live.text.replace(/```[\s\S]*$/, '').slice(-210) || 'Preparing a response…'}`
            : running
              ? s.chair.status === 'running'
                ? 'The chair is bringing the discussion into a final decision.'
                : 'The room is between contributions.'
              : 'The conversation is saved. Explore the ideas and their sources.'}
        </p>
      </div>
    </section>
  )
}

function BoardAnswer({
  note,
  revision,
  enabled,
  messages,
  onSend,
  onEditing
}: {
  note: BoardNote
  revision: number
  enabled: boolean
  messages: State['hostMessages']
  onSend: (input: Omit<HostInput, 'id'>) => Promise<void>
  onEditing: (editing: boolean) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Keep the exact question being answered even if the live board changes while typing.
  const [reference, setReference] = useState({ id: note.id, text: note.text, revision })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sent = messages.findLast(
    (m) => m.boardNote?.id === note.id && m.boardNote.text === note.text
  )
  return (
    <div className="board-answer">
      {sent && (
        <p className="board-answer-status" role="status">
          {sent.status === 'queued'
            ? 'Taking the floor…'
            : `Delivered to ${sent.deliveredTo?.replace(/^The /, '') ?? 'the room'}`}
          <span>{sent.text}</span>
        </p>
      )}
      {!editing ? (
        <button
          className="board-answer-button"
          disabled={!enabled}
          onClick={() => {
            setReference({ id: note.id, text: note.text, revision })
            setEditing(true)
            onEditing(true)
          }}
        >
          {sent ? 'Add to your answer' : 'Answer this question'} <span>↗</span>
        </button>
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (!draft.trim() || busy) return
            setBusy(true)
            setError('')
            try {
              await onSend({ kind: 'thought', text: draft, boardNote: reference })
              setDraft('')
              setEditing(false)
              onEditing(false)
            } catch {
              setError('Could not send. Your answer is kept; try again.')
            } finally {
              setBusy(false)
            }
          }}
        >
          {reference.text !== note.text && <small>Answering: {reference.text}</small>}
          <textarea
            autoFocus
            rows={3}
            maxLength={4000}
            value={draft}
            disabled={busy || !enabled}
            aria-label={`Answer: ${reference.text}`}
            placeholder="Share the missing context…"
            onChange={(event) => setDraft(event.target.value)}
          />
          <small>Sending interrupts the AI. Your answer comes first.</small>
          <div className="board-answer-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                onEditing(false)
              }}
            >
              Cancel
            </button>
            <button className="secondary-button" disabled={!draft.trim() || busy || !enabled}>
              {busy ? 'Sending…' : 'Send answer ↗'}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  )
}
