/**
 * "There's a newer build" prompt (#382).
 *
 * Shown where a forced reload would be rude — anywhere the user might be
 * part-way through typing. On the War Room the gate reloads instead and this
 * never appears, except in the one case worth surfacing: a reload that did not
 * take, where spinning would be worse than telling someone.
 */
export default function UpdateBanner({ version }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 px-4 py-2 text-sm bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-b border-amber-200 dark:border-amber-900"
    >
      <span>
        A newer version{version ? ` (${version})` : ''} of the dashboard is available.
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-2.5 py-1 rounded font-medium bg-amber-600 text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500"
      >
        Reload
      </button>
    </div>
  )
}
