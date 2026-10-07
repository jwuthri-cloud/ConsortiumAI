import { useState } from 'react'
import { CLI_META, HUMAN } from '@shared/types'
import { PERSONAS } from '@shared/personas'
import { latestVotes, type State } from './state'
import Markdown from './Markdown'

type Props = { state: State; onHome: () => void; onChamber: () => void }

export default function Consortium({ state: s, onHome, onChamber }: Props): React.JSX.Element {
  const { markdown, path } = s.consortium!
  const doc = markdown.split('\n---\n\n## Agreement matrix')[0]
  const members = s.brief!.members
  const votes = latestVotes(s.turns)
  const [copied, setCopied] = useState(false)
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN)
  const n = memberTurns.length
  const cost = memberTurns.reduce((a, t) => a + (t.costUsd ?? 0), 0)

  const cell = (a: string, b: string): { mark: string; cls: string } => {
    if (a === b) return { mark: '', cls: 'bg-surface-2' }
    const v = votes[a]
    if (!v) return { mark: '·', cls: 'text-ink-3' }
    if (v.disagreements.some((d) => d.with === s.labels[b])) return { mark: '✗', cls: 'text-red' }
    if (v.agrees_with.includes(s.labels[b])) return { mark: '✓', cls: 'text-gold' }
    return { mark: '·', cls: 'text-ink-3' }
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag h-12 shrink-0 flex items-center pl-20 pr-5 gap-5 border-b border-line text-[12px] text-ink-2">
        <button className="no-drag hover:text-ink" onClick={onHome}>
          ← All sessions
        </button>
        <button className="no-drag hover:text-ink" onClick={onChamber}>
          Back to the chamber
        </button>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {s.converged ? 'consensus' : 'dissent recorded'} · {n} turn{n === 1 ? '' : 's'}
        </span>
      </header>
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_320px]">
        <article className="overflow-y-auto px-16 py-12">
          <div className="max-w-[700px] mx-auto rise">
            <div className="flex items-center gap-4 mb-10">
              <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
                <circle
                  cx="28"
                  cy="28"
                  r="26"
                  fill="none"
                  stroke="var(--color-gold)"
                  strokeWidth="1.2"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="21"
                  fill="none"
                  stroke="var(--color-gold-2)"
                  strokeWidth="0.6"
                  strokeDasharray="2 3"
                />
                <text
                  x="28"
                  y="36"
                  textAnchor="middle"
                  fontSize="24"
                  fill="var(--color-gold)"
                  fontFamily="var(--font-display)"
                  fontWeight="300"
                >
                  C
                </text>
              </svg>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-gold">
                  {s.converged
                    ? `Consensus after ${n} turn${n === 1 ? '' : 's'}`
                    : `Decided with dissent · ${n} turn${n === 1 ? '' : 's'}`}
                </div>
                <div className="text-[12px] text-ink-3 mt-1">
                  {members.length} seats · chaired by {s.labels[s.brief!.chairId] ?? 'the chair'}
                </div>
              </div>
            </div>
            <Markdown text={doc} />
          </div>
        </article>

        <aside className="border-l border-line overflow-y-auto p-5 space-y-7 text-[13px]">
          <section>
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-ink-3 mb-3">Agreement</h3>
            <div
              className="grid gap-px"
              style={{ gridTemplateColumns: `72px repeat(${members.length}, 1fr)` }}
            >
              <span />
              {members.map((m) => (
                <span key={m.id} className="flex justify-center">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: CLI_META[m.cli].color }}
                    title={s.labels[m.id]}
                  />
                </span>
              ))}
              {members.map((a) => (
                <div key={a.id} className="contents">
                  <span className="text-[11px] text-ink-2 truncate pr-1" title={s.labels[a.id]}>
                    {s.labels[a.id].replace('The ', '')}
                  </span>
                  {members.map((b) => {
                    const c = cell(a.id, b.id)
                    return (
                      <span
                        key={b.id}
                        className={`h-7 flex items-center justify-center text-[13px] ${c.cls}`}
                      >
                        {c.mark}
                      </span>
                    )
                  })}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-ink-3 mt-2">
              Row ✓ agrees / ✗ disagrees with column, from the final votes.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-ink-3 mb-3">Panel</h3>
            <ul className="space-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: CLI_META[m.cli].color }}
                  />
                  <span className="font-display text-[14px]">{s.labels[m.id]}</span>
                  <span className="font-mono text-[11px] text-ink-3 ml-auto">
                    {CLI_META[m.cli].name}
                    {m.model ? ` · ${m.model}` : ''}
                    {m.id === s.brief!.chairId ? ' · chair' : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-ink-3 mt-3">
              {PERSONAS[members[0].persona] ? 'Personas were the only names the members knew.' : ''}
            </p>
          </section>

          <section>
            <h3 className="text-[11px] uppercase tracking-[0.18em] text-ink-3 mb-3">Document</h3>
            <p className="font-mono text-[11px] text-ink-2 break-all">{path}</p>
            {cost > 0 && (
              <p className="font-mono text-[11px] text-ink-3 mt-1">
                reported cost ${cost.toFixed(2)}
              </p>
            )}
            <div className="flex gap-2 mt-3">
              <button
                className="border border-line-2 rounded-full px-3 h-8 text-[12px] hover:border-gold hover:text-gold"
                onClick={() => {
                  void navigator.clipboard.writeText(markdown)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? 'Copied' : 'Copy markdown'}
              </button>
              <button
                className="border border-line-2 rounded-full px-3 h-8 text-[12px] hover:border-gold hover:text-gold"
                onClick={() => void window.api!.reveal(path)}
              >
                Reveal in Finder
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
