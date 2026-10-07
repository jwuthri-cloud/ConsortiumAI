import type { PersonaId } from './types'

export const PERSONAS: Record<PersonaId, { label: string; monogram: string; lens: string }> = {
  strategist: {
    label: 'The Strategist',
    monogram: 'S',
    lens: 'You weigh business value, positioning and sequencing. You ask what this does for the product in twelve months, and what it costs to be wrong.'
  },
  engineer: {
    label: 'The Engineer',
    monogram: 'E',
    lens: 'You weigh feasibility, complexity and maintenance, and what the codebase can actually bear. You distrust estimates and prefer small reversible steps.'
  },
  researcher: {
    label: 'The Researcher',
    monogram: 'R',
    lens: 'You bring evidence: prior art, data, what comparable products did and what happened. You separate what is known from what is assumed.'
  },
  designer: {
    label: 'The Designer',
    monogram: 'D',
    lens: "You argue from the user's experience: clarity, friction, what people will actually do. You defend simplicity against feature creep."
  },
  skeptic: {
    label: 'The Skeptic',
    monogram: 'K',
    lens: 'You challenge assumptions and look for the cheapest way this fails. You demand evidence before building. Constructive, never contrarian for its own sake.'
  },
  customer: {
    label: 'The Customer',
    monogram: 'C',
    lens: 'You speak for the people paying for the product: what they asked for, what they will notice, and what they would churn over.'
  }
}

export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[]

// Persona names are what members call each other; the same seat gets the same label in main and renderer.
export function makeLabels(members: { id: string; persona: PersonaId }[]): Record<string, string> {
  const seen: Record<string, number> = {}
  const labels: Record<string, string> = {}
  for (const m of members) {
    const base = PERSONAS[m.persona].label
    seen[base] = (seen[base] ?? 0) + 1
    labels[m.id] = seen[base] > 1 ? `${base} ${seen[base]}` : base
  }
  return labels
}
