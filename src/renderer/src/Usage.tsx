import { fmtTokens, fmtUsd, sumUsage, tokens, type Usage } from '@shared/usage'
import type { State } from './state'

const NOTE =
  'API list-price equivalent. Your CLI subscriptions are not billed per token; this is what the same calls would cost on the API.'

// Usage arrives when a call finishes. Until then, count what is streaming at ~4 characters a token.
// ponytail: rough for code and non-English text; it is replaced by the real count within the turn.
function streaming(s: State, id?: string): number {
  const chars =
    s.turns
      .filter((t) => t.status === 'running' && (!id || t.speaker === id))
      .reduce((n, t) => n + t.text.length, 0) +
    (s.chair.status === 'running' && (!id || id === s.brief?.chairId) ? s.chair.text.length : 0)
  return Math.round(chars / 4)
}

function Tokens({ u, live }: { u?: Usage; live: number }): React.JSX.Element {
  return (
    <>
      {live ? '~' : ''}
      {fmtTokens(tokens(u) + live)}
    </>
  )
}

// The meeting's running total; opens a breakdown by agent.
export function UsageMeter({ s }: { s: State }): React.JSX.Element {
  const members = s.brief?.members ?? []
  const rows: [string, Usage | undefined][] = [
    ...members.map((m): [string, Usage | undefined] => [s.labels[m.id] ?? m.id, s.usage[m.id]]),
    ...(s.usage.whiteboard ? [['Whiteboard notes', s.usage.whiteboard] as [string, Usage]] : []),
    ...(s.usage.chair ? [['Final decision', s.usage.chair] as [string, Usage]] : [])
  ]
  const total = sumUsage(Object.values(s.usage))
  const unpriced = Object.values(s.usage).some((u) => u.costUsd === undefined)
  return (
    <details className="usage-meter">
      <summary title="Tokens and cost so far · click for each agent">
        <span>
          <Tokens u={total} live={streaming(s)} /> tokens
        </span>
        <b>{fmtUsd(total)}</b>
      </summary>
      <div className="usage-pop">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, u]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{fmtTokens(tokens(u))}</td>
                <td>{fmtUsd(u)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{fmtTokens(tokens(total))}</td>
              <td>{fmtUsd(total)}</td>
            </tr>
          </tfoot>
        </table>
        <p>
          {NOTE}
          {total?.estimated &&
            ' ≈ marks estimates from list prices; Claude Code reports its own cost.'}
          {unpriced && ' Some models have no price yet, so the total leaves them out.'}
        </p>
      </div>
    </details>
  )
}

// One agent's spend, on its tile.
export function AgentUsage({ s, id }: { s: State; id: string }): React.JSX.Element {
  const own = s.usage[id]
  const chair = id === s.brief?.chairId ? s.usage.chair : undefined
  const all = sumUsage([own, chair])
  const turns = s.turns.filter((t) => t.speaker === id && t.status === 'done').length
  return (
    <details className="agent-usage">
      <summary aria-label={`Tokens and cost for ${s.labels[id] ?? id}`}>
        <Tokens u={all} live={streaming(s, id)} /> tokens · {fmtUsd(all)}
      </summary>
      <dl className="usage-pop">
        <dt>Prompt tokens</dt>
        <dd>{fmtTokens(own?.input ?? 0)}</dd>
        <dt>of which cached</dt>
        <dd>{fmtTokens(own?.cached ?? 0)}</dd>
        <dt>Output tokens</dt>
        <dd>{fmtTokens(own?.output ?? 0)}</dd>
        <dt>Cost · {turns} turns</dt>
        <dd>{fmtUsd(own)}</dd>
        {chair && (
          <>
            <dt>Writing the decision</dt>
            <dd>{fmtUsd(chair)}</dd>
          </>
        )}
      </dl>
    </details>
  )
}
