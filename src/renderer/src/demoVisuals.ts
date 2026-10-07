import type { BoardVisual } from '@shared/boardVisuals'

// Illustrative browser-only fixture, revealed as its source turns arrive.
export function demoVisuals(turn: number): BoardVisual[] {
  if (turn < 2) return []
  const visuals: BoardVisual[] = [
    {
      id: 'export-path',
      kind: 'diagram',
      title: 'A smaller path to export',
      caption:
        turn >= 6
          ? 'CSV is gaining support. API scope and delivery timing remain separate decisions.'
          : 'A proposal from the room, with the priority still unresolved.',
      sources: [1, 2],
      nodes: [
        {
          id: 'demand',
          label: 'Validate customer demand',
          detail:
            'The Strategist cites procurement demand; the Engineer questions whether it is documented.',
          status: 'question',
          column: 0,
          sources: [1, 2]
        },
        {
          id: 'csv',
          label: turn >= 6 ? 'Capped, async CSV' : 'Small CSV export',
          detail:
            turn >= 6
              ? 'The Engineer accepts CSV if capped and async, while protecting the billing rework.'
              : 'The Strategist proposes a small CSV download behind a feature flag.',
          status: turn >= 6 ? 'agreed' : 'proposed',
          column: 1,
          sources: turn >= 6 ? [1, 6] : [1]
        },
        {
          id: 'flag',
          label: 'Release behind a flag',
          detail: 'The proposed first release stays limited while the team tests demand.',
          status: 'proposed',
          column: 2,
          sources: [1]
        },
        {
          id: 'timing',
          label: 'When can this ship?',
          detail:
            'The Engineer wants the billing rework to retain priority. Scheduling is still under discussion.',
          status: 'question',
          column: 1,
          sources: [2]
        }
      ],
      edges: [
        { from: 'demand', to: 'csv', label: 'If validated' },
        { from: 'csv', to: 'flag', label: 'Limited release' },
        { from: 'timing', to: 'flag', label: 'Timing unresolved' }
      ]
    }
  ]
  if (turn >= 5)
    visuals.push({
      id: 'export-options',
      kind: 'comparison',
      title: 'CSV or an API?',
      caption: 'Compare the scope the members have actually discussed. Unknowns stay visible.',
      sources: [1, 2, 5],
      options: ['Small CSV export', 'Public JSON API'],
      rows: [
        {
          id: 'contract',
          label: 'Public contract',
          cells: [
            'A download; no new integration contract.',
            'A durable interface for integrators to depend on.'
          ]
        },
        {
          id: 'demand',
          label: 'Demand evidence',
          cells: [
            'Procurement demand claimed; validation contested.',
            'No named customer requirement established.'
          ]
        },
        {
          id: 'delivery',
          label: 'Delivery',
          cells: [
            turn >= 6
              ? 'Capped and asynchronous; protect billing priority.'
              : 'Proposed behind a feature flag.',
            'Keep as a separate decision.'
          ]
        }
      ]
    })
  if (turn >= 10)
    visuals.push({
      id: 'delivery-sequence',
      kind: 'sequence',
      title: 'A proposed order of work',
      caption: 'A sequence from the discussion, not an assigned delivery commitment.',
      sources: [6, 10],
      steps: [
        {
          id: 'billing',
          label: 'Finish the billing rework',
          detail: 'The Engineer asks to keep the current rework first.',
          status: 'proposed',
          sources: [6, 10]
        },
        {
          id: 'export',
          label: 'Ship capped async CSV',
          detail: 'Keep the release behind a flag and leave the JSON API out of this scope.',
          status: 'proposed',
          sources: [6]
        }
      ]
    })
  return visuals
}
