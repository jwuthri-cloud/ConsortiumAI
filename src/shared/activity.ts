import type { ActivityKind } from './types'

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  starting: 'Connecting',
  thinking: 'Preparing a response',
  reading: 'Reading files',
  searching: 'Searching for evidence',
  tool: 'Using a tool',
  reviewing: 'Reviewing results',
  responding: 'Responding'
}

export const ACTIVITY_HINTS: Record<ActivityKind, string> = {
  starting: 'Waiting for the agent to connect.',
  thinking: 'The agent is working on this turn. Its response will appear here.',
  reading: 'Checking source material for this turn.',
  searching: 'Looking for evidence relevant to the discussion.',
  tool: 'A tool is running. The response will follow its results.',
  reviewing: 'The tool finished; the agent is reviewing what it found.',
  responding: 'The response is arriving in the conversation.'
}
