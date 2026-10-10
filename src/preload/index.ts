import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Api, ApiProvider, Brief, Cli, DebateEvent } from '../shared/types'

const api: Api = {
  start: (brief: Brief, sessionId: string) => ipcRenderer.invoke('debate:start', brief, sessionId),
  stop: () => ipcRenderer.invoke('debate:stop'),
  resume: (sessionId: string) => ipcRenderer.invoke('debate:resume', sessionId),
  pause: (on: boolean) => ipcRenderer.invoke('debate:pause', on),
  spoken: (id: string, turn: number) => ipcRenderer.invoke('debate:spoken', id, turn),
  host: (input) => ipcRenderer.invoke('debate:host', input),
  conclude: () => ipcRenderer.invoke('debate:conclude'),
  refreshBoard: () => ipcRenderer.invoke('debate:refreshBoard'),
  interject: (text: string) => ipcRenderer.invoke('debate:interject', text),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  saveFile: (name: string, data: ArrayBuffer) => ipcRenderer.invoke('file:save', name, data),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  transcribe: (path: string) => ipcRenderer.invoke('stt:transcribe', path),
  reveal: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  detect: () => ipcRenderer.invoke('cli:detect'),
  check: (cli: Cli, model?: string) => ipcRenderer.invoke('cli:check', cli, model),
  models: (cli: Cli) => ipcRenderer.invoke('cli:models', cli),
  keys: () => ipcRenderer.invoke('keys:list'),
  setKey: (p: ApiProvider, key: string) => ipcRenderer.invoke('keys:set', p, key),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id: string) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  onEvent: (cb) => {
    const h = (_: IpcRendererEvent, e: DebateEvent): void => cb(e)
    ipcRenderer.on('debate:event', h)
    return () => ipcRenderer.off('debate:event', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
