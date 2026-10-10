// Generates the filler clips bundled with the app: resources/voices/<voice>/<n>.mp3.
// Needs OPENROUTER_API_KEY. Existing files are kept, so a re-run only fills gaps.
//   npx tsx scripts/voices.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILLERS, TTS_MODEL, VOICES } from '../src/shared/voices'

const key = process.env.OPENROUTER_API_KEY
if (!key) throw new Error('Set OPENROUTER_API_KEY')
const root = join(__dirname, '..', 'resources', 'voices')

async function clip(voice: string, input: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice, input, response_format: 'mp3' })
    })
    if (r.ok) return Buffer.from(await r.arrayBuffer())
    if (attempt >= 4 || r.status < 429) throw new Error(`${voice}: ${r.status} ${await r.text()}`)
    await new Promise((res) => setTimeout(res, 2000 * attempt))
  }
}

const jobs = VOICES.flatMap((voice) =>
  FILLERS.map((text, n) => ({ voice, text, file: join(root, voice, `${n}.mp3`) }))
).filter((j) => !existsSync(j.file))

let done = 0
async function worker(): Promise<void> {
  for (let j = jobs.shift(); j; j = jobs.shift()) {
    mkdirSync(join(root, j.voice), { recursive: true })
    writeFileSync(j.file, await clip(j.voice, j.text))
    console.log(`${++done} ${j.voice}/${j.file.split('/').pop()}`)
  }
}
Promise.all(Array.from({ length: 6 }, worker)).then(
  () => console.log('done'),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
