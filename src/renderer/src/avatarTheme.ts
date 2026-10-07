import type { Cli } from '@shared/types'

export const PROVIDERS: Record<
  Cli,
  { name: string; color: string; suit: string; shell: string; ink: string }
> = {
  claude: {
    name: 'ANTHROPIC',
    color: '#e6ac89',
    suit: '#c98060',
    shell: '#f1ddc5',
    ink: '#402d2a'
  },
  codex: { name: 'OPENAI', color: '#a0d4c1', suit: '#e3e8dc', shell: '#ecf1e4', ink: '#163f37' },
  gemini: { name: 'GOOGLE', color: '#bdadf2', suit: '#9383cf', shell: '#dfddfa', ink: '#352957' },
  grok: { name: 'X.AI', color: '#c4d0e3', suit: '#353b4c', shell: '#cbd1e1', ink: '#1c2439' }
}
