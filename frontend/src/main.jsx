import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { registerServiceWorker } from './utils/registerSw'
import { translatePathToHash } from './utils/pathToHashRoute'

// #969 — before the hash router reads the URL. The Discord bot's sign-up link
// is path-style (`/members/chain-watch`) and used to land on the home page.
translatePathToHash()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// PWA (#206): install the app-shell service worker in production builds.
registerServiceWorker()