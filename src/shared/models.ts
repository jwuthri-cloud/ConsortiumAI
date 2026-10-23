import type { Cli, Member } from './types'

// Display only. Never alter the model argument sent to a CLI.
export function modelName(value?: string): string | undefined {
  if (!value) return undefined
  const name = value
    .trim()
    .replace(/^[a-z]+:/, '') // harness: "openrouter:anthropic/claude-opus-5.5"
    .replace(/^[\w.-]+\//, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\((?:thinking|reasoning|effort|budget|context)[^)]*\)/gi, '')
    .replace(/\s+(?:[·|,]\s*)?(?:thinking|reasoning|effort|budget)\b.*$/i, '')
    .replace(
      /\s+(?:\((?:low|medium|high|xhigh|max|ultra)\)|(?:low|medium|high|xhigh|max|ultra))$/i,
      ''
    )
    .trim()
  if (
    !name ||
    /^(?:default|cli default|auto(?:-.*)?|opus|sonnet|haiku|fable|pro|flash)$/i.test(name)
  )
    return undefined
  return name
}

export function memberModel(member: Pick<Member, 'model' | 'resolvedModel'>): string | undefined {
  return modelName(member.resolvedModel) ?? modelName(member.model)
}

// a new seat's model; the app and the API use the same; the Deep-agent has none, you pick a provider and model
export const DEFAULT_MODEL: Partial<Record<Cli, string>> = {
  claude: 'claude-opus-5-5',
  codex: 'gpt-6.1-sol',
  gemini: 'gemini-3.8-flash',
  grok: 'grok-4.7'
}
