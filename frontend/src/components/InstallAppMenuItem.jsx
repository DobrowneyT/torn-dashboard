// "Install app" affordance (#206), rendered inside the Settings dropdown.
// On Chrome/Edge/Android it fires the native install prompt; on iOS Safari
// (which has no programmatic prompt) it opens Add-to-Home-Screen instructions.
// Renders nothing when already installed or when there's nothing to offer.
import { useState } from 'react'
import { Download, Share, Plus, X } from 'lucide-react'
import { usePwaInstall } from '../hooks/usePwaInstall'

export default function InstallAppMenuItem({ onAction }) {
  const { affordance, promptInstall } = usePwaInstall()
  const [showIos, setShowIos] = useState(false)

  if (affordance === 'none') return null

  async function handleClick() {
    if (affordance === 'button') {
      await promptInstall()
      onAction?.()
    } else {
      setShowIos(true)
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2"
      >
        <Download className="w-4 h-4" />
        Install app
      </button>

      {showIos && <IosInstallModal onClose={() => { setShowIos(false); onAction?.() }} />}
    </>
  )
}

function IosInstallModal({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-sm w-full mx-4">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add to Home Screen</h3>
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            iOS installs from Safari's share menu — there's no automatic prompt.
          </p>
          <ol className="space-y-3 text-sm text-gray-700 dark:text-gray-300">
            <li className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold">1</span>
              <span className="flex items-center gap-1.5">Tap the <Share className="w-4 h-4 inline" /> Share button in Safari's toolbar.</span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold">2</span>
              <span className="flex items-center gap-1.5">Choose <Plus className="w-4 h-4 inline" /> <strong>Add to Home Screen</strong>.</span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-xs font-semibold">3</span>
              <span>Tap <strong>Add</strong> — the dashboard launches from your home screen like an app.</span>
            </li>
          </ol>
          <div className="mt-5 flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Got it</button>
          </div>
        </div>
      </div>
    </div>
  )
}
