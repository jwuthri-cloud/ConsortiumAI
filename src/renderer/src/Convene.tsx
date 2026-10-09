import Brand, { BrandMark } from './Brand'
import { PROVIDERS } from './avatarTheme'
import { useEffect, useRef, useState } from 'react'
import Library from './Library'
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
import { BOARD_WRITER } from '@shared/whiteboard'

type Seat = Member & { check?: 'checking' | 'ok' | 'error'; message?: string }
type Props = {
  onStart: (brief: Brief) => void
  onOpen: (session: Session) => void
  onContinue: (session: Session) => void
}

const ORDER: Cli[] = ['claude', 'codex', 'gemini', 'grok']
// a new seat's model; other CLIs start on their own default
const DEFAULT_MODEL: Partial<Record<Cli, string>> = { claude: 'opus' }
const DEFAULT_PERSONA: Record<Cli, PersonaId> = {
  claude: 'strategist',
  codex: 'engineer',
  gemini: 'researcher',
  grok: 'skeptic'
}
let seatSeq = 0

export default function Convene({ onStart, onOpen, onContinue }: Props): React.JSX.Element {
  const [task, setTask] = useState('')
  const [rerunOf, setRerunOf] = useState<string>()
  const question = useRef<HTMLTextAreaElement>(null)
  const [projectPath, setProjectPath] = useState<string | undefined>()
  const [seats, setSeats] = useState<Seat[]>([])
  const [chairId, setChairId] = useState('')
  const [turns, setTurns] = useState(30)
  // null = the board is written by the chair's CLI and model
  const [writer, setWriter] = useState<{ cli: Cli; model: string } | null>({ ...BOARD_WRITER })
  const [installed, setInstalled] = useState<Partial<Record<Cli, string>>>({})
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const addFiles = (paths: string[]): void =>
    setFiles((f) => [...new Set([...f, ...paths.filter(Boolean)])])
  const ipcError = (e: unknown): string =>
    (e instanceof Error ? e.message : String(e)).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      ''
    )
  // pasted screenshots have no path on disk: save their bytes first
  const pasteFiles = async (e: React.ClipboardEvent): Promise<void> => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length) return
    e.preventDefault()
    addFiles(
      await Promise.all(
        pasted.map(async (f) => window.api!.saveFile(f.name || 'pasted.png', await f.arrayBuffer()))
      )
    )
  }
  const dictate = async (): Promise<void> => {
    if (recorder) return recorder.stop()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return setProblem(
        'No microphone access. Allow it in System Settings → Privacy & Security → Microphone.'
      )
    }
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setRecorder(null)
      setTranscribing(true)
      try {
        const path = await window.api!.saveFile(
          'dictation.webm',
          await new Blob(chunks).arrayBuffer()
        )
        const text = await window.api!.transcribe(path)
        if (text) setTask((t) => (t.trim() ? `${t.trimEnd()} ${text}` : text))
      } catch (e) {
        setProblem(ipcError(e))
      } finally {
        setTranscribing(false)
      }
    }
    rec.start()
    setRecorder(rec)
    setProblem(null)
  }

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
          model: DEFAULT_MODEL[cli],
          persona: DEFAULT_PERSONA[cli]
        }))
        setSeats(initial)
        setChairId(initial[0]?.id ?? '')
        // no Claude Code here: the chair writes the board
        if (!clis.includes(BOARD_WRITER.cli)) setWriter(null)
      })
    void window
      .api!.listSessions()
      .then(setSessions)
      .catch(() => setProblem('Could not load previous sessions.'))
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
    const seat = { id: `seat-${++seatSeq}`, cli, model: DEFAULT_MODEL[cli], persona }
    setSeats((xs) => [...xs, seat])
    if (!chairId) setChairId(seat.id)
  }
  const check = async (seat: Seat): Promise<void> => {
    patch(seat.id, { check: 'checking', message: undefined })
    try {
      const r = await window.api!.check(seat.cli)
      patch(seat.id, {
        check: r.ok ? 'ok' : 'error',
        resolvedModel: r.model,
        message: r.ok ? undefined : r.message
      })
    } catch {
      patch(seat.id, { check: 'error', message: 'Connection failed. Try again.' })
    }
  }
  // same seats, chair, budget, project and files; the question is pre-selected so typing replaces it
  const rerun = ({ brief }: Session, title: string): void => {
    const ids = Object.fromEntries(brief.members.map((m) => [m.id, `seat-${++seatSeq}`]))
    setSeats(brief.members.map((m) => ({ ...m, id: ids[m.id] })))
    setChairId(ids[brief.chairId] ?? '')
    setTurns(brief.maxTurns)
    setWriter(brief.board ? { cli: brief.board.cli, model: brief.board.model ?? '' } : null)
    setProjectPath(brief.projectPath)
    setFiles(brief.attachments ?? [])
    setTask(brief.task)
    setRerunOf(title)
    setProblem(null)
    requestAnimationFrame(() => {
      question.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      question.current?.focus({ preventScroll: true })
      question.current?.select()
    })
  }
  const start = (): void => {
    if (!task.trim()) return setProblem('Write the question first.')
    if (seats.length < 2) return setProblem('A consortium needs at least two seats.')
    if (!seats.some((x) => x.id === chairId)) return setProblem('Pick a chair.')
    setProblem(null)
    onStart({
      task: task.trim(),
      projectPath,
      attachments: files.length ? files : undefined,
      members: seats.map(({ id, cli, model, persona, resolvedModel }) => ({
        id,
        cli,
        model: model?.trim() || undefined,
        persona,
        resolvedModel: model?.trim() ? undefined : resolvedModel
      })),
      chairId,
      maxTurns: turns,
      board: writer ? { cli: writer.cli, model: writer.model.trim() || undefined } : undefined
    })
  }

  return (
    <div className="lobby app-page">
      <header className="app-titlebar drag">
        <Brand />
        <span className="titlebar-slash">/</span>
        <span className="titlebar-room">Your workspace</span>
        <span className="workspace-status">
          <i /> Ready when you are
        </span>
      </header>
      <main className="lobby-content rise">
        <div className="lobby-intro">
          <div>
            <div className="meeting-eyebrow">BETTER DECISIONS, TOGETHER</div>
            <h1>Bring your minds together.</h1>
            <p>One question. Different perspectives. A decision worth making.</p>
          </div>
          <div className="lobby-orbit" aria-hidden="true">
            <BrandMark size={48} />
            <i />
            <i />
            <i />
          </div>
        </div>

        <section
          className="question-card"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            addFiles([...e.dataTransfer.files].map((f) => window.api!.pathForFile(f)))
          }}
        >
          <div className="section-heading">
            <h2>
              <span className="step-number">01</span> What&apos;s on the agenda?
            </h2>
            <span className="rerun-note">
              {rerunOf ? `Same team as “${rerunOf}”` : 'A new meeting'}
            </span>
          </div>
          <label className="sr-only" htmlFor="meeting-question">
            Meeting question
          </label>
          <textarea
            ref={question}
            id="meeting-question"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onPaste={(e) => void pasteFiles(e)}
            rows={2}
            placeholder="What should we figure out together?"
          />
          {files.length > 0 && (
            <div className="attached-files">
              {files.map((f) => (
                <span key={f} className="file-chip" title={f}>
                  {f.split('/').pop()}
                  <button
                    aria-label={`Remove ${f.split('/').pop()}`}
                    onClick={() => setFiles(files.filter((x) => x !== f))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="project-attachment">
            <span className="folder-symbol" aria-hidden="true">
              ⌘
            </span>
            {projectPath ? (
              <>
                <span className="project-name" title={projectPath}>
                  {projectPath.split('/').pop()}
                </span>
                <span className="quiet-pill">Read-only</span>
                <button className="text-button" onClick={() => setProjectPath(undefined)}>
                  Detach
                </button>
              </>
            ) : (
              <>
                <button
                  className="text-button"
                  onClick={() => void window.api!.pickFolder().then((p) => p && setProjectPath(p))}
                >
                  Attach a project
                </button>
                <span className="attachment-hint">
                  Give your agents the code behind the question.
                </span>
              </>
            )}
            <span className="attachment-actions">
              <button
                className="text-button"
                onClick={() => void window.api!.pickFiles().then(addFiles)}
                title="Or drop files here, or paste a screenshot"
              >
                + Files
              </button>
              <button
                className={`text-button dictate ${recorder ? 'recording' : ''}`}
                onClick={() => void dictate()}
                disabled={transcribing}
                aria-pressed={!!recorder}
              >
                {transcribing ? 'Transcribing…' : recorder ? '● Stop' : '🎙 Dictate'}
              </button>
            </span>
          </div>
        </section>

        <section className="seats-section">
          <div className="section-heading">
            <h2>
              <span className="step-number">02</span> Who&apos;s at the table?{' '}
              <span className="count-badge">{seats.length}</span>
            </h2>
            <div className="section-actions">
              <button
                className="text-button"
                disabled={seats.some((s) => s.check === 'checking')}
                onClick={() => seats.forEach((s) => void check(s))}
              >
                Check connections
              </button>
              {seats.length < 6 && (
                <button className="secondary-button" onClick={add}>
                  + Add seat
                </button>
              )}
            </div>
          </div>
          <div className="setup-seats">
            {seats.map((s, i) => (
              <div
                key={s.id}
                className={`setup-seat ${chairId === s.id ? 'is-chair' : ''}`}
                style={{ '--seat-color': PROVIDERS[s.cli].color } as React.CSSProperties}
              >
                <div className="seat-card-header">
                  <div className="provider-emblem" aria-hidden="true">
                    {s.cli === 'claude'
                      ? '✳'
                      : s.cli === 'codex'
                        ? '◎'
                        : s.cli === 'gemini'
                          ? '✦'
                          : '𝕏'}
                  </div>
                  <div className="seat-provider">
                    <strong>{PROVIDERS[s.cli].name}</strong>
                    <span>Seat {String(i + 1).padStart(2, '0')}</span>
                  </div>
                  <button
                    className={`chair-toggle ${chairId === s.id ? 'selected' : ''}`}
                    aria-pressed={chairId === s.id}
                    onClick={() => setChairId(s.id)}
                    title="The chair writes the final decision"
                  >
                    Chair
                  </button>
                  <button
                    className="remove-seat"
                    onClick={() => remove(s.id)}
                    aria-label={`Remove ${PERSONAS[s.persona].label}`}
                  >
                    ×
                  </button>
                </div>
                <label className="field-label">
                  Role
                  <select
                    value={s.persona}
                    onChange={(e) => patch(s.id, { persona: e.target.value as PersonaId })}
                  >
                    {PERSONA_IDS.map((p) => (
                      <option key={p} value={p}>
                        {PERSONAS[p].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  Connection
                  <select
                    value={s.cli}
                    onChange={(e) =>
                      patch(s.id, {
                        cli: e.target.value as Cli,
                        model: DEFAULT_MODEL[e.target.value as Cli],
                        resolvedModel: undefined,
                        check: undefined,
                        message: undefined
                      })
                    }
                  >
                    {ORDER.map((c) => (
                      <option key={c} value={c}>
                        {CLI_META[c].name}
                        {installed[c] ? '' : ' (not detected)'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  Model
                  <input
                    value={s.model ?? ''}
                    onChange={(e) =>
                      patch(s.id, { model: e.target.value, resolvedModel: undefined })
                    }
                    placeholder={s.resolvedModel ?? 'Automatic · resolved on connection'}
                    list={`models-${s.cli}`}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className="seat-connection">
                  <span className={`connection-dot ${s.check ?? ''}`} />
                  <button
                    className="text-button"
                    disabled={s.check === 'checking'}
                    onClick={() => void check(s)}
                  >
                    {s.check === 'checking'
                      ? 'Connecting…'
                      : s.check === 'ok'
                        ? 'Connected'
                        : s.check === 'error'
                          ? 'Retry connection'
                          : installed[s.cli]
                            ? 'Installed · test connection'
                            : 'Check connection'}
                  </button>
                </div>
                {s.message && (
                  <p className="connection-error" role="alert">
                    {s.message}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="seats-note">
            Different roles keep the conversation honest. Your agents know each other by role,
            without seeing the model behind it.
          </p>
          <div className="board-writer">
            <p>
              <strong>Whiteboard writer</strong>
              Keeps the live board of what&apos;s agreed, disputed and waiting on you.
            </p>
            <label className="field-label">
              Connection
              <select
                value={writer?.cli ?? ''}
                onChange={(e) =>
                  setWriter(e.target.value ? { cli: e.target.value as Cli, model: '' } : null)
                }
              >
                <option value="">Same as the chair</option>
                {ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CLI_META[c].name}
                    {installed[c] ? '' : ' (not detected)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              Model
              <input
                value={writer?.model ?? ''}
                onChange={(e) => writer && setWriter({ ...writer, model: e.target.value })}
                disabled={!writer}
                placeholder={writer ? 'CLI default' : "The chair's model"}
                list={writer ? `models-${writer.cli}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
        </section>

        <section className="launch-bar">
          <div>
            <h2>Room to think.</h2>
            <p>Set the maximum turns for this meeting.</p>
          </div>
          <div className="turn-options" aria-label="Maximum meeting turns">
            {[20, 30, 50].map((r) => (
              <button
                key={r}
                aria-pressed={turns === r}
                className={turns === r ? 'selected' : ''}
                onClick={() => setTurns(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <button className="primary-button" onClick={start}>
            Start meeting <span aria-hidden="true">↗</span>
          </button>
        </section>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}

        <Library
          sessions={sessions}
          onOpen={onOpen}
          onContinue={onContinue}
          onRerun={rerun}
          onProblem={setProblem}
          onDeleted={(id) => setSessions((all) => all.filter((s) => s.id !== id))}
        />
        <footer className="lobby-footer">
          <span>Several minds. One shared direction.</span>
          <span>Powered by your connected agents</span>
        </footer>
      </main>
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
