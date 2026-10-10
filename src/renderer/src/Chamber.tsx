import Whiteboard from './Whiteboard'
import Trace from './Trace'
import DecisionBoard from './DecisionBoard'
import { ACTIVITY_LABELS } from '@shared/activity'
import ActivityStatus from './ActivityStatus'
import { memberModel } from '@shared/models'
import Brand from './Brand'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { HUMAN, type PersonaId } from '@shared/types'
import { PERSONAS } from '@shared/personas'
import { lastTurnOf, latestVotes, type State } from './state'
import Markdown from './Markdown'
import AgentAvatar, { type Presence } from './AgentAvatar'
import * as voice from './voice'
import { PROVIDERS } from './avatarTheme'
import { AgentUsage, UsageMeter } from './Usage'

type Props = {
  state: State
  onHome: () => void
  onConsortium: () => void
  onResume: () => void
}
type IconName =
  | 'board'
  | 'back'
  | 'send'
  | 'chat'
  | 'file'
  | 'folder'
  | 'check'
  | 'end'
  | 'grid'
  | 'focus'
  | 'people'
  | 'close'
  | 'expand'
  | 'pause'
  | 'play'
  | 'sound'
  | 'muted'
  | 'trace'
function Icon({ name, size = 18 }: { name: IconName; size?: number }): React.JSX.Element {
  const paths: Record<IconName, string> = {
    board: 'M3 4h18v14H3ZM8 22l4-4 4 4M7 8h4m-4 4h7',
    back: 'M15 18l-6-6 6-6',
    send: 'M12 19V5m-6 6 6-6 6 6',
    chat: 'M5 5h14v11H9l-4 4V5Z M9 9h6m-6 3h4',
    file: 'M6 3h8l4 4v14H6V3Z M14 3v5h4M9 12h6m-6 4h6',
    folder: 'M3 7V5h6l2 2h10v12H3V7Z',
    check: 'm5 12 4 4L19 6',
    end: 'M3 14c4-5 14-5 18 0l-3 4-4-2v-3h-4v3l-4 2-3-4Z',
    grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
    focus: 'M3 3h18v12H3ZM3 18h4v3H3ZM10 18h4v3h-4ZM17 18h4v3h-4Z',
    people:
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M20 21v-2a4 4 0 0 0-3-3.87M16 3a4 4 0 0 1 0 8',
    close: 'm6 6 12 12M6 18 18 6',
    expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    pause: 'M9 5v14M15 5v14',
    play: 'M7 4v16l13-8Z',
    sound: 'M4 9h4l5-4v14l-5-4H4ZM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
    muted: 'M4 9h4l5-4v14l-5-4H4ZM17 9l5 6m0-6-5 6',
    trace: 'm4 17 6-5-6-5M12 19h8'
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
const PORTRAITS: Record<PersonaId, { color: string; role: string }> = {
  strategist: { color: '#df9b7d', role: 'The big picture' },
  engineer: { color: '#91bdac', role: 'Making it work' },
  researcher: { color: '#b2a0df', role: 'Following the evidence' },
  designer: { color: '#dbc187', role: 'How it feels' },
  skeptic: { color: '#a4b9d9', role: 'Asking the hard questions' },
  customer: { color: '#dfa1ad', role: 'The human perspective' }
}
const STAGES = ['Explore', 'Debate', 'Converge', 'Decide']
const plain = (text: string): string =>
  text
    .replace(/```[\s\S]*$/, '')
    .replace(/[#*>`_]/g, '')
    .trim()

export default function Chamber({
  state: s,
  onHome,
  onConsortium,
  onResume
}: Props): React.JSX.Element {
  const brief = s.brief!
  const members = brief.members
  const [view, setView] = useState<'gallery' | 'speaker' | 'whiteboard'>('gallery')
  const [panel, setPanel] = useState<'conversation' | 'decision' | 'trace' | null>(
    s.focusTurn ? 'conversation' : 'decision'
  )
  const [pinned, setPinned] = useState<string | null>(null)
  const [thought, setThought] = useState('')
  const [hostMode, setHostMode] = useState('thought')
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [pauseRequested, setPaused] = useState(false)
  const [muted, setMuted] = useState(voice.isMuted)
  const [rate, setRate] = useState(voice.getRate)
  // with voices on, the room follows whoever is audible; the next seat may already be writing
  const audible = useSyncExternalStore(voice.subscribe, voice.talking)
  const [stick, setStick] = useState(!s.focusTurn)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const running = ['open', 'debate', 'converge', 'decide'].includes(s.stage)
  const chairWriting = s.chair.status === 'running'
  const canInterject = running && !chairWriting && !s.concluding
  const votes = latestVotes(s.turns)
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN).length
  const phase =
    s.stage === 'open'
      ? 0
      : s.stage === 'debate'
        ? 1
        : s.stage === 'converge'
          ? 2
          : s.stage === 'decide' || s.stage === 'done'
            ? 3
            : s.turn <= members.length
              ? 0
              : s.turn > brief.maxTurns - members.length
                ? 3
                : s.turn > brief.maxTurns * 0.6
                  ? 2
                  : 1
  const activeId =
    audible ??
    s.speaking ??
    s.turns.filter((t) => t.speaker !== HUMAN).at(-1)?.speaker ??
    members[0]?.id
  const focusId = pinned ?? activeId
  const liveTurn = lastTurnOf(s.turns, activeId)
  const paused = running && pauseRequested
  const status =
    s.stage === 'done'
      ? 'Session complete'
      : s.stage === 'failed'
        ? 'Session failed'
        : s.stage === 'stopped'
          ? 'Session ended'
          : chairWriting
            ? 'Writing the decision'
            : s.concluding
              ? 'Concluding after this response'
              : paused
                ? s.speaking
                  ? `Pausing after ${s.labels[s.speaking]?.replace(/^The /, '')} finishes`
                  : 'Paused'
                : 'Live discussion'
  const regularTurns = s.turns.filter(
    (turn) =>
      turn.speaker !== HUMAN &&
      !s.hostMessages.some(
        (message) =>
          message.kind === 'ask' && message.status === 'delivered' && message.turn === turn.n
      )
  ).length
  const nextMember =
    !s.concluding && s.activity && s.activity.turn > 0 && s.activity.turn < brief.maxTurns
      ? (members.find(
          (m) =>
            m.id ===
            s.hostMessages.find((message) => message.status === 'queued' && message.kind === 'ask')
              ?.targetId
        ) ?? members[regularTurns % members.length])
      : undefined
  const activeName = s.labels[activeId]?.replace(/^The /, '')
  const caption = !running
    ? s.consortium
      ? 'Your decision is ready, with the rationale, next steps, and dissent preserved.'
      : 'The meeting has ended. Every perspective is preserved in the transcript.'
    : chairWriting
      ? 'Bringing the perspectives together into your decision document…'
      : liveTurn?.text
        ? plain(liveTurn.text).slice(-190)
        : running
          ? 'A few different minds. One better decision. Let’s hear the opening perspectives.'
          : 'The conversation has ended. Every perspective is preserved in the transcript.'

  useEffect(() => {
    const el = feedRef.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [s.turns, s.chair.text, stick, panel])

  const askAgent = (id: string): void => {
    setHostMode(id)
    setPanel('conversation')
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const scrollToTurn = (n: number): void => {
    const el = document.getElementById(`turn-${n}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.animate([{ backgroundColor: '#c5b8ee26' }, { backgroundColor: 'transparent' }], {
      duration: 2000
    })
  }
  const viewSource = (n: number): void => {
    setPanel('conversation')
    setStick(false)
    requestAnimationFrame(() => scrollToTurn(n))
  }
  // opened from a citation on the decision page: the panel and stick already start there (above).
  // Chamber remounts on each visit, so running once is enough.
  useEffect(() => {
    if (s.focusTurn) scrollToTurn(s.focusTurn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const answer = (question: string): void => {
    setHostMode('thought')
    setThought(`On “${question}”: `)
    setPanel('conversation')
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const discussVisual = (text: string): void => {
    setHostMode('thought')
    setThought(text)
    setNotice('Add your question or send this to the room. It joins the next turn.')
    setPanel('conversation')
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const questions = s.whiteboard?.questions.length ?? 0
  const refreshBoard = async (): Promise<void> => {
    try {
      await window.api!.refreshBoard()
    } catch {
      setNotice('Could not refresh the whiteboard.')
      setPanel('conversation')
    }
  }
  const conclude = async (): Promise<void> => {
    try {
      await window.api!.conclude()
      setPaused(false)
      setNotice(null)
    } catch {
      setNotice('Could not conclude the meeting. Try again.')
      setPanel('conversation')
    }
  }
  const addContext = (): void => {
    setPanel('conversation')
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const interject = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!thought.trim() || !canInterject || sending) return
    setSending(true)
    try {
      await window.api!.host({
        id: crypto.randomUUID(),
        kind: hostMode === 'thought' ? 'thought' : hostMode === 'focus' ? 'focus' : 'ask',
        targetId: members.some((m) => m.id === hostMode) ? hostMode : undefined,
        text: thought.trim()
      })
      setThought('')
      setNotice(null)
      setStick(true)
    } catch {
      setNotice('Could not send. Please try again.')
    } finally {
      setSending(false)
    }
  }
  const togglePause = async (): Promise<void> => {
    try {
      await window.api!.pause(!paused)
      setPaused(!paused)
    } catch {
      setNotice('Could not pause. Please try again.')
    }
  }
  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await window.api!.stop()
    } catch {
      setNotice('Could not end the session. Please try again.')
      setPanel('conversation')
    } finally {
      setStopping(false)
    }
  }
  const togglePanel = (next: 'conversation' | 'decision' | 'trace'): void =>
    setPanel(panel === next ? null : next)

  return (
    <div className={`meeting-room ${panel ? 'with-panel' : ''}`}>
      <header className="meeting-titlebar drag">
        <Brand />
        <span className="titlebar-slash">/</span>
        <span className="titlebar-room">The meeting room</span>
        <div className={`meeting-status ${running ? 'live' : ''}`} role="status">
          <i />
          {status}
        </div>
      </header>
      <main className={`meeting-main ${view === 'whiteboard' ? 'has-whiteboard' : ''}`}>
        <div className="meeting-heading">
          <div className="meeting-question">
            <div className="meeting-eyebrow">A MEETING OF MINDS</div>
            <h1>{brief.task}</h1>
            <div className="meeting-context">
              <span>
                <Icon name="people" size={13} />
                {members.length} AI members + you
              </span>
              {brief.projectPath && (
                <span title={brief.projectPath}>
                  <Icon name="folder" size={13} />
                  {brief.projectPath.split('/').pop()}
                  <small>Read-only</small>
                </span>
              )}
            </div>
          </div>
          <div className="view-switch" aria-label="Meeting layout">
            <button
              onClick={() => {
                setView('gallery')
                setPinned(null)
              }}
              aria-pressed={view === 'gallery'}
              title="Gallery view"
              aria-label="Gallery view"
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              onClick={() => setView('speaker')}
              aria-pressed={view === 'speaker'}
              title="Speaker view"
              aria-label="Speaker view"
            >
              <Icon name="focus" size={17} />
            </button>
            <button
              onClick={() => {
                setView('whiteboard')
                setPanel(null)
              }}
              aria-pressed={view === 'whiteboard'}
              title="Whiteboard view"
              aria-label="Whiteboard view"
            >
              <Icon name="board" size={17} />
            </button>
          </div>
        </div>
        <div className="meeting-progress">
          <ol aria-label="Discussion progress">
            {STAGES.map((label, i) => (
              <li
                key={label}
                className={phase === i ? 'current' : phase > i ? 'complete' : ''}
                aria-current={phase === i ? 'step' : undefined}
              >
                <span>{phase > i ? <Icon name="check" size={10} /> : i + 1}</span>
                {label}
                {i < 3 && <b>›</b>}
              </li>
            ))}
          </ol>
          <span className="meeting-turn">
            <UsageMeter s={s} />
            Turn {memberTurns}
            <span> / {brief.maxTurns}</span>
          </span>
        </div>
        {/* Focus layout: the whiteboard takes the stage, the agents stay present in a compact strip. */}
        <section
          className={`participant-grid ${view === 'speaker' ? 'speaker-layout' : view === 'whiteboard' ? 'focus-layout' : members.length > 3 ? 'many-participants' : ''}`}
          aria-label="Meeting participants"
        >
          {members.map((m) => {
            const portrait = PORTRAITS[m.persona]
            const working = s.speaking === m.id && running
            const aloud = audible === m.id
            const speaking = audible ? aloud : working
            const last = lastTurnOf(s.turns, m.id)
            const vote = votes[m.id]
            const failed = last?.status === 'error'
            const presence: Presence = failed
              ? 'failed'
              : working
                ? s.activity?.kind === 'responding'
                  ? 'responding'
                  : 'reading'
                : running
                  ? 'listening'
                  : 'idle'
            const featured = view === 'speaker' && focusId === m.id
            const stateText = aloud
              ? 'Speaking'
              : working
                ? s.activity
                  ? ACTIVITY_LABELS[s.activity.kind]
                  : chairWriting
                    ? 'Writing'
                    : 'Preparing'
                : failed
                  ? 'Response failed'
                  : running
                    ? 'Listening'
                    : s.stage === 'done'
                      ? 'Finished'
                      : last?.status === 'running'
                        ? 'Interrupted'
                        : 'Stopped'
            return (
              <article
                key={m.id}
                className={`participant-tile ${speaking ? 'is-speaking' : ''} ${featured ? 'is-featured' : ''} ${view !== 'gallery' && !featured ? 'is-compact' : ''}`}
                data-presence={presence}
                style={{ '--seat-color': PROVIDERS[m.cli].color } as CSSProperties}
                aria-label={`${s.labels[m.id]}, ${stateText}`}
              >
                <div className="portrait-scene">
                  <AgentAvatar
                    cli={m.cli}
                    persona={m.persona}
                    model={memberModel(m) ?? (running ? 'CONNECTING' : 'NOT RECORDED')}
                    presence={presence}
                    voiceId={brief.voices && m.voice ? m.id : undefined}
                  />
                </div>
                <div className="tile-shade" />
                <div className="tile-top">
                  <span className="persona-lens">
                    {portrait.role}
                    <small>3D · Drag to rotate</small>
                  </span>
                  {speaking || working ? (
                    <span className="tile-speaking">
                      <span
                        className={
                          aloud || (!audible && s.activity?.kind === 'responding')
                            ? 'voice-bars'
                            : 'working-dots'
                        }
                      >
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                      {stateText}
                    </span>
                  ) : (
                    <span className={`tile-state ${failed ? 'has-error' : ''}`}>
                      <i className="presence-dot" />
                      {stateText}
                    </span>
                  )}
                </div>
                {featured && vote && <div className="featured-position">“{vote.position}”</div>}
                <div className="tile-bottom">
                  <div>
                    <div className="tile-name">
                      {s.labels[m.id].replace(/^The /, '')}
                      {m.id === brief.chairId && <span>CHAIR</span>}
                    </div>
                    <div className="tile-model" title={memberModel(m)}>
                      {memberModel(m) ?? (running ? 'Resolving model…' : 'Model not recorded')}
                      {brief.voices && m.voice && ` · voice ${m.voice}`}
                    </div>
                    <AgentUsage s={s} id={m.id} />
                  </div>
                  {canInterject && (
                    <button
                      className="tile-ask"
                      onClick={() => askAgent(m.id)}
                      aria-label={`Ask ${s.labels[m.id]}`}
                    >
                      Ask ↗
                    </button>
                  )}
                  <button
                    className="tile-focus-icon"
                    aria-label={`Focus on ${s.labels[m.id]}`}
                    onClick={() => {
                      setPinned(m.id)
                      setView('speaker')
                    }}
                  >
                    <Icon name="expand" size={14} />
                  </button>
                </div>
              </article>
            )
          })}
          <div className={`participant-tile human-tile ${view !== 'gallery' ? 'is-compact' : ''}`}>
            <div className="human-orbit orbit-one" />
            <div className="human-orbit orbit-two" />
            <div className="human-tile-top">
              <span>Every good discussion needs you.</span>
              <span className="human-badge">YOUR SEAT</span>
            </div>
            <div className="human-center">
              <div className="human-avatar">
                Y<span />
              </div>
              <h2>A little human perspective.</h2>
              <p>
                Add context. Challenge a thought.
                <br />
                Help the room see something new.
              </p>
              <button onClick={addContext} disabled={!canInterject}>
                <Icon name="chat" size={13} />
                Add your perspective
              </button>
            </div>
            <div className="tile-bottom">
              <div>
                <div className="tile-name">
                  You<span>HOST</span>
                </div>
                <div className="tile-model">Part of the conversation</div>
              </div>
              <span className="human-presence" />
            </div>
          </div>
        </section>
        {view === 'whiteboard' && (
          <Whiteboard
            state={s}
            onSource={viewSource}
            onRefresh={() => void refreshBoard()}
            onDiscuss={discussVisual}
          />
        )}
        {view !== 'whiteboard' && (
          <div className="live-caption">
            <div className={`caption-indicator ${s.speaking ? 'active' : ''}`}>
              <span />
              <span />
              <span />
            </div>
            <div>
              <strong>
                {audible
                  ? `${s.labels[audible]?.replace(/^The /, '')} is speaking`
                  : s.speaking
                    ? `${activeName}${chairWriting ? ' · chair' : ' has the floor'}`
                    : running
                      ? 'Around the table'
                      : 'Meeting recap'}
              </strong>
              {s.activity && running ? (
                <ActivityStatus
                  activity={s.activity}
                  next={nextMember ? s.labels[nextMember.id]?.replace(/^The /, '') : undefined}
                />
              ) : (
                <p>{caption}</p>
              )}
            </div>
            {pinned && view === 'speaker' && (
              <button onClick={() => setPinned(null)}>Follow speaker</button>
            )}
          </div>
        )}
      </main>
      {panel && (
        <aside className="meeting-panel" aria-label="Meeting side panel">
          <div className="panel-tabs" role="tablist" aria-label="Meeting details">
            <button
              role="tab"
              aria-selected={panel === 'conversation'}
              onClick={() => setPanel('conversation')}
            >
              <Icon name="chat" size={15} />
              Conversation<span>{s.turns.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={panel === 'decision'}
              onClick={() => setPanel('decision')}
            >
              <Icon name="file" size={15} />
              Decision
              {questions > 0 && <span title="Needs your input">{questions}</span>}
            </button>
            <button role="tab" aria-selected={panel === 'trace'} onClick={() => setPanel('trace')}>
              <Icon name="trace" size={15} />
              Trace
            </button>
            <button
              className="panel-close"
              onClick={() => setPanel(null)}
              aria-label="Close side panel"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          {panel === 'trace' ? (
            <Trace turns={s.turns} members={members} running={running} />
          ) : panel === 'conversation' ? (
            <>
              <div className="panel-intro">
                <h2>The conversation</h2>
                <p>Different perspectives. All in one place.</p>
              </div>
              <div
                className="meeting-transcript"
                ref={feedRef}
                role="region"
                aria-label="Discussion transcript"
                tabIndex={0}
                onScroll={(e) =>
                  setStick(
                    e.currentTarget.scrollHeight -
                      e.currentTarget.scrollTop -
                      e.currentTarget.clientHeight <
                      65
                  )
                }
              >
                <div className="transcript-marker">
                  <span />
                  {s.turns.length ? 'The meeting has started' : 'Taking our seats'}
                  <span />
                </div>
                {s.turns.map((t, i) => {
                  const member = members.find((m) => m.id === t.speaker)
                  const human = t.speaker === HUMAN
                  const portrait = member ? PORTRAITS[member.persona] : undefined
                  const active = running && t.status === 'running'
                  return (
                    <article
                      id={human ? undefined : `turn-${t.n}`}
                      className={`meeting-message ${human ? 'from-human' : ''}`}
                      key={`${t.speaker}-${t.n}-${i}`}
                      style={{ '--seat-color': portrait?.color ?? '#b8bfd2' } as CSSProperties}
                    >
                      <div
                        className="message-avatar"
                        style={{ color: member ? PROVIDERS[member.cli].color : undefined }}
                      >
                        {human ? 'Y' : member ? PERSONAS[member.persona].monogram : '?'}
                      </div>
                      <div className="message-body">
                        <div className="message-meta">
                          <h3>{human ? 'You' : t.label.replace(/^The /, '')}</h3>
                          <span>
                            {active
                              ? s.activity
                                ? ACTIVITY_LABELS[s.activity.kind]
                                : 'Preparing'
                              : human
                                ? 'Host'
                                : `Turn ${t.n}`}
                          </span>
                        </div>
                        {t.status === 'error' ? (
                          <p className="meeting-error">{t.error}</p>
                        ) : t.status === 'running' ? (
                          <>
                            {plain(t.text) ? (
                              <p
                                className={`message-stream ${active && s.activity?.kind === 'responding' ? 'cursor' : ''}`}
                              >
                                {plain(t.text)}
                              </p>
                            ) : active ? (
                              <div className="response-placeholder">
                                <span />
                                <span />
                                <span />
                                <p>The response will appear here.</p>
                              </div>
                            ) : (
                              <p className="message-stream">Response interrupted.</p>
                            )}
                          </>
                        ) : (
                          <Markdown text={t.text} className="compact" />
                        )}
                        {t.vote && (
                          <div className="message-vote">
                            <span>{Math.round(t.vote.confidence * 100)}% confidence</span>
                            {t.vote.disagreements.length > 0 && (
                              <span className="objection-chip">
                                {t.vote.disagreements.length} objection
                                {t.vote.disagreements.length > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        )}
                        {!!t.vote?.disagreements.length && (
                          <details className="message-objections">
                            <summary>View objections</summary>
                            {t.vote.disagreements.map((d, j) => (
                              <p key={j}>
                                <strong>{d.with}</strong>
                                {d.on ? ` · ${d.on}` : ''}
                              </p>
                            ))}
                          </details>
                        )}
                      </div>
                    </article>
                  )
                })}
                {chairWriting && (
                  <div className="meeting-system-message">
                    <Icon name="file" />
                    <p>
                      The chair is writing the final decision
                      <span className="cursor" />
                    </p>
                  </div>
                )}
                {s.consortium && (
                  <button className="decision-ready" onClick={onConsortium}>
                    <Icon name="file" />
                    <span>
                      Your decision is ready<small>Rationale, next steps, and dissent</small>
                    </span>
                    <span>↗</span>
                  </button>
                )}
                {s.stage === 'failed' && (
                  <p className="meeting-error" role="alert">
                    {s.error ?? 'The session failed.'}
                  </p>
                )}
              </div>
              <div className="meeting-compose-wrap">
                {!stick && (
                  <button className="latest-button" onClick={() => setStick(true)}>
                    ↓ Back to live
                  </button>
                )}
                {s.hostMessages.length > 0 && (
                  <div className="host-queue" aria-label="Host messages">
                    {s.hostMessages.slice(-3).map((message) => (
                      <div key={message.id}>
                        <p>
                          {message.kind === 'focus'
                            ? 'Focus: '
                            : message.kind === 'ask'
                              ? `${s.labels[message.targetId!]?.replace(/^The /, '')}: `
                              : ''}
                          {message.text}
                        </p>
                        <span className={message.status}>
                          {message.status === 'queued'
                            ? 'Queued · next turn'
                            : `Delivered to ${message.deliveredTo?.replace(/^The /, '')}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <label className="host-mode">
                  Direct the room
                  <select
                    aria-label="Message destination"
                    value={hostMode}
                    onChange={(e) => setHostMode(e.target.value)}
                    disabled={!canInterject}
                  >
                    <option value="thought">Everyone · add a thought</option>
                    <option value="focus">Focus the discussion</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        Ask {s.labels[m.id].replace(/^The /, '')} next
                      </option>
                    ))}
                  </select>
                </label>
                <form className="meeting-composer" onSubmit={(e) => void interject(e)}>
                  <textarea
                    rows={3}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        e.currentTarget.form?.requestSubmit()
                      }
                    }}
                    ref={inputRef}
                    value={thought}
                    onChange={(e) => {
                      setThought(e.target.value)
                      setNotice(null)
                    }}
                    maxLength={4000}
                    disabled={!canInterject || sending}
                    placeholder={
                      canInterject
                        ? hostMode === 'focus'
                          ? 'What should the room focus on?'
                          : hostMode === 'thought'
                            ? 'Say something to the room…'
                            : 'Your question for this agent…'
                        : chairWriting
                          ? 'The chair is writing…'
                          : 'This session has ended'
                    }
                    aria-label="Message to the discussion"
                  />
                  <button
                    type="submit"
                    aria-label="Send message"
                    disabled={!thought.trim() || !canInterject || sending}
                  >
                    <Icon name="send" size={16} />
                  </button>
                </form>
                <p role="status">
                  {notice ??
                    (canInterject
                      ? 'Your message joins the next turn.'
                      : 'Every perspective stays in the transcript.')}
                </p>
              </div>
            </>
          ) : (
            <DecisionBoard
              state={s}
              onSource={viewSource}
              onAnswer={answer}
              onConsortium={onConsortium}
            />
          )}
        </aside>
      )}
      <footer className="meeting-controls">
        <div className="meeting-footer-context">
          <span className={`footer-live-dot ${running ? 'live' : ''}`} />
          <div>
            <strong>{running ? 'In the room' : 'Meeting ended'}</strong>
            <span>{members.length + 1} participants</span>
          </div>
        </div>
        <div className="meeting-tool-group">
          <button
            className={`meeting-tool ${paused ? 'tool-active' : ''}`}
            aria-pressed={paused}
            onClick={() => void togglePause()}
            disabled={!running || chairWriting}
          >
            <span className="tool-icon">
              <Icon name={paused ? 'play' : 'pause'} />
            </span>
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </button>
          {brief.voices && (
            <button
              className={`meeting-tool ${muted ? 'tool-active' : ''}`}
              aria-pressed={muted}
              onClick={() => {
                voice.setMuted(!muted)
                setMuted(!muted)
              }}
              title={
                s.voiceError ?? (muted ? 'Voices muted: the meeting runs at text pace' : undefined)
              }
            >
              <span className="tool-icon">
                <Icon name={muted ? 'muted' : 'sound'} />
                {s.voiceError && <b>!</b>}
              </span>
              <span>{s.voiceError ? 'Voice failed' : muted ? 'Unmute' : 'Mute'}</span>
            </button>
          )}
          {brief.voices && (
            <button
              className="meeting-tool"
              onClick={() => {
                const r = voice.RATES[(voice.RATES.indexOf(rate as never) + 1) % voice.RATES.length]
                voice.setRate(r)
                setRate(r)
              }}
              title="Voice speed"
            >
              <span className="tool-icon rate-icon">{rate}×</span>
              <span>Speed</span>
            </button>
          )}
          <button className="meeting-tool" onClick={addContext} disabled={!canInterject}>
            <span className="tool-icon">
              <Icon name="chat" />
            </span>
            <span>Add a thought</span>
          </button>
          <span className="tools-divider" />
          <button
            className={`meeting-tool ${panel === 'conversation' ? 'tool-active' : ''}`}
            aria-pressed={panel === 'conversation'}
            onClick={() => togglePanel('conversation')}
          >
            <span className="tool-icon">
              <Icon name="chat" />
              <b>{s.turns.length}</b>
            </span>
            <span>Conversation</span>
          </button>
          <button
            className={`meeting-tool ${panel === 'decision' ? 'tool-active' : ''}`}
            aria-pressed={panel === 'decision'}
            onClick={() => togglePanel('decision')}
          >
            <span className="tool-icon">
              <Icon name="file" />
              {questions > 0 && <b>{questions}</b>}
            </span>
            <span>Decision board</span>
          </button>
          <button
            className={`meeting-tool ${panel === 'trace' ? 'tool-active' : ''}`}
            aria-pressed={panel === 'trace'}
            onClick={() => togglePanel('trace')}
            title="Tool calls and thinking"
          >
            <span className="tool-icon">
              <Icon name="trace" />
            </span>
            <span>Trace</span>
          </button>
          <button
            className={`meeting-tool ${view === 'whiteboard' ? 'tool-active' : ''}`}
            aria-pressed={view === 'whiteboard'}
            onClick={() => {
              setView(view === 'whiteboard' ? 'gallery' : 'whiteboard')
              if (view !== 'whiteboard') setPanel(null)
            }}
          >
            <span className="tool-icon">
              <Icon name="board" />
            </span>
            <span>Whiteboard</span>
          </button>
        </div>
        <div className="meeting-end">
          {running ? (
            <>
              <button
                className="conclude-button"
                onClick={() => void conclude()}
                disabled={s.concluding || chairWriting}
                title="Finish the current response, then write the decision"
              >
                {s.concluding || chairWriting ? 'Concluding…' : 'Conclude now'}
              </button>
              <button onClick={() => void stop()} disabled={stopping}>
                <Icon name="end" size={17} />
                {stopping ? 'Ending…' : 'End session'}
              </button>
            </>
          ) : (
            <>
              {!s.consortium && (
                <button className="return-sessions" onClick={onResume}>
                  <Icon name="play" size={16} />
                  Resume meeting
                </button>
              )}
              <button className="return-sessions" onClick={onHome}>
                <Icon name="back" size={16} />
                All sessions
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}
