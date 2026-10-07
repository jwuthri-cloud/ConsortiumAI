import { useState, type CSSProperties, type ReactNode } from 'react'
import { HUMAN } from '@shared/types'
import type { BoardNote, Whiteboard } from '@shared/whiteboard'
import { latestVotes, type State, type TurnState } from './state'
import { PROVIDERS } from './avatarTheme'

type Props = {
  state: State
  onSource: (turn: number) => void
  onAnswer: (question: string) => void
  onConsortium: () => void
}

const plain = (text: string): string =>
  text
    .replace(/```[\s\S]*$/, '')
    .replace(/[#*>`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const clip = (text: string, max = 300): string =>
  text.length > max ? text.slice(0, max).replace(/\s\S*$/, '') + '…' : text
const name = (label: string): string => label.replace(/^The /, '')

// Where the table stands, beside the agents: each point opens the turns it came from.
export default function DecisionBoard({
  state: s,
  onSource,
  onAnswer,
  onConsortium
}: Props): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const members = s.brief!.members
  const votes = latestVotes(s.turns)
  const agree = members.filter((m) => votes[m.id] && !votes[m.id]!.disagreements.length).length
  const running = ['open', 'debate', 'converge', 'decide'].includes(s.stage)
  const canAnswer = running && s.chair.status !== 'running' && !s.concluding
  // ponytail: sessions saved before the whiteboard only have the clerk's uncited notes
  const board:
    Pick<Whiteboard, 'recommendation' | 'agreed' | 'disputed' | 'questions'> | undefined =
    s.whiteboard ??
    (s.shape
      ? {
          recommendation: '',
          agreed: s.shape.converging.map((c) => ({ id: c.point, text: c.point, sources: [] })),
          disputed: s.shape.open.map((o) => ({
            id: o.point,
            text: o.sides ? `${o.point} — ${o.sides}` : o.point,
            sources: []
          })),
          questions: []
        }
      : undefined)
  const recommendation =
    board?.recommendation && !/^no recommendation/i.test(board.recommendation)
      ? board.recommendation
      : ''
  const seat = (speaker: string): CSSProperties => {
    const m = members.find((x) => x.id === speaker)
    return { '--seat-color': m ? PROVIDERS[m.cli].color : '#c5b8ee' } as CSSProperties
  }
  const toggle = (key: string): void => setOpen(open === key ? null : key)

  const quote = (t: TurnState, i: number, aside?: ReactNode): React.JSX.Element => (
    <blockquote key={`${t.speaker}-${t.n}-${i}`} style={seat(t.speaker)}>
      <cite>
        {t.speaker === HUMAN ? 'You' : name(t.label)}
        {aside}
        <button onClick={() => onSource(t.n)} aria-label={`Open turn ${t.n} in the conversation`}>
          Turn {t.n} ↗
        </button>
      </cite>
      <p>{clip(plain(t.text)) || 'Still speaking…'}</p>
    </blockquote>
  )

  const point = (section: string, note: BoardNote, after?: ReactNode): React.JSX.Element => {
    const key = `${section}:${note.id}`
    const expanded = open === key
    const said = expanded ? s.turns.filter((t) => note.sources.includes(t.n) && t.text) : []
    return (
      <div className={`db-point ${expanded ? 'is-open' : ''}`} key={key}>
        <button className="db-toggle" aria-expanded={expanded} onClick={() => toggle(key)}>
          <span>{note.text}</span>
          <small>
            {expanded
              ? 'Hide'
              : note.sources.length
                ? `${note.sources.length > 1 ? 'Turns' : 'Turn'} ${note.sources.join(', ')}`
                : 'Why?'}
          </small>
        </button>
        {after}
        {expanded && (
          <div className="db-evidence">
            {said.length ? (
              said.map((t, i) => quote(t, i))
            ) : (
              <p className="decision-placeholder">No turn cited for this point yet.</p>
            )}
          </div>
        )}
      </div>
    )
  }

  const section = (
    cls: string,
    icon: string,
    title: string,
    notes: BoardNote[],
    empty: string,
    after?: (note: BoardNote) => ReactNode
  ): React.JSX.Element => (
    <section className={`decision-section ${cls}`}>
      <h3>
        <span>{icon}</span>
        {title}
        <span>{notes.length}</span>
      </h3>
      {notes.length ? (
        notes.map((n) => point(cls, n, after?.(n)))
      ) : (
        <p className="decision-placeholder">{empty}</p>
      )}
    </section>
  )

  return (
    <div className="meeting-decision">
      <div className="panel-intro">
        <span className="decision-draft">
          {s.consortium
            ? 'READY TO READ'
            : s.boardStatus === 'updating'
              ? 'UPDATING…'
              : s.whiteboard
                ? `LIVE · THROUGH TURN ${s.whiteboard.throughTurn} · ${s.whiteboard.model}`
                : 'TAKING SHAPE'}
        </span>
        <h2>Where things stand.</h2>
        <p>Click any point to see what was said.</p>
      </div>
      <section className="decision-section db-recommendation">
        <h3>
          <span>✓</span>Current recommendation
          <span title="Members without objections">
            {agree}/{members.length}
          </span>
        </h3>
        <div className={`db-point ${open === 'rec' ? 'is-open' : ''}`}>
          <button
            className="db-toggle db-headline"
            aria-expanded={open === 'rec'}
            onClick={() => toggle('rec')}
          >
            <span>{recommendation || 'Forming as the members speak…'}</span>
            <small>{open === 'rec' ? 'Hide' : 'Where each member stands'}</small>
          </button>
          <div
            className="alignment-segments"
            title={`${agree} of ${members.length} without objections`}
          >
            {members.map((m) => (
              <span
                key={m.id}
                className={votes[m.id] && !votes[m.id]!.disagreements.length ? 'agrees' : ''}
              />
            ))}
          </div>
          <p className="db-alignment">
            {agree} of {members.length} members without objections
          </p>
          {open === 'rec' && (
            <div className="db-evidence">
              {members.map((m) => {
                const v = votes[m.id]
                const last = s.turns.findLast((t) => t.speaker === m.id && t.status === 'done')
                const stance = !v
                  ? 'No position yet'
                  : v.disagreements.length
                    ? `Objects · ${v.disagreements.map((d) => d.on || name(d.with)).join('; ')}`
                    : `No objections · ${Math.round(v.confidence * 100)}%`
                return last ? (
                  quote(
                    { ...last, text: v?.position ?? last.text },
                    0,
                    <em className={v?.disagreements.length ? 'objects' : ''}>{stance}</em>
                  )
                ) : (
                  <blockquote key={m.id} style={seat(m.id)}>
                    <cite>
                      {name(s.labels[m.id])}
                      <em>{stance}</em>
                    </cite>
                  </blockquote>
                )
              })}
            </div>
          )}
        </div>
        {!!board?.agreed.length && (
          <>
            <h4>Agreed so far</h4>
            {board.agreed.map((n) => point('agreed', n))}
          </>
        )}
      </section>
      {section(
        'db-disputed',
        '↗',
        'Still disputed',
        board?.disputed ?? [],
        board ? 'Nothing contested in the latest notes.' : 'Disagreements will be kept here.'
      )}
      {section(
        'db-input',
        '?',
        'Needs your input',
        board?.questions ?? [],
        'Nothing needs you right now.',
        (n) =>
          canAnswer && (
            <button className="db-answer" onClick={() => onAnswer(n.text)}>
              Answer
            </button>
          )
      )}
      <div className="decision-panel-footer">
        <p>Good decisions keep the dissent.</p>
        <button disabled={!s.consortium} onClick={onConsortium}>
          {s.consortium ? 'Read the decision' : 'Decision in progress'}
          <span>↗</span>
        </button>
      </div>
    </div>
  )
}
