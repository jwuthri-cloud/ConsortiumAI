import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { Brief, Cli, DebateEvent } from '../shared/types'
import * as debate from './debate'
import { detectBins, checkCli, killAll, listModels } from './cli'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    backgroundColor: '#0A0D14',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  if (is.dev) {
    // renderer errors show up in the terminal that runs `npm run dev`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.webContents.on('console-message', (ev: any, ...rest: any[]) => {
      const d = ev && typeof ev.message === 'string' ? ev : { level: rest[0], message: rest[1] }
      if (d.level === 'error' || d.level === 3) console.error('[renderer]', d.message)
    })
  }
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ai.consortium')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  debate.configure(app.getPath('userData'))

  const send = (e: DebateEvent): void => {
    win?.webContents.send('debate:event', e)
  }
  ipcMain.handle('debate:start', (_, brief: Brief, id: string) => debate.runDebate(brief, send, id))
  ipcMain.handle('debate:stop', () => debate.stop())
  ipcMain.handle('debate:interject', (_, text: string) => debate.interject(text))
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('shell:reveal', (_, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('cli:detect', () => detectBins())
  ipcMain.handle('cli:check', (_, cli: Cli) => checkCli(cli))
  ipcMain.handle('cli:models', (_, cli: Cli) => listModels(cli))
  ipcMain.handle('sessions:list', () => debate.listSessions())
  ipcMain.handle('sessions:load', (_, id: string) => debate.loadSession(id))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => killAll())
app.on('window-all-closed', () => {
  killAll()
  app.quit()
})
