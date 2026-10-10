import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_PROVIDERS, type ApiProvider, type KeySource } from '../shared/types'

// API keys for the harness seat, encrypted with the OS keychain (safeStorage), never sent to the renderer.
// An environment variable (OPENROUTER_API_KEY, …) works too, for `npm run dev` from a shell.
const file = (): string => join(app.getPath('userData'), 'keys.json')

function stored(): Partial<Record<ApiProvider, string>> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

export function getKey(p: ApiProvider): string | undefined {
  const enc = stored()[p]
  if (enc)
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      /* keychain entry gone: fall back to the environment */
    }
  return process.env[API_PROVIDERS[p].env] || undefined
}

export function setKey(p: ApiProvider, key: string): void {
  if (!(p in API_PROVIDERS)) throw new Error(`Unknown provider ${p}`)
  const all = stored()
  if (key.trim()) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error(`No keychain to store the key in. Set ${API_PROVIDERS[p].env} instead.`)
    all[p] = safeStorage.encryptString(key.trim()).toString('base64')
  } else delete all[p]
  writeFileSync(file(), JSON.stringify(all), { mode: 0o600 })
}

export function listKeys(): Record<ApiProvider, KeySource> {
  const all = stored()
  return Object.fromEntries(
    (Object.keys(API_PROVIDERS) as ApiProvider[]).map((p) => [
      p,
      all[p] ? 'saved' : process.env[API_PROVIDERS[p].env] ? 'env' : null
    ])
  ) as Record<ApiProvider, KeySource>
}
