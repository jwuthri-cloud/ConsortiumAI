import { useEffect, useState } from 'react'
import {
  CLI_META,
  type Brief,
  type Cli,
  type Member,
  type PersonaId,
  type Session,
  type SessionSummary
} from '@shared/types'
import { PERSONAS, PERSONA_IDS } from '@shared/personas'

type Seat = Member & { check?: 'checking' | 'ok' | 'error'; message?: string }
type Props = { onStart: (brief: Brief) => void; onOpen: (session: Session) => void }

const ORDER: Cli[] = ['claude', 'codex', 'gemini', 'grok']
const DEFAULT_PERSONA: Record<Cli, PersonaId> = {
  claude: 'strategist',
  codex: 'engineer',
  gemini: 'researcher',
  grok: 'skeptic'
}
const MODEL_HINT: Record<Cli, string> = {
  claude: 'default (opus) — or pick',
  codex: 'default model — or pick',
  gemini: 'default model — or pick',
  grok: 'default model — or pick'
}
let seatSeq = 0

export default function Convene({ onStart, onOpen }: Props): React.JSX.Element {
  const [task, setTask] = useState('')
  const [projectPath, setProjectPath] = useState<string | undefined>()
  const [seats, setSeats] = useState<Seat[]>([])
  const [chairId, setChairId] = useState('')
  const [turns, setTurns] = useState(30)
  const [installed, setInstalled] = useState<Partial<Record<Cli, string>>>({})
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const [models, setModels] = useState<Partial<Record<Cli, string[]>>>({})

  useEffect(() => {
    void window
      .api!.detect()
      .catch(() => ({}) as Partial<Record<Cli, string>>)
      .then((bins) => {
        setInstalled(bins)
        // nothing detected = exotic PATH, not proof of absence: seat all four and let "check" tell
        const clis = ORDER.some((c) => bins[c]) ? ORDER.filter((c) => bins[c]) : ORDER
        const initial = clis.map((cli) => ({
          id: `seat-${++seatSeq}`,
          cli,
          persona: DEFAULT_PERSONA[cli]
        }))
        setSeats(initial)
        setChairId(initial[0]?.id ?? '')
      })
    void window.api!.listSessions().then(setSessions)
    for (const cli of ORDER)
      void window
        .api!.models(cli)
        .then((ids) => setModels((m) => ({ ...m, [cli]: ids })))
        .catch(() => undefined)
  }, [])

  const patch = (id: string, p: Partial<Seat>): void =>
    setSeats((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const remove = (id: string): void => {
    setSeats((xs) => xs.filter((x) => x.id !== id))
    if (chairId === id) setChairId(seats.find((x) => x.id !== id)?.id ?? '')
  }
  const add = (): void => {
    const cli = ORDER.find((c) => !seats.some((x) => x.cli === c)) ?? 'claude'
    const persona = PERSONA_IDS.find((p) => !seats.some((x) => x.persona === p)) ?? 'skeptic'
    const seat = { id: `seat-${++seatSeq}`, cli, persona }
    setSeats((xs) => [...xs, seat])
    if (!chairId) setChairId(seat.id)
  }
  const check = async (seat: Seat): Promise<void> => {
    patch(seat.id, { check: 'checking', message: undefined })
    const r = await window.api!.check(seat.cli)
    patch(seat.id, { check: r.ok ? 'ok' : 'error', message: r.ok ? undefined : r.message })
  }
  const start = (): void => {
    if (!task.trim()) return setProblem('Write the question first.')
    if (seats.length < 2) return setProblem('A consortium needs at least two seats.')
    if (!seats.some((x) => x.id === chairId)) return setProblem('Pick a chair.')
    setProblem(null)
    onStart({
      task: task.trim(),
      projectPath,
      members: seats.map(({ id, cli, model, persona }) => ({
        id,
        cli,
        model: model?.trim() || undefined,
        persona
      })),
      chairId,
      maxTurns: turns
    })
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="drag h-12 pl-20 pr-5 flex items-center text-[11px] uppercase tracking-[0.18em] text-ink-3">
        Consortium
      </header>
      <div className="max-w-[920px] mx-auto px-10 pb-20 rise">
        <h1 className="font-display font-light text-[46px] leading-none tracking-tight mt-8">
          Convene the table.
        </h1>
        <p className="text-ink-2 mt-3 max-w-[540px] text-[15px] leading-relaxed">
          One question. Several minds that disagree on purpose, each on a subscription you already
          pay for. A decision you can read, with the dissent kept in.
        </p>

        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder="Should we let customers export their data?"
          className="font-voice text-[21px] leading-snug w-full mt-12 py-3 bg-transparent border-0 border-b border-line-2 focus:border-gold outline-none resize-none placeholder:text-ink-3 transition-colors"
        />

        <div className="mt-5 flex items-center gap-3 text-[13px]">
          {projectPath ? (
            <>
              <span className="font-mono text-ink-2 truncate max-w-[520px]">{projectPath}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] text-gold border border-gold-2 rounded px-1.5 py-0.5">
                read-only
              </span>
              <button
                className="text-ink-3 hover:text-ink"
                onClick={() => setProjectPath(undefined)}
              >
                Detach
              </button>
            </>
          ) : (
            <button
              className="text-ink-2 hover:text-ink underline underline-offset-4 decoration-line-2"
              onClick={() => void window.api!.pickFolder().then((p) => p && setProjectPath(p))}
            >
              Attach a project folder
            </button>
          )}
          <span className="text-ink-3">
            {projectPath
              ? '— members inspect it before they argue'
              : '— optional; members then argue from the real code'}
          </span>
        </div>

        <section className="mt-12">
          <div className="flex items-baseline gap-4">
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Seats</h2>
            <button
              className="text-[12px] text-ink-3 hover:text-ink"
              onClick={() => seats.forEach((s) => void check(s))}
            >
              Check all
            </button>
            {seats.length < 6 && (
              <button className="text-[12px] text-ink-3 hover:text-ink" onClick={add}>
                + Add seat
              </button>
            )}
          </div>
          <div className="mt-3 divide-y divide-line border-y border-line">
            {seats.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[20px_168px_150px_1fr_auto_auto_28px] items-center gap-3 py-2.5 text-[13px]"
              >
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ background: CLI_META[s.cli].color }}
                />
                <select
                  value={s.persona}
                  onChange={(e) => patch(s.id, { persona: e.target.value as PersonaId })}
                  className="bg-transparent text-ink outline-none font-display text-[15px]"
                >
                  {PERSONA_IDS.map((p) => (
                    <option key={p} value={p} className="bg-surface">
                      {PERSONAS[p].label}
                    </option>
                  ))}
                </select>
                <select
                  value={s.cli}
                  onChange={(e) =>
                    patch(s.id, {
                      cli: e.target.value as Cli,
                      check: undefined,
                      message: undefined
                    })
                  }
                  className="bg-transparent text-ink-2 outline-none"
                >
                  {ORDER.map((c) => (
                    <option key={c} value={c} className="bg-surface">
                      {CLI_META[c].name}
                      {installed[c] ? '' : ' (not installed)'}
                    </option>
                  ))}
                </select>
                <input
                  value={s.model ?? ''}
                  onChange={(e) => patch(s.id, { model: e.target.value })}
                  placeholder={MODEL_HINT[s.cli]}
                  list={`models-${s.cli}`}
                  className="bg-transparent font-mono text-[12px] text-ink-2 outline-none placeholder:text-ink-3 border-b border-transparent focus:border-line-2"
                />
                <button
                  onClick={() => setChairId(s.id)}
                  className={`text-[10px] uppercase tracking-[0.14em] rounded px-1.5 py-0.5 border ${chairId === s.id ? 'text-gold border-gold-2' : 'text-ink-3 border-transparent hover:border-line-2'}`}
                >
                  chair
                </button>
                <button
                  onClick={() => void check(s)}
                  className="text-[11px] min-w-[72px] text-left"
                  title={s.message}
                >
                  {s.check === 'checking' && <span className="text-ink-3 cursor">checking</span>}
                  {s.check === 'ok' && <span className="text-gold">ready</span>}
                  {s.check === 'error' && (
                    <span className="text-red truncate inline-block max-w-[180px] align-bottom">
                      {s.message}
                    </span>
                  )}
                  {!s.check && <span className="text-ink-3 hover:text-ink">check</span>}
                </button>
                <button
                  className="text-ink-3 hover:text-red text-right"
                  onClick={() => remove(s.id)}
                  aria-label="Remove seat"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-ink-3 mt-2">
            Members only ever see each other&apos;s persona. The model behind a seat stays hidden
            from the table.
          </p>
        </section>

        <section className="mt-10 flex items-center gap-6">
          <div className="flex items-center gap-2 text-[13px] text-ink-2">
            <span title="Turns across all members; the last cycle is always final statements">
              Turns
            </span>
            {[20, 30, 50].map((r) => (
              <button
                key={r}
                onClick={() => setTurns(r)}
                className={`w-8 h-7 rounded-full border text-[12px] ${turns === r ? 'border-gold text-gold' : 'border-line-2 text-ink-3 hover:text-ink'}`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={start}
            className="ml-auto bg-gold text-canvas font-medium text-[14px] px-6 h-10 rounded-full hover:brightness-110 transition"
          >
            Convene
          </button>
        </section>
        {problem && <p className="text-red text-[13px] mt-3 text-right">{problem}</p>}

        {sessions.length > 0 && (
          <section className="mt-16">
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-ink-3">Past sessions</h2>
            <div className="mt-3 divide-y divide-line border-y border-line">
              {sessions.slice(0, 12).map((x) => (
                <button
                  key={x.id}
                  onClick={() => void window.api!.loadSession(x.id).then((s) => s && onOpen(s))}
                  className="w-full text-left py-2.5 flex items-center gap-4 hover:bg-surface px-1 -mx-1 rounded"
                >
                  <span className="font-voice text-[15px] truncate flex-1">{x.task}</span>
                  <span
                    className={`text-[10px] uppercase tracking-[0.14em] ${x.status === 'done' ? 'text-gold' : 'text-ink-3'}`}
                  >
                    {x.status}
                  </span>
                  <span className="font-mono text-[11px] text-ink-3">
                    {new Date(x.createdAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      {ORDER.map((cli) => (
        <datalist key={cli} id={`models-${cli}`}>
          {(models[cli] ?? []).map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      ))}
    </div>
  )
}
