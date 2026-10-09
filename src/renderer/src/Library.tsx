import { useState } from 'react'
import type { Session, SessionSummary } from '@shared/types'
import { PERSONAS } from '@shared/personas'
import { PROVIDERS } from './avatarTheme'
import { fmtTokens, fmtUsd, tokens } from '@shared/usage'

type Props = {
  sessions: SessionSummary[]
  onOpen: (session: Session) => void
  onContinue: (session: Session) => void
  onRerun: (session: Session, title: string) => void
  onProblem: (message: string) => void
  onDeleted: (id: string) => void
}

const STATUS: Record<SessionSummary['status'], string> = {
  done: 'Completed',
  running: 'In progress',
  stopped: 'Unfinished',
  failed: 'Failed'
}
const NO_PROJECT = '\0none'
const PAGE = 12
const folder = (p: string): string => p.split('/').pop() || p
const unfinished = (s: SessionSummary): boolean => s.status === 'stopped' || s.status === 'failed'

export default function Library({
  sessions,
  onOpen,
  onContinue,
  onRerun,
  onProblem,
  onDeleted
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('') // '' = all projects
  const [onlyUnfinished, setOnlyUnfinished] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const projects = [...new Set(sessions.flatMap((s) => (s.projectPath ? [s.projectPath] : [])))]
  const open = sessions.filter(unfinished).length
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = sessions.filter(
    (s) =>
      (!onlyUnfinished || unfinished(s)) &&
      (!project || (project === NO_PROJECT ? !s.projectPath : s.projectPath === project)) &&
      words.every((w) =>
        `${s.title} ${s.task} ${s.outcome ?? ''} ${s.projectPath ? folder(s.projectPath) : ''} ${s.files?.join(' ') ?? ''}`
          .toLowerCase()
          .includes(w)
      )
  )
  const load = (id: string, then: (s: Session) => void): void =>
    void window
      .api!.loadSession(id)
      .then((s) => (s ? then(s) : onProblem('This meeting could not be opened.')))
      .catch(() => onProblem('This meeting could not be opened.'))
  const remove = (x: SessionSummary): void => {
    if (
      !window.confirm(
        `Delete "${x.title}"? The transcript and its attachments are removed for good.`
      )
    )
      return
    void window
      .api!.deleteSession(x.id)
      .then(() => onDeleted(x.id))
      .catch(() => onProblem('This meeting could not be deleted. Stop it first if it is running.'))
  }
  const clear = (): void => {
    setQuery('')
    setProject('')
    setOnlyUnfinished(false)
  }

  return (
    <section className="recent-sessions">
      <div className="section-heading">
        <h2>Meeting library</h2>
        <span>
          {sessions.length ? `${sessions.length} saved` : 'Your decisions, kept together'}
        </span>
      </div>
      {sessions.length ? (
        <>
          <div className="library-toolbar">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, questions and outcomes"
              aria-label="Search meetings"
              spellCheck={false}
            />
            {projects.length > 0 && (
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {folder(p)}
                  </option>
                ))}
                <option value={NO_PROJECT}>No project</option>
              </select>
            )}
            {open > 0 && (
              <button
                className={`library-chip ${onlyUnfinished ? 'selected' : ''}`}
                aria-pressed={onlyUnfinished}
                onClick={() => setOnlyUnfinished(!onlyUnfinished)}
              >
                Unfinished <b>{open}</b>
              </button>
            )}
          </div>
          {shown.length ? (
            <div className="meeting-cards">
              {(showAll ? shown : shown.slice(0, PAGE)).map((x) => (
                <article key={x.id} className={`meeting-card ${x.status}`}>
                  <button
                    className="meeting-card-open"
                    onClick={() => load(x.id, onOpen)}
                    title={x.task}
                  >
                    <span className="meeting-card-top">
                      <span className={`session-status ${x.status}`}>{STATUS[x.status]}</span>
                      <span>
                        {x.status === 'done'
                          ? `${x.turn} turns`
                          : `Turn ${x.turn} of ${x.maxTurns}`}
                      </span>
                      {x.usage && (
                        <span
                          className="meeting-card-cost"
                          title={`${x.usage.input.toLocaleString()} prompt + ${x.usage.output.toLocaleString()} output tokens · API list-price equivalent`}
                        >
                          {fmtTokens(tokens(x.usage))} tokens · <b>{fmtUsd(x.usage)}</b>
                        </span>
                      )}
                      <time dateTime={x.createdAt}>
                        {new Date(x.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric'
                        })}
                      </time>
                    </span>
                    <strong className="meeting-card-title">{x.title}</strong>
                    <span className={`meeting-card-outcome ${x.outcome ? '' : 'empty'}`}>
                      {x.outcome ??
                        (x.status === 'done' ? 'No decision recorded.' : 'No common ground yet.')}
                    </span>
                  </button>
                  <div className="meeting-card-foot">
                    <span className="meeting-card-team">
                      {x.team.map((m, i) => (
                        <i
                          key={i}
                          style={{ '--seat-color': PROVIDERS[m.cli].color } as React.CSSProperties}
                          title={PERSONAS[m.persona].label}
                        >
                          {PERSONAS[m.persona].monogram}
                        </i>
                      ))}
                    </span>
                    <span
                      className={`meeting-card-project ${x.projectPath ? '' : 'none'}`}
                      title={x.projectPath ?? 'Ran without a project folder'}
                    >
                      ⌘ {x.projectPath ? folder(x.projectPath) : 'No folder'}
                    </span>
                    {x.files && (
                      <span className="meeting-card-files" title={x.files.join('\n')}>
                        {x.files.length} {x.files.length === 1 ? 'file' : 'files'}
                      </span>
                    )}
                    <span className="meeting-card-actions">
                      {x.status !== 'running' && (
                        <button
                          className="text-button delete-button"
                          onClick={() => remove(x)}
                          aria-label={`Delete ${x.title}`}
                        >
                          Delete
                        </button>
                      )}
                      <button
                        className="text-button"
                        onClick={() => load(x.id, (s) => onRerun(s, x.title))}
                      >
                        Run again with this team
                      </button>
                      {unfinished(x) && (
                        <button
                          className="secondary-button continue-button"
                          onClick={() => load(x.id, onContinue)}
                        >
                          Continue <span aria-hidden="true">→</span>
                        </button>
                      )}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="sessions-empty">
              No meetings match.{' '}
              <button className="text-button" onClick={clear}>
                Clear filters
              </button>
            </div>
          )}
          {!showAll && shown.length > PAGE && (
            <button className="text-button library-more" onClick={() => setShowAll(true)}>
              Show all {shown.length}
            </button>
          )}
        </>
      ) : (
        <div className="sessions-empty">
          Your first meeting starts here. The conversation and final decision will appear here
          afterward.
        </div>
      )}
    </section>
  )
}
