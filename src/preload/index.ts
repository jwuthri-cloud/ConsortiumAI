import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, Brief, Cli, DebateEvent } from '../shared/types'

const api: Api = {
  start: (brief: Brief, sessionId: string) => ipcRenderer.invoke('debate:start', brief, sessionId),
  stop: () => ipcRenderer.invoke('debate:stop'),
  interject: (text: string) => ipcRenderer.invoke('debate:interject', text),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  detect: () => ipcRenderer.invoke('cli:detect'),
  check: (cli: Cli) => ipcRenderer.invoke('cli:check', cli),
  models: (cli: Cli) => ipcRenderer.invoke('cli:models', cli),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id: string) => ipcRenderer.invoke('sessions:load', id),
  onEvent: (cb) => {
    const h = (_: IpcRendererEvent, e: DebateEvent): void => cb(e)
    ipcRenderer.on('debate:event', h)
    return () => ipcRenderer.off('debate:event', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
