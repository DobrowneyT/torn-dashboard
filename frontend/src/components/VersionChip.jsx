import { useState } from 'react'
import { useFactionIdentity, isFactionIdentityResolved } from '../utils/factionIdentity'
import { versionLabel } from '../utils/versionLabel'

// The app version, always on screen (#394).
//
// It used to live only in the footer, so reading it meant scrolling to the
// bottom — which is why nobody ever quoted it in a bug report. The version is
// the first thing anyone asks for, and #382 exists because people were running
// stale builds without knowing it.
//
// The stale state is shown HERE rather than only in UpdateBanner, so "what
// version am I on" and "am I out of date" are one place, not two.
//
// ⚠️ This component must never call useVersionGate(). App.jsx already does, and
// that hook has side effects — a five-minute poll, a visibilitychange listener,
// and on the War Room an outright window.location.reload(). A second call would
// arm a second interval and a second reload path. The values come in as props.
export default function VersionChip({ servingVersion, variant = 'header' }) {
  const faction = useFactionIdentity()
  const [copied, setCopied] = useState(false)

  const label = versionLabel({
    running: import.meta.env.VITE_APP_VERSION,
    // useVersionGate returns a version only when it has actually observed a
    // newer one, so null here means "current, or nothing known yet" — either
    // way there is nothing to warn about.
    serving: servingVersion,
    slug: faction.slug,
    resolved: isFactionIdentityResolved(),
  })

  // No version, no claim.
  if (!label) return null

  const handleClick = async () => {
    if (label.stale) { window.location.reload(); return }
    try {
      // Unavailable on insecure origins. If it throws, the text is still
      // selectable — that is the fallback, so swallow rather than alarm.
      await navigator.clipboard.writeText(label.copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* selection still works */
    }
  }

  const base = label.stale
    ? 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20'
    : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700'

  if (variant === 'menu') {
    return (
      <button
        onClick={handleClick}
        title={label.title}
        className={`w-full text-left px-4 py-2 text-xs font-mono select-text ${base}`}
      >
        {copied ? 'Copied' : label.copyText}
      </button>
    )
  }

  return (
    <button
      onClick={handleClick}
      title={label.title}
      aria-label={label.title}
      // select-text, deliberately: if the point is bug reports, it has to be
      // highlightable as well as clickable.
      className={`hidden sm:inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono select-text transition-colors ${base}`}
    >
      {copied ? 'Copied' : label.text}
    </button>
  )
}
