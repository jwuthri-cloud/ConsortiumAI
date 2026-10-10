import { HUMAN, type Member, type TraceStep } from '@shared/types'
import { PROVIDERS } from './avatarTheme'
import type { TurnState } from './state'

type Props = { turns: TurnState[]; members: Member[]; running: boolean }

// The Trace tab: what each member did behind its answer, newest turn first. Only the human sees it.
export default function Trace({ turns, members, running }: Props): React.JSX.Element {
  const shown = turns.filter((t) => t.speaker !== HUMAN).reverse()
  return (
    <>
      <div className="panel-intro">
        <h2>Behind the scenes</h2>
        <p>
          Each member&apos;s tool calls and thinking, as they happen. Only you see this; the other
          members never do.
        </p>
      </div>
      <div className="trace-feed" role="region" aria-label="Tool calls and thinking" tabIndex={0}>
        {!shown.length && <p className="trace-none">Nothing yet. Steps appear as members work.</p>}
        {shown.map((t) => {
          const m = members.find((x) => x.id === t.speaker)
          const tools = t.trace?.filter((x) => x.kind === 'tool').length ?? 0
          const live = running && t.status === 'running'
          return (
            <section key={`${t.speaker}-${t.n}`} className={`trace-turn ${live ? 'live' : ''}`}>
              <header>
                <i style={{ background: m ? PROVIDERS[m.cli].color : undefined }} />
                <strong>{t.label.replace(/^The /, '')}</strong>
                <span>
                  Turn {t.n}
                  {tools ? ` · ${tools} tool call${tools > 1 ? 's' : ''}` : ''}
                  {live ? ' · live' : ''}
                </span>
              </header>
              {t.trace?.length ? (
                <ol>
                  {t.trace.map((step, i) => (
                    <Step key={i} step={step} />
                  ))}
                </ol>
              ) : (
                <p className="trace-none">
                  {live ? 'Working…' : 'No tool calls or thinking shared for this turn.'}
                </p>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}

function Step({ step }: { step: TraceStep }): React.JSX.Element {
  if (step.kind === 'tool')
    return (
      <li className="trace-tool">
        <code>{step.name}</code>
        {step.detail && <span>{step.detail}</span>}
      </li>
    )
  if (!step.text)
    return (
      <li className="trace-thinking private">
        Thought{step.tokens ? ` for about ${step.tokens} tokens` : ''}. This CLI keeps the text
        private.
      </li>
    )
  return (
    <li className="trace-thinking">
      <details>
        <summary>
          <b>Thinking</b> {step.text.replace(/[*#]/g, '').slice(0, 90)}
        </summary>
        <p>{step.text}</p>
      </details>
    </li>
  )
}
