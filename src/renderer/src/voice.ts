import type { DebateEvent } from '@shared/types'

// Plays the seats' voices: one queue, in arrival order, so only one seat talks at a time.
// The engine sends a filler clip (mp3) on the meeting's first turn and each answer as 24 kHz s16le PCM.
// Audio elements rather than Web Audio buffers: playbackRate on an element keeps the voice's pitch.
type VoiceEvent = Extract<DebateEvent, { type: 'voice' }>
type Clip = { e: VoiceEvent; url: string }

export const RATES = [1, 1.25, 1.5, 2] as const

let queue: Clip[] = []
let playing: { clip: Clip; el: HTMLAudioElement } | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
const samples = new Float32Array(1024)
const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((l) => l())

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* not remembered */
  }
}
let muted = stored('voices-muted') === '1'
let rate = Number(stored('voices-rate')) || 1

export const isMuted = (): boolean => muted
export function setMuted(on: boolean): void {
  muted = on
  store('voices-muted', on ? '1' : '0')
  if (on) stop()
}
export const getRate = (): number => rate
export function setRate(r: number): void {
  rate = r
  store('voices-rate', String(r))
  if (playing) playing.el.playbackRate = r
}

// 16-bit PCM → a WAV the element can play
function wav(pcm: Uint8Array): Blob {
  const h = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string): void =>
    [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)))
  tag(0, 'RIFF')
  h.setUint32(4, 36 + pcm.byteLength, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  h.setUint32(16, 16, true)
  h.setUint16(20, 1, true)
  h.setUint16(22, 1, true)
  h.setUint32(24, 24_000, true)
  h.setUint32(28, 48_000, true)
  h.setUint16(32, 2, true)
  h.setUint16(34, 16, true)
  tag(36, 'data')
  h.setUint32(40, pcm.byteLength, true)
  return new Blob([h.buffer, pcm.slice().buffer as ArrayBuffer], { type: 'audio/wav' })
}

const ack = (e: VoiceEvent): void => void window.api?.spoken(e.sessionId, e.turn).catch(() => {})

export function play(e: VoiceEvent, audible = true): void {
  if (muted || !audible) {
    if (e.last) ack(e) // a muted room runs at text pace
    return
  }
  const blob =
    e.format === 'pcm'
      ? wav(e.data)
      : new Blob([e.data.slice().buffer as ArrayBuffer], { type: 'audio/mpeg' })
  queue.push({ e, url: URL.createObjectURL(blob) })
  if (!playing) next()
}

function next(): void {
  const clip = queue.shift()
  const prev = playing?.clip.e.memberId
  playing = null
  if (!clip) return changed()
  const el = new Audio(clip.url)
  el.preservesPitch = true
  el.playbackRate = rate
  try {
    ctx ??= new AudioContext()
    if (!analyser) {
      analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.connect(ctx.destination)
    }
    ctx.createMediaElementSource(el).connect(analyser)
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    /* no meter: the element still plays on its own */
  }
  const done = (): void => {
    if (playing?.el !== el) return
    URL.revokeObjectURL(clip.url)
    if (clip.e.last) ack(clip.e)
    // a breath between seats, none between pieces of one answer
    const gap = queue[0] && queue[0].e.memberId !== clip.e.memberId ? 300 : 0
    if (gap) {
      playing = null
      changed()
      setTimeout(() => !playing && next(), gap)
    } else next()
  }
  el.onended = done
  el.onerror = done // undecodable audio must not hold the meeting
  playing = { clip, el }
  if (prev !== clip.e.memberId) changed()
  el.play().catch(done)
}

export function stop(): void {
  for (const c of queue) URL.revokeObjectURL(c.url)
  queue = []
  if (playing) {
    playing.el.onended = playing.el.onerror = null
    playing.el.pause()
    URL.revokeObjectURL(playing.clip.url)
    playing = null
  }
  changed()
}

// The member audibly talking right now, for the room to highlight; subscribe re-renders on change.
export const talking = (): string | undefined => playing?.clip.e.memberId
export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// 0..1 loudness of what this member is saying right now; 0 when someone else (or nobody) talks.
export function level(memberId: string): number {
  if (!analyser || talking() !== memberId) return 0
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (const v of samples) sum += v * v
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}
