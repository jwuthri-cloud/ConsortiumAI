import { useEffect, useRef, useState } from 'react'
import { API_PROVIDERS, type ApiProvider, type KeySource } from '@shared/types'

const PROVIDER_IDS = Object.keys(API_PROVIDERS) as ApiProvider[]

const ipcError = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )

type Props = {
  open: boolean
  focus?: ApiProvider // the provider whose key field gets the cursor
  keys: Partial<Record<ApiProvider, KeySource>>
  onClose: () => void
  onChange: () => Promise<void>
}

// App settings: the API keys the Deep-agent seat runs on. The page never sees a saved key, only where it comes from.
export default function Settings({
  open,
  focus,
  keys,
  onClose,
  onChange
}: Props): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      d.querySelector<HTMLInputElement>(`[data-provider="${focus ?? ''}"]`)?.focus()
    }
    if (!open && d.open) d.close()
  }, [open, focus])
  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()} // a click on the backdrop
    >
      <div className="settings-body">
        <header>
          <h2>Settings</h2>
          <button className="text-button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        <h3>API keys</h3>
        <p className="settings-note">
          The Deep-agent seat runs on these; its web search and the voices use the OpenRouter key.
          Each key is encrypted with your macOS keychain and only ever sent to its own provider. An
          environment variable works too.
        </p>
        {PROVIDER_IDS.map((p) => (
          <KeyRow key={p} provider={p} source={keys[p] ?? null} onChange={onChange} />
        ))}
      </div>
    </dialog>
  )
}

function KeyRow({
  provider,
  source,
  onChange
}: {
  provider: ApiProvider
  source: KeySource
  onChange: () => Promise<void>
}): React.JSX.Element {
  const { name, env } = API_PROVIDERS[provider]
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const save = async (key: string): Promise<void> => {
    try {
      await window.api!.setKey(provider, key)
      setDraft('')
      setError(undefined)
      await onChange()
    } catch (e) {
      setError(ipcError(e))
    }
  }
  return (
    <div className="key-setting">
      <span className={`connection-dot ${source ? 'ok' : 'error'}`} aria-hidden="true" />
      <div className="key-name">
        <strong>{name}</strong>
        <span>{source === 'saved' ? 'Saved' : source === 'env' ? `From ${env}` : 'No key'}</span>
      </div>
      <input
        type="password"
        data-provider={provider}
        aria-label={`${name} API key`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && draft.trim() && void save(draft)}
        placeholder={source ? 'Paste to replace' : 'Paste a key'}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="secondary-button"
        disabled={!draft.trim()}
        onClick={() => void save(draft)}
      >
        Save
      </button>
      <button
        className="text-button"
        disabled={source !== 'saved'}
        onClick={() => void save('')}
        title={source === 'env' ? `Set by ${env}, outside the app` : undefined}
      >
        Remove
      </button>
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
