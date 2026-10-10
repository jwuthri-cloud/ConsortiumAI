import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TTS_MODEL, chunks, plain } from '../shared/voices'
import { getKey } from './keys'
import { humanError, track } from './cli'

// Seats speak through ElevenLabs on OpenRouter. OpenRouter returns a clip only once it is fully
// synthesized (no streaming), so a turn is read in sentence-sized pieces, two in flight.
// ponytail: ElevenLabs' own streaming API (~150 ms to first audio) is the swap if latency matters; it needs its own key.
export async function speak(voice: string, input: string, signal?: AbortSignal): Promise<Buffer> {
  const key = getKey('openrouter')
  if (!key) throw new Error('Voices need an OpenRouter key. Add one in Settings.')
  const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice, input, response_format: 'pcm' }), // 24 kHz s16le mono
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(60_000)])
  })
  if (!r.ok) throw new Error(`Voice: ${humanError(await r.text()) || r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// The bundled "give me a second" clips (scripts/voices.ts); outside the asar once packaged.
const FILLER_DIR = join(__dirname, '../../resources/voices').replace(
  'app.asar',
  'app.asar.unpacked'
)
export function filler(voice: string): Buffer | undefined {
  try {
    const files = readdirSync(join(FILLER_DIR, voice)).filter((f) => f.endsWith('.mp3'))
    return readFileSync(join(FILLER_DIR, voice, files[Math.floor(Math.random() * files.length)]))
  } catch {
    return undefined
  }
}

// Reads a turn's answer aloud; resolves with the PCM bytes sent (48,000 per second of audio).
// `key` lets killRun/killAll abort it with the rest of the meeting.
export async function readAloud(
  voice: string,
  text: string,
  key: string,
  onChunk: (pcm: Buffer, last: boolean) => void
): Promise<number> {
  const parts = chunks(plain(text))
  const ctrl = new AbortController()
  const untrack = track(key, ctrl)
  const jobs: Promise<Buffer>[] = []
  const start = (i: number): void => {
    if (i < parts.length && !jobs[i]) {
      jobs[i] = speak(voice, parts[i], ctrl.signal)
      jobs[i].catch(() => {}) // awaited in order below
    }
  }
  let bytes = 0
  try {
    for (let i = 0; i < parts.length; i++) {
      start(i)
      start(i + 1)
      const pcm = await jobs[i]
      bytes += pcm.length
      onChunk(pcm, i === parts.length - 1)
    }
    return bytes
  } finally {
    ctrl.abort() // a failed piece cancels the ones still in flight
    untrack()
  }
}
