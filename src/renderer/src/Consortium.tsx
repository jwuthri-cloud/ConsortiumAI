import { memberModel } from '@shared/models'
import Brand, { BrandMark } from './Brand'
import { useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { CLI_META, HUMAN } from '@shared/types'
import { PERSONAS } from '@shared/personas'
import { CITE, spoken, stripCites } from '@shared/cite'
import { latestVotes, type State, type TurnState } from './state'
import Markdown from './Markdown'

type Props = { state: State; onHome: () => void; onChamber: (turn?: number) => void }

export default function Consortium({ state: s, onHome, onChamber }: Props): React.JSX.Element {
  const { markdown, path } = s.consortium!
  const doc = markdown.split('\n---\n\n## Agreement matrix')[0]
  const members = s.brief!.members
  const votes = latestVotes(s.turns)
  const brief = s.brief!
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN)
  const n = memberTurns.length
  const cost = memberTurns.reduce((a, t) => a + (t.costUsd ?? 0), 0)
  const byN = new Map(memberTurns.filter((t) => t.text).map((t) => [t.n, t]))
  const pop = useRef<HTMLDivElement>(null)
  const [source, setSource] = useState<TurnState | null>(null)
  const [copied, setCopied] = useState<'summary' | 'document' | null>(null)

  // title, then the recommendation (older documents call it "Decision"), then everything else
  const [head, ...sections] = `\n${doc}`.split(/\n(?=## )/)
  const at = sections.findIndex((x) => /^## (Recommendation|Decision)\b/.test(x))
  const heading = at < 0 ? '' : sections[at].match(/^## (.*)/)![1]
  const summary = at < 0 ? '' : sections[at].replace(/^.*(\n|$)/, '').trim()
  const rest = sections.filter((_, i) => i !== at).join('\n')
  const title = head.match(/^# (.+)$/m)?.[1]

  const copy = (what: 'summary' | 'document', text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  // `src/x.ts:42` → the file, resolved against the project or an attachment
  const fileOf = (ref: string): string | undefined => {
    if (!/^[\w./@-]+\.\w+(:\d+(-\d+)?)?$/.test(ref)) return undefined
    const p = ref.replace(/:[\d-]+$/, '').replace(/^\.\//, '')
    return (
      brief.attachments?.find((a) => a.endsWith('/' + p)) ??
      (p.startsWith('/')
        ? p
        : brief.projectPath && p.includes('/')
          ? `${brief.projectPath}/${p}`
          : undefined)
    )
  }
  // [T3, T7] → links the components below turn into chips; unknown turns stay plain text
  const cites = (md: string): string =>
    md.replace(CITE, (all, list: string) => {
      const ok = list
        .split(',')
        .map((t) => t.trim())
        .filter((t) => byN.has(Number(t.slice(1))))
      return ok.length ? ok.map((t) => `[${t}](#${t})`).join(' ') : all
    })
  const components: Components = {
    a: ({ href, children }) => {
      const t = href?.startsWith('#T') ? byN.get(Number(href.slice(2))) : undefined
      if (!t) return <a href={href}>{children}</a>
      return (
        <button
          className="cite"
          title={`${t.label} · turn ${t.n}`}
          onClick={() => {
            setSource(t)
            if (!pop.current?.matches(':popover-open')) pop.current?.showPopover()
          }}
        >
          {children}
        </button>
      )
    },
    code: ({ className, children }) => {
      const file = !className && typeof children === 'string' ? fileOf(children) : undefined
      if (!file) return <code className={className}>{children}</code>
      return (
        <button
          className="cite file-cite"
          title={`Show ${file} in Finder`}
          onClick={() => void window.api!.reveal(file)}
        >
          <code>{children}</code>
        </button>
      )
    }
  }
  const sourceCli = members.find((m) => m.id === source?.speaker)?.cli

  const cell = (a: string, b: string): { mark: string; cls: string } => {
    if (a === b) return { mark: '', cls: 'bg-surface-2' }
    const v = votes[a]
    if (!v) return { mark: '·', cls: 'text-ink-3' }
    if (v.disagreements.some((d) => d.with === s.labels[b])) return { mark: '✗', cls: 'text-red' }
    if (v.agrees_with.includes(s.labels[b])) return { mark: '✓', cls: 'text-gold' }
    return { mark: '·', cls: 'text-ink-3' }
  }

  return (
    <div className="decision-page app-page h-full flex flex-col">
      <header className="app-titlebar drag">
        <Brand />
        <span className="titlebar-slash">/</span>
        <button className="no-drag text-button" onClick={onHome}>
          ← All sessions
        </button>
        <button className="no-drag secondary-button" onClick={() => onChamber()}>
          Meeting room
        </button>
        <span className="ml-auto font-mono text-[11px] text-ink-3">
          {s.converged ? 'consensus' : 'dissent recorded'} · {n} turn{n === 1 ? '' : 's'}
        </span>
      </header>
      <div className="decision-layout">
        <article className="decision-article">
          <div className="decision-paper rise">
            <div className="flex items-center gap-4 mb-10">
              <span className="decision-seal">
                <BrandMark size={36} />
              </span>
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-gold">
                  {s.converged
                    ? `Consensus after ${n} turn${n === 1 ? '' : 's'}`
                    : `Decided with dissent · ${n} turn${n === 1 ? '' : 's'}`}
                </div>
                <div className="text-[12px] text-ink-3 mt-1">
                  {members.length} seats · chaired by {s.labels[brief.chairId] ?? 'the chair'}
                </div>
              </div>
            </div>
            {head.trim() && <Markdown text={head} />}
            {summary && (
              <section className="decision-summary" aria-label={heading}>
                <h2>{heading}</h2>
                <Markdown text={cites(summary)} components={components} />
              </section>
            )}
            <div className="decision-copy">
              {summary && (
                <button
                  className="secondary-button"
                  onClick={() =>
                    copy('summary', `${title ? `${title}\n\n` : ''}${stripCites(summary)}`)
                  }
                >
                  {copied === 'summary' ? 'Copied' : 'Copy summary'}
                </button>
              )}
              <button className="secondary-button" onClick={() => copy('document', markdown)}>
                {copied === 'document' ? 'Copied' : 'Copy full document'}
              </button>
            </div>
            <Markdown text={cites(rest)} components={components} />
          </div>
        </article>

        <div ref={pop} popover="auto" className="source-popover">
          {source && (
            <>
              <header>
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: sourceCli && CLI_META[sourceCli].color }}
                />
                <strong>{source.label}</strong>
                <span>Turn {source.n}</span>
                <button className="text-button ml-auto" onClick={() => pop.current?.hidePopover()}>
                  Close
                </button>
              </header>
              <Markdown text={spoken(source.text)} className="compact" />
              <button className="secondary-button mt-3" onClick={() => onChamber(source.n)}>
                Show in meeting room
              </button>
            </>
          )}
        </div>

        <aside className="decision-sidebar">
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
                <li key={m.id} className="decision-member">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: CLI_META[m.cli].color }}
                  />
                  <span className="font-display text-[14px]">{s.labels[m.id]}</span>
                  <span className="decision-member-model">
                    {CLI_META[m.cli].name}
                    {` · ${memberModel(m) ?? 'Model not recorded'}`}
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
              <button className="secondary-button" onClick={() => void window.api!.reveal(path)}>
                Reveal in Finder
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
