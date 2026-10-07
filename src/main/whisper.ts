import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, parse } from 'node:path'

// Local speech-to-text with Whisper large-v3-turbo: mlx_whisper runs on the Apple GPU, openai-whisper is the CPU fallback.
const ENGINES: { bin: string; args: (file: string, out: string) => string[] }[] = [
  {
    bin: 'mlx_whisper',
    args: (f, out) => [
      f,
      '--model',
      'mlx-community/whisper-large-v3-turbo',
      '--output-format',
      'txt',
      '--output-dir',
      out
    ]
  },
  {
    bin: 'whisper',
    args: (f, out) => [
      f,
      '--model',
      'turbo',
      '--output_format',
      'txt',
      '--output_dir',
      out,
      '--fp16',
      'False'
    ]
  }
]

// launched from Finder the PATH is bare; whisper also needs ffmpeg on it to decode the recording
const PATH = [
  ...(process.env.PATH ?? '').split(':'),
  join(homedir(), '.pyenv', 'shims'),
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin'
]
  .filter(Boolean)
  .join(':')

export async function transcribe(file: string): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'consortium-stt-'))
  for (const e of ENGINES) {
    try {
      // the first run downloads the model (~1.6 GB), hence the long timeout
      await promisify(execFile)(e.bin, e.args(file, out), {
        env: { ...process.env, PATH },
        timeout: 15 * 60_000
      })
    } catch (err) {
      const x = err as { code?: string | number; stderr?: string }
      if (x.code === 'ENOENT' || x.code === 127) continue // not installed (127 = a pyenv shim without it)
      throw new Error(x.stderr?.trim().split('\n').pop() || `${e.bin} failed`)
    }
    return readFileSync(join(out, `${parse(file).name}.txt`), 'utf8').trim()
  }
  throw new Error('No local Whisper found. Install it with: pip install mlx-whisper')
}
