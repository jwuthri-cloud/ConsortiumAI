import { useEffect, useRef, useState } from 'react'
import { CLI_META, HUMAN } from '@shared/types'
import { PERSONAS } from '@shared/personas'
import { lastTurnOf, latestVotes, type State, type TurnState } from './state'
import Markdown from './Markdown'

type Props = { state: State; onHome: () => void; onConsortium: () => void }

const VW = 1000
const VH = 610
const CX = 500
const CY = 335
const TABLE_R = 150
const SEAT_R = 232

// Seats fan across the far side of the table; the human sits at the bottom.
function seatGeometry(n: number): { x: number; y: number; cos: number; sin: number }[] {
  const step = 240 / (n + 1)
  return Array.from({ length: n }, (_, i) => {
    const t = ((150 + step * (i + 1)) * Math.PI) / 180
    return {
      x: CX + SEAT_R * Math.cos(t),
      y: CY + SEAT_R * Math.sin(t),
      cos: Math.cos(t),
      sin: Math.sin(t)
    }
  })
}

function useFit(ratio: number): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect
      const w = Math.min(width, height * ratio)
      setBox({ w, h: w / ratio })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])
  return [ref, box]
}

const plain = (t: string): string =>
  t
    .replace(/```[\s\S]*$/, '')
    .replace(/[#*>`_]/g, '')
    .trim()
const tail = (t: string, n = 150): string => {
  const c = plain(t)
  return c.length > n ? '…' + c.slice(-n) : c
}

// Some models think silently for a while before their first word (gemini emits no thinking events).
const thinking = (t: TurnState, now: number): string =>
  `Thinking${t.startedAt ? ` · ${Math.max(0, Math.round((now - t.startedAt) / 1000))}s` : ''}`

function bubble(
  t: TurnState | undefined,
  now: number
): { text: string; kind: 'wait' | 'live' | 'pos' | 'err' } {
  if (!t) return { text: 'Waiting to speak', kind: 'wait' }
  if (t.status === 'error')
    return { text: (t.error ?? 'No response').replace(/\s+/g, ' ').slice(0, 140), kind: 'err' }
  if (t.status === 'running')
    return t.text.trim()
      ? { text: tail(t.text), kind: 'live' }
      : { text: thinking(t, now), kind: 'wait' }
  if (t.vote) return { text: t.vote.position, kind: 'pos' }
  return { text: plain(t.text).slice(0, 160), kind: 'pos' }
}

const STAGES = ['Explore', 'Debate', 'Converge', 'Decide']
const stageIndex = (s: State['stage']): number =>
  s === 'open' ? 0 : s === 'debate' ? 1 : s === 'converge' ? 2 : 3

export default function Chamber({ state: s, onHome, onConsortium }: Props): React.JSX.Element {
  const brief = s.brief!
  const members = brief.members
  const n = members.length
  const [filter, setFilter] = useState<string | null>(null)
  const [thought, setThought] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const ticking = !!s.speaking
  useEffect(() => {
    if (!ticking) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  const feedRef = useRef<HTMLDivElement | null>(null)
  const [fitRef, box] = useFit(VW / VH)

  const running =
    s.stage === 'open' || s.stage === 'debate' || s.stage === 'converge' || s.stage === 'decide'
  const decided = s.stage === 'done'
  const votes = latestVotes(s.turns)
  const agree = members.filter((m) => votes[m.id] && votes[m.id]!.disagreements.length === 0).length
  const pastOpenings = s.turn > n
  const fraction = decided && s.converged ? 1 : pastOpenings || decided ? agree / n : 0
  const geo = seatGeometry(n)
  const color = (id: string): string =>
    id === HUMAN ? 'var(--color-gold)' : CLI_META[members.find((m) => m.id === id)!.cli].color
  const chairLabel = s.labels[brief.chairId]
  const memberTurns = s.turns.filter((t) => t.speaker !== HUMAN).length

  const chords: { a: number; b: number; on: string }[] = []
  const seen = new Set<string>()
  members.forEach((a, i) => {
    for (const d of votes[a.id]?.disagreements ?? []) {
      const j = members.findIndex((x) => s.labels[x.id] === d.with)
      if (j < 0 || j === i) continue
      const key = [i, j].sort().join(':')
      if (seen.has(key)) continue
      seen.add(key)
      chords.push({ a: i, b: j, on: d.on })
    }
  })
  const circ = 2 * Math.PI * TABLE_R
  const scale = box.w / VW

  // the floor follows the conversation unless you scrolled up to read
  useEffect(() => {
    const el = feedRef.current
    if (el && stick) el.scrollTop = el.scrollHeight
  }, [s.turns, s.chair.text, stick])

  const interject = (e: React.FormEvent): void => {
    e.preventDefault()
    const t = thought.trim()
    if (!t) return
    void window.api!.interject(t)
    setToast(
      s.chair.status === 'running' ? 'Handed to the chair' : 'Heard — lands on the next turn'
    )
    setThought('')
    setTimeout(() => setToast(null), 2200)
  }

  const feed = filter ? s.turns.filter((t) => t.speaker === filter || t.speaker === HUMAN) : s.turns

  return (
    <div className="h-full grid grid-cols-[232px_minmax(0,1fr)_300px]">
      {/* seats */}
      <aside className="border-r border-line flex flex-col min-h-0">
        <div className="drag h-12 shrink-0 flex items-center pl-20 text-[11px] uppercase tracking-[0.18em] text-ink-3">
          Chamber
        </div>
        <button
          className="no-drag text-left px-5 py-1 text-[12px] text-ink-3 hover:text-ink"
          onClick={onHome}
        >
          ← All sessions
        </button>
        <div className="px-5 pt-3 pb-4">
          <div className="text-[10px] uppercase tracking-[0.16em] text-gold-2">Current session</div>
          <div className="font-display text-[15px] leading-snug mt-1 line-clamp-3">
            {brief.task}
          </div>
          <div className="text-[11px] text-ink-3 mt-1.5 font-mono">
            {n} seats ·{' '}
            {s.chair.status === 'running'
              ? 'deciding'
              : decided
                ? 'decided'
                : `turn ${s.turn} of ${brief.maxTurns}`}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {members.map((m) => {
            const last = lastTurnOf(s.turns, m.id)
            const v = votes[m.id]
            const speaking = s.speaking === m.id
            const spoke = s.turns.filter((t) => t.speaker === m.id && t.status === 'done').length
            return (
              <button
                key={m.id}
                onClick={() => setFilter(filter === m.id ? null : m.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 flex gap-3 hover:bg-surface transition ${filter === m.id ? 'bg-surface' : ''}`}
              >
                <span className="relative mt-1 w-2.5 h-2.5 shrink-0">
                  <span
                    className="absolute inset-0 rounded-full"
                    style={{ background: CLI_META[m.cli].color }}
                  />
                  {speaking && (
                    <span
                      className="absolute inset-0 rounded-full pulse"
                      style={{ background: CLI_META[m.cli].color }}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-display text-[14px] truncate">{s.labels[m.id]}</span>
                    {m.id === brief.chairId && (
                      <span className="text-[9px] uppercase tracking-[0.14em] text-gold-2">
                        chair
                      </span>
                    )}
                  </span>
                  <span className="block font-mono text-[10.5px] text-ink-3 truncate">
                    {CLI_META[m.cli].name}
                    {m.model ? ` · ${m.model}` : ''}
                  </span>
                  <span className="block mt-1.5 h-px bg-line relative">
                    <span
                      className="absolute inset-y-0 left-0 bg-gold transition-all duration-700"
                      style={{ width: `${(v?.confidence ?? 0) * 100}%` }}
                    />
                  </span>
                  <span className="block text-[10.5px] text-ink-3 mt-1">
                    {speaking ? (
                      'speaking'
                    ) : last?.status === 'error' ? (
                      <span className="text-red">no response</span>
                    ) : v ? (
                      `confidence ${Math.round(v.confidence * 100)}% · ${spoke} turn${spoke === 1 ? '' : 's'}`
                    ) : (
                      'waiting'
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div
          className="px-5 py-3 border-t border-line text-[11px] text-ink-3 truncate"
          title={brief.projectPath}
        >
          {brief.projectPath
            ? `Read-only · ${brief.projectPath.split('/').pop()}`
            : 'No project attached'}
        </div>
      </aside>

      {/* the table and the floor */}
      <main className="relative flex flex-col min-w-0 min-h-0">
        <header className="drag h-12 shrink-0 flex items-center justify-center gap-6 text-[12px]">
          {STAGES.map((label, i) => {
            const idx = stageIndex(s.stage)
            return (
              <span key={label} className="flex items-center gap-6">
                <span className={i === idx ? 'text-ink' : i < idx ? 'text-ink-2' : 'text-ink-3'}>
                  {label}
                  {i === idx && running && <span className="cursor" />}
                </span>
                {i < 3 && <span className="w-8 h-px bg-line" />}
              </span>
            )
          })}
        </header>
        <h1 className="font-display font-light text-[21px] leading-tight text-center px-14 line-clamp-2">
          {brief.task}
        </h1>

        <div
          ref={fitRef}
          className="basis-[44%] shrink-0 min-h-[220px] flex items-center justify-center px-6 py-1"
        >
          <div className="relative" style={{ width: box.w, height: box.h }}>
            <svg
              viewBox={`0 0 ${VW} ${VH}`}
              className="absolute inset-0 w-full h-full overflow-visible"
            >
              <circle
                cx={CX}
                cy={CY}
                r={SEAT_R}
                fill="none"
                stroke="var(--color-line)"
                strokeWidth="1"
                strokeDasharray="2 7"
                opacity="0.6"
              />
              <circle
                cx={CX}
                cy={CY}
                r={TABLE_R}
                fill="var(--color-surface)"
                stroke="var(--color-line-2)"
                strokeWidth="1"
              />
              <circle
                cx={CX}
                cy={CY}
                r={TABLE_R - 14}
                fill="none"
                stroke="var(--color-line)"
                strokeWidth="1"
              />
              <circle
                className="ring"
                cx={CX}
                cy={CY}
                r={TABLE_R}
                fill="none"
                stroke="var(--color-gold)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={circ * (1 - fraction)}
                transform={`rotate(-90 ${CX} ${CY})`}
              />
              {chords.map((c) => (
                <path
                  key={`${c.a}-${c.b}`}
                  d={`M ${geo[c.a].x} ${geo[c.a].y} Q ${CX} ${CY} ${geo[c.b].x} ${geo[c.b].y}`}
                  fill="none"
                  stroke="var(--color-red)"
                  strokeWidth="1.5"
                  strokeDasharray="6 5"
                  opacity="0.8"
                >
                  <title>{c.on}</title>
                </path>
              ))}
              <text
                x={CX}
                y={CY - 4}
                textAnchor="middle"
                fontSize="32"
                fontFamily="var(--font-display)"
                fontWeight="300"
                fill={decided && s.converged ? 'var(--color-gold)' : 'var(--color-ink)'}
              >
                {decided && s.converged ? 'C' : `${agree}/${n}`}
              </text>
              <text
                x={CX}
                y={CY + 18}
                textAnchor="middle"
                fontSize="10"
                fill="var(--color-ink-3)"
                letterSpacing="2"
              >
                {decided
                  ? s.converged
                    ? 'CONSENSUS'
                    : 'DISSENT RECORDED'
                  : pastOpenings
                    ? 'AGREE'
                    : 'OPENING'}
              </text>
              {members.map((m, i) => {
                const g = geo[i]
                const last = lastTurnOf(s.turns, m.id)
                const speaking = s.speaking === m.id
                const c = CLI_META[m.cli].color
                return (
                  <g
                    key={m.id}
                    onClick={() => setFilter(filter === m.id ? null : m.id)}
                    className="cursor-pointer"
                  >
                    {speaking && (
                      <circle
                        className="pulse"
                        cx={g.x}
                        cy={g.y}
                        r={28}
                        fill="none"
                        stroke={c}
                        strokeWidth="1.5"
                      />
                    )}
                    <circle
                      cx={g.x}
                      cy={g.y}
                      r={26}
                      fill={c}
                      fillOpacity={filter && filter !== m.id ? 0.06 : 0.16}
                      stroke={c}
                      strokeWidth={last?.status === 'error' ? 0 : 1.5}
                    />
                    {last?.status === 'error' && (
                      <circle
                        cx={g.x}
                        cy={g.y}
                        r={26}
                        fill="none"
                        stroke="var(--color-red)"
                        strokeWidth="1.5"
                        strokeDasharray="3 3"
                      />
                    )}
                    <text
                      x={g.x}
                      y={g.y + 8}
                      textAnchor="middle"
                      fontSize="22"
                      fontFamily="var(--font-display)"
                      fill={c}
                    >
                      {PERSONAS[m.persona].monogram}
                    </text>
                    {m.id === brief.chairId && (
                      <circle cx={g.x + 20} cy={g.y - 20} r={4} fill="var(--color-gold)" />
                    )}
                    <text
                      x={g.x}
                      y={g.y + 44}
                      textAnchor="middle"
                      fontSize="11"
                      fill="var(--color-ink-2)"
                      fontFamily="var(--font-sans)"
                    >
                      {s.labels[m.id]}
                    </text>
                  </g>
                )
              })}
              <rect
                x={CX - 28}
                y={CY + TABLE_R + 16}
                width="56"
                height="22"
                rx="11"
                fill="var(--color-surface)"
                stroke="var(--color-line-2)"
              />
              <text
                x={CX}
                y={CY + TABLE_R + 31}
                textAnchor="middle"
                fontSize="10"
                fill="var(--color-ink-3)"
                fontFamily="var(--font-sans)"
                letterSpacing="1.5"
              >
                YOU
              </text>
            </svg>
            {scale > 0 &&
              members.map((m, i) => {
                const g = geo[i]
                const b = bubble(lastTurnOf(s.turns, m.id), now)
                const bx = CX + (SEAT_R + 40) * g.cos
                const by = CY + (SEAT_R + 40) * g.sin
                return (
                  <button
                    key={m.id}
                    onClick={() => setFilter(filter === m.id ? null : m.id)}
                    className={`absolute text-left rounded-xl border px-2.5 py-1.5 w-[190px] bg-surface/90 backdrop-blur-sm transition-colors hover:border-gold-2 ${b.kind === 'err' ? 'border-red/60' : 'border-line-2'}`}
                    style={{
                      left: bx * scale,
                      top: by * scale,
                      transform: `translate(calc(-50% + ${g.cos * 42}%), calc(-50% + ${g.sin * 48}%))`
                    }}
                  >
                    <span
                      className={`block font-voice text-[12px] leading-snug line-clamp-3 ${b.kind === 'err' ? 'text-red' : b.kind === 'wait' ? 'text-ink-3' : 'text-ink'} ${b.kind === 'live' || b.kind === 'wait' ? 'cursor' : ''}`}
                    >
                      {b.text}
                    </span>
                  </button>
                )
              })}
          </div>
        </div>

        {/* the floor */}
        <div
          ref={feedRef}
          onScroll={(e) =>
            setStick(
              e.currentTarget.scrollHeight -
                e.currentTarget.scrollTop -
                e.currentTarget.clientHeight <
                80
            )
          }
          className="flex-1 min-h-0 overflow-y-auto px-8 border-t border-line"
        >
          {filter && (
            <div className="sticky top-0 bg-canvas py-2 text-[11px] text-ink-3 flex gap-3">
              <span>Only {s.labels[filter]} and you</span>
              <button className="text-gold" onClick={() => setFilter(null)}>
                show everyone
              </button>
            </div>
          )}
          {feed.length === 0 && (
            <div className="py-6 text-[13px] text-ink-3 font-voice">
              The table is quiet. Openings come first.
            </div>
          )}
          {feed.map((t, i) => {
            const c = color(t.speaker)
            const human = t.speaker === HUMAN
            return (
              <div
                key={`${t.speaker}-${t.n}-${i}`}
                className="flex gap-3 py-3 border-b border-line/60"
              >
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center font-display text-[13px] shrink-0 mt-0.5"
                  style={{ background: `${c}22`, color: c }}
                >
                  {human
                    ? 'Y'
                    : PERSONAS[members.find((m) => m.id === t.speaker)!.persona].monogram}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-[11px] text-ink-3">
                    <span className="font-display text-[13px]" style={{ color: c }}>
                      {human ? 'You' : t.label}
                    </span>
                    {!human && <span className="font-mono">turn {t.n}</span>}
                    {t.vote && <span>· {Math.round(t.vote.confidence * 100)}% sure</span>}
                    {t.status === 'running' && <span className="text-gold">speaking</span>}
                  </div>
                  {t.status === 'error' ? (
                    <p className="text-red text-[13px] mt-1">{t.error}</p>
                  ) : t.status === 'running' ? (
                    <p className="font-voice text-[14.5px] leading-relaxed whitespace-pre-wrap mt-1 cursor">
                      {plain(t.text) || <span className="text-ink-3">{thinking(t, now)}</span>}
                    </p>
                  ) : (
                    <Markdown text={t.text} className="compact mt-1" />
                  )}
                  {t.vote && t.vote.disagreements.length > 0 && (
                    <div className="text-[11px] text-red/90 mt-1">
                      {t.vote.disagreements
                        .map((d) => `✗ ${d.with}${d.on ? ` — ${d.on}` : ''}`)
                        .join(' · ')}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {s.chair.status !== 'idle' && !filter && (
            <div className="flex gap-3 py-3">
              <span className="w-7 h-7 rounded-full flex items-center justify-center font-display text-[13px] shrink-0 mt-0.5 bg-gold/15 text-gold">
                C
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-ink-3">
                  <span className="font-display text-[13px] text-gold">{chairLabel}, as chair</span>{' '}
                  {s.chair.status === 'running'
                    ? 'is writing the consortium'
                    : 'wrote the consortium'}
                </div>
                {s.chair.status === 'running' && (
                  <p className="font-voice text-[14.5px] leading-relaxed whitespace-pre-wrap mt-1 cursor">
                    {plain(s.chair.text).slice(-600)}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="px-8 pb-4 pt-3 flex items-center gap-4 border-t border-line">
          <div className="w-28 shrink-0" title={`${memberTurns} of ${brief.maxTurns} turns`}>
            <div className="text-[10px] font-mono text-ink-3 mb-1">
              turn {memberTurns}/{brief.maxTurns}
            </div>
            <div className="h-px bg-line relative">
              <div
                className="absolute inset-y-0 left-0 bg-gold-2 transition-all duration-500"
                style={{ width: `${Math.min(100, (memberTurns / brief.maxTurns) * 100)}%` }}
              />
            </div>
          </div>
          <form onSubmit={interject} className="flex-1 relative">
            <input
              value={thought}
              onChange={(e) => setThought(e.target.value)}
              disabled={!running}
              placeholder={
                running
                  ? 'Say something to the table…'
                  : s.stage === 'done'
                    ? 'The consortium has decided'
                    : 'The table is closed'
              }
              className="w-full h-10 rounded-full bg-surface border border-line-2 focus:border-gold outline-none px-4 text-[13px] font-voice placeholder:text-ink-3 disabled:opacity-60"
            />
            {toast && <span className="absolute -top-6 left-4 text-[11px] text-gold">{toast}</span>}
          </form>
          {running ? (
            <button
              onClick={() => void window.api!.stop()}
              className="text-[12px] text-ink-3 hover:text-red"
            >
              Stop
            </button>
          ) : s.stage === 'done' ? (
            <button
              onClick={onConsortium}
              className="bg-gold text-canvas text-[13px] font-medium px-4 h-9 rounded-full hover:brightness-110"
            >
              Read the consortium
            </button>
          ) : (
            <button onClick={onHome} className="text-[12px] text-ink-2 hover:text-ink">
              {s.stage === 'failed' ? `Failed: ${s.error ?? 'unknown'} · ` : 'Stopped · '}Convene
              again
            </button>
          )}
        </footer>
      </main>

      {/* taking shape */}
      <aside className="border-l border-line flex flex-col min-h-0">
        <div className="drag h-12 shrink-0" />
        <div className="px-5 pb-5 overflow-y-auto">
          <div className="font-display text-[20px]">Taking shape</div>
          <div className="text-[12px] text-ink-3 mt-0.5">
            The clerk&apos;s notes, kept between turns
          </div>

          <div className="mt-6 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Agreement</span>
            <span className="font-display text-[26px] text-gold leading-none">
              {agree}
              <span className="text-ink-3 text-[15px]"> / {n}</span>
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {members.map((m) => {
              const ok = votes[m.id] && votes[m.id]!.disagreements.length === 0
              return (
                <span
                  key={m.id}
                  className="w-3 h-3 rounded-full border"
                  style={{
                    borderColor: CLI_META[m.cli].color,
                    background: ok ? CLI_META[m.cli].color : 'transparent'
                  }}
                  title={s.labels[m.id]}
                />
              )
            })}
          </div>

          {s.shape ? (
            <>
              <ol className="mt-7 space-y-4">
                {s.shape.converging.map((c, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="font-display text-[15px] text-ink-3 w-4 shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <div className="font-voice text-[14px] leading-snug">{c.point}</div>
                      <div className="flex gap-1 mt-1.5">
                        {members.map((m) => (
                          <span
                            key={m.id}
                            className="w-2 h-2 rounded-full"
                            style={{
                              background: c.supporters.includes(s.labels[m.id])
                                ? CLI_META[m.cli].color
                                : 'var(--color-line-2)'
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              {s.shape.open.length > 0 && (
                <div className="mt-7">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-ink-3">
                    Still open
                  </div>
                  <ul className="mt-2 space-y-2.5">
                    {s.shape.open.map((o, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-red shrink-0" />
                        <div>
                          <div className="font-voice text-[14px] leading-snug">{o.point}</div>
                          <div className="text-[11px] text-ink-3 mt-0.5">{o.sides}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {s.shape.open.length === 0 && s.shape.converging.length > 0 && (
                <div className="mt-6 text-[12px] text-gold">Nothing left open.</div>
              )}
            </>
          ) : (
            <div className="mt-8 text-[13px] text-ink-3 font-voice">
              {running ? (
                <span className="cursor">Listening to the table</span>
              ) : (
                'No notes for this session.'
              )}
            </div>
          )}
          {s.chair.status === 'running' && (
            <div className="mt-8 border-t border-line pt-4 text-[12px] text-ink-2">
              <span className="text-gold">{chairLabel}</span> is writing the consortium
              <span className="cursor" />
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
