import { useId, useState } from 'react'
import type { BoardVisual as Visual, DiagramVisual, VisualItem } from '@shared/boardVisuals'
import { visualDiscussion } from '@shared/boardVisuals'

const STATUS = { proposed: 'Proposed', agreed: 'Shared ground', question: 'Open question' }
function lines(text: string, width = 23): string[] {
  const result: string[] = ['']
  for (const word of text
    .split(/\s+/)
    .flatMap((word) => word.match(new RegExp(`.{1,${width}}`, 'g')) ?? [])) {
    const last = result.length - 1
    if (result[last] && result[last].length + word.length + 1 > width) result.push(word)
    else result[last] += `${result[last] ? ' ' : ''}${word}`
  }
  return result
}
function Diagram({
  visual,
  selected,
  onSelect
}: {
  visual: DiagramVisual
  selected?: string
  onSelect: (item: VisualItem) => void
}): React.JSX.Element {
  const marker = useId().replace(/:/g, '')
  const [zoom, setZoom] = useState(1)
  const columns = [...new Set(visual.nodes.map((node) => node.column))].sort((a, b) => a - b)
  const count = Math.max(
    ...columns.map((column) => visual.nodes.filter((n) => n.column === column).length)
  )
  const width = columns.length * 250 + 32
  const height = Math.max(200, count * 128 + 56)
  const nodes = visual.nodes.map((node) => {
    const peers = visual.nodes.filter((n) => n.column === node.column)
    return {
      ...node,
      x: 32 + columns.indexOf(node.column) * 250,
      y: (height - peers.length * 128) / 2 + peers.findIndex((n) => n.id === node.id) * 128
    }
  })
  return (
    <>
      <div className="diagram-toolbar">
        <span>Click a node to explore or discuss it</span>
        <div aria-label="Diagram zoom">
          <button
            aria-label="Zoom out diagram"
            disabled={zoom <= 0.75}
            onClick={() => setZoom(Math.max(0.75, zoom - 0.25))}
          >
            −
          </button>
          <button aria-label="Reset diagram zoom" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button
            aria-label="Zoom in diagram"
            disabled={zoom >= 1.75}
            onClick={() => setZoom(Math.min(1.75, zoom + 0.25))}
          >
            +
          </button>
        </div>
      </div>
      <div className="diagram-scroll" tabIndex={0} aria-label="Scrollable diagram">
        <svg
          className="board-diagram"
          viewBox={`0 0 ${width} ${height}`}
          style={{ minWidth: width * 0.8 * zoom, width: width * zoom }}
          aria-label={visual.title}
          role="group"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#9c93b9" />
            </marker>
          </defs>
          {visual.edges.map((edge, i) => {
            const from = nodes.find((node) => node.id === edge.from)!
            const to = nodes.find((node) => node.id === edge.to)!
            const forward = to.x > from.x
            const same = to.x === from.x
            const startX = from.x + (forward || same ? 190 : 0),
              endX = to.x + (forward ? 0 : 190)
            const sy = from.y + 44,
              ey = to.y + 44
            const mid = same ? startX + 30 : (startX + endX) / 2
            const path =
              forward || same
                ? `M ${startX} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${endX} ${ey}`
                : `M ${startX} ${sy} C ${startX - 20} ${sy}, ${startX - 20} ${height - 15}, ${startX} ${height - 15} L ${endX} ${height - 15} Q ${endX + 20} ${height - 15}, ${endX + 20} ${ey} L ${endX} ${ey}`
            const lx = same ? mid + 8 : (startX + endX) / 2,
              ly = forward || same ? (sy + ey) / 2 - 12 : height - 22
            return (
              <g key={`${edge.from}-${edge.to}-${i}`}>
                <path d={path} className="diagram-edge" markerEnd={`url(#${marker})`} />
                <text x={lx} y={ly} className="diagram-edge-label" textAnchor="middle">
                  {lines(edge.label, 12).map((text, n) => (
                    <tspan key={n} x={lx} dy={n ? 13 : 0}>
                      {text}
                    </tspan>
                  ))}
                </text>
              </g>
            )
          })}
          {nodes.map((node) => (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}, ${STATUS[node.status]}`}
              aria-pressed={selected === node.id}
              onClick={() => onSelect(node)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(node)
                }
              }}
              className={`diagram-node ${node.status} ${selected === node.id ? 'selected' : ''}`}
              transform={`translate(${node.x}, ${node.y})`}
            >
              <rect width="190" height="88" rx={node.status === 'question' ? 24 : 12} />
              <circle cx="15" cy="17" r="3" />
              <text x="25" y="21" className="diagram-node-status">
                {STATUS[node.status]}
              </text>
              <text x="15" y="45" className="diagram-node-label">
                {lines(node.label)
                  .slice(0, 3)
                  .map((text, i) => (
                    <tspan key={i} x="15" dy={i ? 16 : 0}>
                      {text}
                    </tspan>
                  ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </>
  )
}

export default function BoardVisual({
  visual,
  revision,
  canDiscuss,
  onDiscuss,
  onSource
}: {
  visual: Visual
  revision: number
  canDiscuss: boolean
  onDiscuss: (text: string) => void
  onSource: (turn: number) => void
}): React.JSX.Element {
  const [selectedId, setSelected] = useState<string>()
  const items: VisualItem[] =
    visual.kind === 'diagram'
      ? visual.nodes
      : visual.kind === 'sequence'
        ? visual.steps
        : visual.rows.map((row) => ({
            id: row.id,
            label: row.label,
            detail: row.cells.map((cell, i) => `${visual.options[i]}: ${cell}`).join(' · '),
            sources: visual.sources,
            status: 'proposed'
          }))
  const selected = items.find((item) => item.id === selectedId)
  return (
    <article className="visual-sheet" aria-label={visual.title}>
      <header className="visual-title">
        <div>
          <span>
            {visual.kind === 'diagram'
              ? 'CONNECTED VIEW'
              : visual.kind === 'comparison'
                ? 'SIDE BY SIDE'
                : 'STEP BY STEP'}
          </span>
          <h3>{visual.title}</h3>
          <p>{visual.caption}</p>
        </div>
        <button
          className="visual-discuss"
          disabled={!canDiscuss}
          onClick={() => onDiscuss(visualDiscussion(visual, revision))}
        >
          Discuss this ↗
        </button>
      </header>
      {visual.kind === 'diagram' ? (
        <Diagram visual={visual} selected={selectedId} onSelect={(item) => setSelected(item.id)} />
      ) : visual.kind === 'comparison' ? (
        <div className="comparison-scroll">
          <table className="visual-comparison">
            <caption className="sr-only">
              {visual.title}. Select a criterion to discuss its tradeoffs.
            </caption>
            <thead>
              <tr>
                <th>What matters</th>
                {visual.options.map((option) => (
                  <th key={option}>{option}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visual.rows.map((row) => (
                <tr key={row.id} className={selectedId === row.id ? 'selected' : ''}>
                  <th>
                    <button
                      onClick={() => setSelected(row.id)}
                      aria-pressed={selectedId === row.id}
                    >
                      {row.label} ↗
                    </button>
                  </th>
                  {row.cells.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ol className="visual-sequence">
          {visual.steps.map((step, index) => (
            <li key={step.id}>
              <button
                className={`${step.status} ${selectedId === step.id ? 'selected' : ''}`}
                onClick={() => setSelected(step.id)}
                aria-pressed={selectedId === step.id}
              >
                <span className="sequence-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="sequence-body">
                  <small>{STATUS[step.status]}</small>
                  <strong>{step.label}</strong>
                  <span>{step.detail}</span>
                </span>
                <span>↗</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className={`visual-inspector ${selected ? 'has-selection' : ''}`} aria-live="polite">
        <div>
          <small>
            {selected
              ? `${STATUS[selected.status]} · selected element`
              : 'Grounded in the conversation'}
          </small>
          {selected && (
            <>
              <strong>{selected.label}</strong>
              <p>{selected.detail || 'No additional detail has been discussed yet.'}</p>
            </>
          )}
          <div className="board-sources">
            {(selected?.sources ?? visual.sources).map((n) => (
              <button key={n} onClick={() => onSource(n)}>
                Turn {n} ↗
              </button>
            ))}
          </div>
        </div>
        {selected && (
          <div className="visual-inspector-actions">
            <button
              className="visual-discuss"
              disabled={!canDiscuss}
              onClick={() => onDiscuss(visualDiscussion(visual, revision, selected))}
            >
              Ask the room about this ↗
            </button>
            <button onClick={() => setSelected(undefined)}>Clear selection</button>
          </div>
        )}
      </div>
    </article>
  )
}
