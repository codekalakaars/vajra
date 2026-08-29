// Entry point: boot client, render initial view, wire routing.

import { VajraClient } from './client.js'
import { Router } from './router.js'
import { initSidebar } from './components/sidebar.js'
import { chatView } from './views/chat.js'

// Option A: explicit WS port for split dev (web :8080, server :4820).
// When served via esbuild on 8080, window.location.port is 8080 — would try
// ws://:8080 and fail (no WS there). Always use server port 4820 in dev.
// When unified on 4820 later, this still works (same port).
const WS_URL = `ws://${window.location.hostname}:4820`

const client = new VajraClient(WS_URL)
const router = new Router()
const appRoot = document.getElementById('app-root')!
const connStatus = document.getElementById('connection-status')!
const statusDot = connStatus.querySelector('.status-dot')!
const statusText = connStatus.querySelector('.status-text')!

let currentCleanup: (() => void) | null = null

// Connection state
client.onStateChange((state) => {
  statusDot.className = `status-dot ${state === 'connected' ? 'connected' : ''}`
  statusText.textContent = state.charAt(0).toUpperCase() + state.slice(1)
})

// Handle incoming messages
client.onStateChange(() => {})

// Route handlers — chat is the only main view; permissions/sessions are via sidebar.
router.on('/', () => {
  currentCleanup?.()
  const { el, cleanup } = chatView(client, {})
  currentCleanup = cleanup
  appRoot.innerHTML = ''
  appRoot.appendChild(el)
})

router.on('/session/:id', (params) => {
  currentCleanup?.()
  const { el, cleanup } = chatView(client, params)
  currentCleanup = cleanup
  appRoot.innerHTML = ''
  appRoot.appendChild(el)
})

// Boot
initSidebar(client)
client.connect()
router.start()
