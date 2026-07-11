// Global Admin (slice #74): cross-faction oversight surface — scraper job
// control (enable/disable, run now), run history, and key-pool health.
// Admin-only (server-enforced); API mode only.
import { useEffect, useState, useCallback } from 'react'
import { API_MODE, apiGet, apiPost, apiPut } from '../utils/apiClient'
import { CheckCircle2, AlertTriangle, Loader2, Play, RefreshCw } from 'lucide-react'

function Card({ title, action, children }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}

function ScheduleCell({ job, onSave, disabled }) {
  const [value, setValue] = useState(job.cron_schedule)
  const dirty = value !== job.cron_schedule
  return (
    <span className="inline-flex items-center gap-1">
      <input value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled}
        spellCheck={false}
        className="font-mono text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-gray-100 w-36" />
      {dirty && (
        <button onClick={() => onSave(value)} disabled={disabled}
          className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs">
          Save
        </button>
      )}
    </span>
  )
}

function StatusBadge({ status }) {
  const styles = {
    success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    failure: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'}`}>
      {status}
    </span>
  )
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

export default function GlobalAdminView() {
  const [jobs, setJobs] = useState([])
  const [runs, setRuns] = useState([])
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyJob, setBusyJob] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      const [jobsData, runsData, keysData] = await Promise.all([
        apiGet('/api/admin/scraper/jobs').catch((e) => ({ jobs: [], _err: e })),
        apiGet('/api/admin/scraper/runs?limit=30'),
        apiGet('/api/admin/key-pool'),
      ])
      setJobs(jobsData.jobs || [])
      if (jobsData._err) setNotice({ kind: 'err', msg: jobsData._err.payload?.error || jobsData._err.message })
      setRuns(runsData.runs || [])
      setKeys(keysData.keys || [])
      setError(null)
    } catch (err) {
      setError(err.payload?.error || err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleJob(job) {
    setBusyJob(job.job_name)
    try {
      await apiPut(`/api/admin/scraper/jobs/${job.job_name}`, { enabled: !job.enabled })
      await load()
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setBusyJob(null)
    }
  }

  async function saveSchedule(job, cron_schedule) {
    setBusyJob(job.job_name)
    setNotice(null)
    try {
      await apiPut(`/api/admin/scraper/jobs/${job.job_name}`, { cron_schedule })
      setNotice({ kind: 'ok', msg: `${job.job_name} cadence saved — applies on the API's next restart.` })
      await load()
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setBusyJob(null)
    }
  }

  async function runJob(job) {
    setBusyJob(job.job_name)
    setNotice(null)
    try {
      const { run } = await apiPost(`/api/admin/scraper/jobs/${job.job_name}/run`, {})
      setNotice(run.status === 'success'
        ? { kind: 'ok', msg: `${job.job_name}: ${run.rows_written} rows written` }
        : { kind: 'err', msg: `${job.job_name} failed: ${run.error}` })
      await load()
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setBusyJob(null)
    }
  }

  if (!API_MODE) {
    return (
      <div className="text-gray-600 dark:text-gray-400 text-sm">
        The global-admin surface lives on the new API stack — not available on this deployment.
      </div>
    )
  }
  if (loading) return <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
  if (error) {
    return (
      <div className="flex items-center gap-2 text-red-600 dark:text-red-400 text-sm">
        <AlertTriangle className="w-4 h-4" /> {error}
      </div>
    )
  }

  const refreshBtn = (
    <button onClick={load} title="Refresh"
      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
      <RefreshCw className="w-4 h-4" />
    </button>
  )

  return (
    <div className="space-y-6">
      {notice && (
        <div className={`flex items-center gap-2 text-sm ${notice.kind === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
          {notice.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {notice.msg}
        </div>
      )}

      <Card title="Scraper Jobs" action={refreshBtn}>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Enable/disable applies on the next tick; cadence edits apply on the API's next restart.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4">Schedule</th>
                <th className="py-2 pr-4">Enabled</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.job_name} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{job.job_name}</td>
                  <td className="py-2 pr-4">
                    <ScheduleCell job={job} disabled={busyJob !== null}
                      onSave={(v) => saveSchedule(job, v)} />
                  </td>
                  <td className="py-2 pr-4">
                    <button onClick={() => toggleJob(job)} disabled={busyJob === job.job_name}
                      className={`px-2 py-0.5 rounded text-xs font-medium ${job.enabled
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-gray-200 text-gray-600 dark:bg-slate-700 dark:text-gray-400'}`}>
                      {job.enabled ? 'enabled' : 'disabled'}
                    </button>
                  </td>
                  <td className="py-2">
                    <button onClick={() => runJob(job)} disabled={busyJob !== null}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs">
                      {busyJob === job.job_name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      Run now
                    </button>
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr><td colSpan="4" className="py-3 text-gray-500 dark:text-gray-400">
                  Scrapers are not configured on this API (KEY_ENCRYPTION_KEY).
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Recent Runs">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="py-2 pr-4">Job</th>
                <th className="py-2 pr-4">Started</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">{run.job_name}</td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300 whitespace-nowrap">{fmtTime(run.started_at)}</td>
                  <td className="py-2 pr-4"><StatusBadge status={run.status} /></td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{run.rows_written}</td>
                  <td className="py-2 text-red-500 dark:text-red-400 text-xs max-w-md truncate" title={run.error || ''}>{run.error || ''}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan="5" className="py-3 text-gray-500 dark:text-gray-400">No runs recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Key Pool Health">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Metadata only — key material never leaves the server. Members join the pool by logging in.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <th className="py-2 pr-4">Member</th>
                <th className="py-2 pr-4">Level</th>
                <th className="py-2 pr-4">Consent</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Last claimed</th>
                <th className="py-2">Last error</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.member_id} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">{k.member_name || k.member_id}</td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{k.key_level ?? '—'}</td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{k.consent_version || '—'}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={k.disabled ? 'failure' : 'success'} />
                  </td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300 whitespace-nowrap">{fmtTime(k.last_claimed_at)}</td>
                  <td className="py-2 text-red-500 dark:text-red-400 text-xs max-w-md truncate" title={k.last_error || ''}>{k.last_error || ''}</td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr><td colSpan="6" className="py-3 text-gray-500 dark:text-gray-400">The pool is empty — no member has logged in yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
