// usePwaInstall (#206) — wires the live browser install events to the pure
// helpers in utils/pwa.js and exposes a small, UI-friendly surface:
//   affordance   'none' | 'button' | 'ios'  — what to render
//   promptInstall()  triggers the native prompt (Chrome/Edge/Android)
//   standalone       already installed?
import { useCallback, useEffect, useState } from 'react'
import {
  installAffordance,
  isInstallDismissed,
  isIos,
  isStandalone,
  markInstallDismissed,
} from '../utils/pwa'

export function usePwaInstall() {
  const [deferred, setDeferred] = useState(null)   // captured beforeinstallprompt
  const [standalone, setStandalone] = useState(() => isStandalone())
  const [dismissed, setDismissed] = useState(() => isInstallDismissed())
  const ios = isIos()

  useEffect(() => {
    // Chrome/Edge/Android fire this instead of showing their own banner; stash
    // it so an in-app button can call .prompt() later.
    function onBeforeInstall(e) {
      e.preventDefault()
      setDeferred(e)
    }
    // Once installed, retract every affordance.
    function onInstalled() {
      setDeferred(null)
      setStandalone(true)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferred) return null
    deferred.prompt()
    const choice = await deferred.userChoice.catch(() => null)
    // A prompt can only be used once; drop it whatever the user chose.
    setDeferred(null)
    return choice?.outcome ?? null
  }, [deferred])

  const dismiss = useCallback(() => {
    markInstallDismissed()
    setDismissed(true)
  }, [])

  const affordance = installAffordance({ standalone, ios, hasPrompt: !!deferred, dismissed })

  return { affordance, standalone, ios, promptInstall, dismiss }
}
