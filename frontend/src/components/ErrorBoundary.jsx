import { Component } from 'react'

/**
 * Catches React render/lifecycle errors in its children and shows a
 * recovery panel with copyable error details, so testers can report
 * crashes to MonChoon without losing context (the app stays mounted).
 */
export default class ErrorBoundary extends Component {
  state = { error: null, info: null, copied: false }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ error, info })
    console.error(`[ErrorBoundary:${this.props.name ?? 'unknown'}]`, error, info)
  }

  buildReport() {
    const { error, info } = this.state
    const lines = [
      `Component: ${this.props.name ?? 'unknown'}`,
      `URL:       ${typeof window !== 'undefined' ? window.location.href : 'n/a'}`,
      `UA:        ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
      `Time:      ${new Date().toISOString()}`,
      ``,
      `Error: ${error?.name ?? 'Error'}: ${error?.message ?? 'unknown'}`,
      ``,
      `Stack:`,
      error?.stack ?? '(no stack available)',
      ``,
      `Component stack:`,
      info?.componentStack ?? '(no component stack)',
    ]
    return lines.join('\n')
  }

  async handleCopy() {
    try {
      await navigator.clipboard.writeText(this.buildReport())
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // Clipboard API not available — user can manually select the textarea
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const report = this.buildReport()

    return (
      <div className="card border-red-300 dark:border-red-700">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-3xl" aria-hidden>⚠️</span>
          <div>
            <h2 className="text-lg font-bold text-red-700 dark:text-red-400">
              {this.props.name ?? 'This page'} crashed
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Send this report to MonChoon so it can be fixed.
            </p>
          </div>
        </div>

        <div className="mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm font-mono text-red-700 dark:text-red-300 break-all">
            {this.state.error.message || 'Unknown error'}
          </p>
        </div>

        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
          Full report (copy or screenshot this):
        </label>
        <textarea
          readOnly
          value={report}
          onClick={e => e.target.select()}
          className="w-full h-72 px-3 py-2 text-xs font-mono border border-gray-300 dark:border-slate-600 rounded-lg bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-gray-200 resize-y"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => this.handleCopy()}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            {this.state.copied ? '✓ Copied' : 'Copy to Clipboard'}
          </button>
          <button
            onClick={() => this.setState({ error: null, info: null })}
            className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors"
          >
            Reload Page
          </button>
        </div>
      </div>
    )
  }
}
