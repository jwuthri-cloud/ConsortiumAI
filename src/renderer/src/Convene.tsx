import Brand, { BrandMark } from './Brand'
import { PROVIDERS } from './avatarTheme'
import { useEffect, useRef, useState } from 'react'
import Library from './Library'
import Settings from './Settings'
import { useDictation } from './useDictation'
import ModelPicker from './ModelPicker'
import {
  API_PROVIDERS,
  CLI_META,
  splitModel,
  type ApiProvider,
  type KeySource,
  type Brief,
  type Cli,
  type Member,
  type PersonaId,
  type Session,
  type SessionSummary
} from '@shared/types'
import { PERSONAS, PERSONA_IDS } from '@shared/personas'
import { BOARD_WRITER } from '@shared/whiteboard'
import { VOICES, freeVoice } from '@shared/voices'

type Seat = Member & { check?: 'checking' | 'ok' | 'error'; message?: string }
type Props = {
  onStart: (brief: Brief) => void
  onOpen: (session: Session) => void
  onContinue: (session: Session) => void
}

const ORDER: Cli[] = ['claude', 'codex', 'gemini', 'grok', 'harness']
const PROVIDER_IDS = Object.keys(API_PROVIDERS) as ApiProvider[]
// a new seat's model; the Deep-agent has none, you pick a provider and model
const DEFAULT_MODEL: Partial<Record<Cli, string>> = {
  claude: 'claude-opus-5-5',
  codex: 'gpt-6.1-sol',
  gemini: 'gemini-3.8-flash',
  grok: 'grok-4.7'
}
const DEFAULT_PERSONA: Record<Cli, PersonaId> = {
  claude: 'strategist',
  codex: 'engineer',
  gemini: 'researcher',
  grok: 'skeptic',
  harness: 'designer'
}
let seatSeq = 0
// Each connection's last check, for as long as the app runs, so the lobby's lights survive a
// meeting without testing every CLI again.
type Checked = Pick<Seat, 'check' | 'message' | 'resolvedModel'>
const checked = new Map<string, Checked>()
const checkKey = (s: Pick<Seat, 'cli' | 'model'>): string => `${s.cli}|${s.model?.trim() ?? ''}`
async function testSeat(seat: Seat): Promise<Checked> {
  try {
    const r = await window.api!.check(seat.cli, seat.model)
    const result: Checked = {
      check: r.ok ? 'ok' : 'error',
      resolvedModel: r.model,
      message: r.ok ? undefined : r.message
    }
    checked.set(checkKey(seat), result)
    return result
  } catch {
    return { check: 'error', message: 'Connection failed. Try again.' }
  }
}
export default function Convene({ onStart, onOpen, onContinue }: Props): React.JSX.Element {
  const [task, setTask] = useState('')
  const [rerunOf, setRerunOf] = useState<string>()
  const question = useRef<HTMLTextAreaElement>(null)
  const [projectPath, setProjectPath] = useState<string | undefined>()
  const [seats, setSeats] = useState<Seat[]>([])
  const [chairId, setChairId] = useState('')
  const [turns, setTurns] = useState(30)
  const [voices, setVoices] = useState(() => {
    try {
      return localStorage.getItem('voices-on') === '1'
    } catch {
      return false
    }
  })
  const toggleVoices = (on: boolean): void => {
    setVoices(on)
    try {
      localStorage.setItem('voices-on', on ? '1' : '0')
    } catch {
      /* not remembered */
    }
  }
  // null = the board is written by the chair's CLI and model
  const [writer, setWriter] = useState<{ cli: Cli; model: string } | null>({ ...BOARD_WRITER })
  const [installed, setInstalled] = useState<Partial<Record<Cli, string>>>({})
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const addFiles = (paths: string[]): void =>
    setFiles((f) => [...new Set([...f, ...paths.filter(Boolean)])])
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
  const dictation = useDictation(
    (text) => setTask((t) => (t.trim() ? `${t.trimEnd()} ${text}` : text)),
    setProblem
  )

  const [models, setModels] = useState<Partial<Record<Cli, string[]>>>({})
  const [keys, setKeys] = useState<Partial<Record<ApiProvider, KeySource>>>({})
  const refreshKeys = (): Promise<void> => window.api!.keys().then(setKeys, () => undefined)
  const [settings, setSettings] = useState<{ focus?: ApiProvider } | null>(null)
  const keysChanged = async (): Promise<void> => {
    await refreshKeys()
    // a harness seat that failed for want of a key deserves a fresh light
    for (const k of checked.keys()) if (k.startsWith('harness|')) checked.delete(k)
    setSeats((xs) =>
      xs.map((x) =>
        x.cli === 'harness' && x.check === 'error'
          ? { ...x, check: undefined, message: undefined }
          : x
      )
    )
  }

  useEffect(() => {
    void window
      .api!.detect()
      .catch(() => ({}) as Partial<Record<Cli, string>>)
      .then((bins) => {
        setInstalled(bins)
        // nothing detected = exotic PATH, not proof of absence: seat all four and let "check" tell.
        // The harness is always there but needs a key, so it is added by hand.
        const spawned = ORDER.filter((c) => c !== 'harness')
        const clis = spawned.some((c) => bins[c]) ? spawned.filter((c) => bins[c]) : spawned
        const initial: Seat[] = clis.map((cli, i) => {
          const seat = {
            id: `seat-${++seatSeq}`,
            cli,
            model: DEFAULT_MODEL[cli],
            persona: DEFAULT_PERSONA[cli],
            voice: VOICES[i]
          }
          // the green/red lights: test each seat once per app launch (a one-word prompt per CLI)
          return { ...seat, ...(checked.get(checkKey(seat)) ?? { check: 'checking' as const }) }
        })
        setSeats(initial)
        setChairId(initial[0]?.id ?? '')
        for (const s of initial)
          if (s.check === 'checking')
            void testSeat(s).then((r) =>
              setSeats((xs) => xs.map((x) => (x.id === s.id ? { ...x, ...r } : x)))
            )
        // no Claude Code here: the chair writes the board
        if (!clis.includes(BOARD_WRITER.cli)) setWriter(null)
      })
    void window
      .api!.listSessions()
      .then(setSessions)
      .catch(() => setProblem('Could not load previous sessions.'))
    void refreshKeys()
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
    const seat = {
      id: `seat-${++seatSeq}`,
      cli,
      model: DEFAULT_MODEL[cli],
      persona,
      voice: freeVoice(seats.map((x) => x.voice))
    }
    setSeats((xs) => [...xs, seat])
    if (!chairId) setChairId(seat.id)
  }
  const check = async (seat: Seat): Promise<void> => {
    patch(seat.id, { check: 'checking', message: undefined })
    patch(seat.id, await testSeat(seat))
  }
  // before a check: red when the CLI is missing or the harness has no key
  const light = (s: Seat): string =>
    s.check ??
    ((s.cli === 'harness' ? keys[splitModel(s.model).provider] : installed[s.cli]) ? '' : 'error')
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
    if (seats.some((x) => x.cli === 'harness' && !splitModel(x.model).model))
      return setProblem('Pick a model for the Deep-agent seat.')
    setProblem(null)
    // every seat speaks with its own voice (older meetings re-run without one get the next free one)
    const used: string[] = []
    const voiceFor = (v?: string): string => {
      const pick = v && !used.includes(v) ? v : freeVoice(used)
      used.push(pick)
      return pick
    }
    onStart({
      task: task.trim(),
      projectPath,
      attachments: files.length ? files : undefined,
      members: seats.map(({ id, cli, model, persona, resolvedModel, voice }) => ({
        id,
        cli,
        model: model?.trim() || undefined,
        persona,
        resolvedModel: model?.trim() ? undefined : resolvedModel,
        voice: voiceFor(voice)
      })),
      chairId,
      maxTurns: turns,
      board: writer ? { cli: writer.cli, model: writer.model.trim() || undefined } : undefined,
      voices: voices || undefined
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
        <button className="text-button titlebar-settings" onClick={() => setSettings({})}>
          Settings
        </button>
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
                className={`text-button dictate ${dictation.recording ? 'recording' : ''}`}
                onClick={() => {
                  setProblem(null)
                  void dictation.toggle()
                }}
                disabled={dictation.transcribing}
                aria-pressed={dictation.recording}
              >
                {dictation.transcribing
                  ? 'Transcribing…'
                  : dictation.recording
                    ? '● Stop'
                    : '🎙 Dictate'}
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
                          : s.cli === 'harness'
                            ? '⬢'
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
                    onChange={(e) => {
                      const cli = e.target.value as Cli
                      const model = DEFAULT_MODEL[cli]
                      patch(s.id, {
                        cli,
                        model,
                        resolvedModel: undefined,
                        check: undefined,
                        message: undefined,
                        ...checked.get(checkKey({ cli, model }))
                      })
                    }}
                  >
                    {ORDER.map((c) => (
                      <option key={c} value={c}>
                        {CLI_META[c].name}
                        {installed[c] ? '' : ' (not detected)'}
                      </option>
                    ))}
                  </select>
                </label>
                {s.cli === 'harness' ? (
                  <HarnessFields
                    model={s.model}
                    keys={keys}
                    options={models.harness ?? []}
                    onModel={(model) =>
                      patch(s.id, {
                        model,
                        resolvedModel: undefined,
                        check: undefined,
                        message: undefined
                      })
                    }
                    onKeys={(focus) => setSettings({ focus })}
                  />
                ) : (
                  <label className="field-label">
                    Model
                    <ModelPicker
                      value={s.model ?? ''}
                      options={models[s.cli] ?? []}
                      onChange={(model) => patch(s.id, { model, resolvedModel: undefined })}
                      placeholder={s.resolvedModel ?? 'Automatic · resolved on connection'}
                    />
                  </label>
                )}
                {voices && (
                  <label className="field-label">
                    Voice
                    <select
                      value={s.voice ?? ''}
                      onChange={(e) => patch(s.id, { voice: e.target.value })}
                    >
                      {!s.voice && <option value="">Pick a voice</option>}
                      {VOICES.map((v) => (
                        <option
                          key={v}
                          value={v}
                          disabled={seats.some((x) => x.id !== s.id && x.voice === v)}
                        >
                          {v[0].toUpperCase() + v.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="seat-connection">
                  <span className={`connection-dot ${light(s)}`} />
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
                          : s.cli === 'harness'
                            ? 'Test connection'
                            : installed[s.cli]
                              ? 'Installed · test connection'
                              : 'Not installed · check again'}
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
              <strong>Voices</strong>
              Each seat reads its final answer aloud in its own ElevenLabs voice, through
              OpenRouter. Thinking and votes stay silent.
            </p>
            <label className="voices-toggle">
              <input
                type="checkbox"
                checked={voices}
                onChange={(e) => toggleVoices(e.target.checked)}
              />
              Read turns aloud
            </label>
            <div className="key-status">
              <span
                className={`connection-dot ${keys.openrouter ? 'ok' : voices ? 'error' : ''}`}
                aria-hidden="true"
              />
              <span>
                {keys.openrouter
                  ? 'OpenRouter key ready'
                  : voices
                    ? 'Needs an OpenRouter key'
                    : 'Uses your OpenRouter key'}
              </span>
              <button className="text-button" onClick={() => setSettings({ focus: 'openrouter' })}>
                {keys.openrouter ? 'Change' : 'Add key'}
              </button>
            </div>
          </div>
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
              <ModelPicker
                value={writer?.model ?? ''}
                options={writer ? (models[writer.cli] ?? []) : []}
                onChange={(model) => writer && setWriter({ ...writer, model })}
                disabled={!writer}
                placeholder={
                  !writer
                    ? "The chair's model"
                    : writer.cli === 'harness'
                      ? 'provider:model'
                      : 'CLI default'
                }
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
        <Settings
          open={!!settings}
          focus={settings?.focus}
          keys={keys}
          onClose={() => setSettings(null)}
          onChange={keysChanged}
        />
        <footer className="lobby-footer">
          <span>Several minds. One shared direction.</span>
          <span>Powered by your connected agents</span>
        </footer>
      </main>
    </div>
  )
}

// The Deep-agent seat picks a provider and a model; its key lives in Settings.
function HarnessFields({
  model: value,
  options,
  keys,
  onModel,
  onKeys
}: {
  model?: string
  options: string[] // every harness model, as provider:model
  keys: Partial<Record<ApiProvider, KeySource>>
  onModel: (model: string) => void
  onKeys: (provider: ApiProvider) => void
}): React.JSX.Element {
  const { provider, model } = splitModel(value)
  const { name, env } = API_PROVIDERS[provider]
  const source = keys[provider]
  return (
    <>
      <label className="field-label">
        Provider
        <select value={provider} onChange={(e) => onModel(`${e.target.value}:`)}>
          {PROVIDER_IDS.map((k) => (
            <option key={k} value={k}>
              {API_PROVIDERS[k].name}
              {keys[k] ? '' : ' (no key)'}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        Model
        <ModelPicker
          value={model}
          options={options
            .filter((id) => id.startsWith(`${provider}:`))
            .map((id) => id.slice(provider.length + 1))}
          onChange={(m) => onModel(`${provider}:${m}`)}
          placeholder={provider === 'openrouter' ? 'Search, e.g. glm or opus' : 'Model id'}
        />
      </label>
      <div className="key-status">
        <span className={`connection-dot ${source ? 'ok' : 'error'}`} aria-hidden="true" />
        <span>
          {source === 'saved'
            ? `${name} key saved`
            : source === 'env'
              ? `${name} key from ${env}`
              : `No ${name} key`}
        </span>
        <button className="text-button" onClick={() => onKeys(provider)}>
          {source ? 'Change' : 'Add key'}
        </button>
      </div>
    </>
  )
}
