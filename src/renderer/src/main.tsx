import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { mockApi } from './mockApi'

// Browser preview (vite dev URL opened outside Electron): no preload, so fake the bridge.
if (!window.api) window.api = mockApi

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
