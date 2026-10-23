import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The data folder (sessions, Deep-agent memory, keys) is shared by the desktop app and the API
// server, so a meeting started from either shows up in both. Outside Electron `app` is undefined:
// use the folder Electron would pick for this app.
export function dataDir(): string {
  if (process.env.CONSORTIUM_DATA) return process.env.CONSORTIUM_DATA
  if (process.versions.electron && app) return app.getPath('userData')
  const name = 'consortium-ai' // Electron names it after package.json's "name"
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name)
}
