// Global Admin (slice #74): cross-faction oversight surface — scraper job
// control (enable/disable, run now), run history, and key-pool health.
// Admin-only (server-enforced); API mode only.
import { Fragment, useEffect, useState, useCallback, useMemo } from 'react'
import { apiGet, apiPost, apiPut } from '../utils/apiClient'
import { fmtDbTime } from '../utils/time'
import { keyPoolStatus, sortKeyPoolRows } from '../utils/keyPoolTable'
import { scraperJobSummary } from '../utils/scraperJobInfo'
import InfoTooltip from '../components/InfoTooltip'
import CronEditor from '../components/CronEditor'
import { describeCron, minuteLoad } from '../utils/cronSentence'
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

// Where a cadence came from (#609 slice 5). Three layers: this faction's own
// override, the fleet default set in the control plane, and the code default.
//
// ⚠️ The source is shown, not just the value. Without it a fleet-wide change
// looks like a local one nobody remembers making — and the first instinct on
// seeing an unfamiliar cadence would be to type over it, silently converting a
// managed default into a permanent per-faction override.
const SCHEDULE_SOURCE = {
  tenant: { label: 'this faction', className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300' },
  fleet: { label: 'fleet default', className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300' },
  default: { label: 'built-in', className: 'bg-gray-200 text-gray-600 dark:bg-slate-700 dark:text-gray-400' },
}

/**
 * The cadence, at rest (#756).
 *
 * ⚠️ A reading surface, not a control. This was an always-live text input on
 * every one of 19 rows, for a value changed maybe twice a year — and it put
 * raw six-field cron on screen, where `*​/5 * * * *` (five minutes) and
 * `*​/5 * * * * *` (five SECONDS) are near enough identical to type by mistake.
 * Dropping the input chrome makes the row SHORTER than it was, so the editor
 * that opens underneath is not paid for out of the resting state.
 */
function ScheduleCell({ job, expanded, onToggle, disabled }) {
  const effective = job.effective_schedule ?? ''
  const source = SCHEDULE_SOURCE[job.schedule_source] ?? SCHEDULE_SOURCE.default

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <InfoTooltip label={describeCron(effective)} className="text-gray-900 dark:text-gray-100">
        <div className="font-mono">{effective}</div>
        <div className="mt-1.5">Following the {source.label}.</div>
      </InfoTooltip>
      <InfoTooltip
        label={source.label}
        decoration="no-underline"
        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${source.className}`}
      >
        {job.cron_schedule
          ? 'This faction overrides the default.'
          : `Following the ${source.label}: ${effective}`}
      </InfoTooltip>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Close' : 'Edit'} schedule for ${job.job_name}`}
        className={`px-1.5 py-0.5 rounded text-xs disabled:opacity-50 ${
          expanded
            ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30'
            : 'text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30'
        }`}
      >
        ✎
      </button>
      {job.rejected_schedule != null && (
        <InfoTooltip className="text-[10px] text-red-600 dark:text-red-400" label={<>
          invalid — using {job.effective_schedule}
        </>}>
          Ignored: {job.rejected_schedule}
        </InfoTooltip>
      )}
    </span>
  )
}

/**
 * How crowded each minute of the hour already is (#756).
 *
 * The thing an admin is actually choosing against when they pick an offset:
 * `revives-sync` sits on :05/:35 to stay clear of the hourly jobs, and
 * `crime-occupancy` uses the seconds field for the same reason. It sits beside
 * the table rather than inside a modal, because it is only useful while the
 * schedule being edited is on screen next to it.
 */
function MinuteLoadStrip({ jobs }) {
  const load = useMemo(
    () => minuteLoad(jobs.map((j) => j.effective_schedule).filter(Boolean)),
    [jobs],
  )
  if (load.busiest === 0) return null
  const pad2 = (n) => String(n).padStart(2, '0')

  return (
    <div className="space-y-1.5">
      <div className="flex items-end gap-px h-10" role="img"
        aria-label={`Job count per minute of the hour; busiest is :${pad2(load.busiestMinute)} with ${load.busiest}`}>
        {load.counts.map((c, m) => (
          <span
            key={m}
            title={`:${pad2(m)} — ${c} job${c === 1 ? '' : 's'}`}
            style={{ height: `${Math.max(8, Math.round((c / load.busiest) * 100))}%` }}
            className={`flex-1 rounded-t-sm ${
              c === 0 ? 'bg-gray-200 dark:bg-slate-700'
                : c >= load.busiest ? 'bg-red-500'
                  : 'bg-blue-500'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Busiest minute is <span className="font-mono">:{pad2(load.busiestMinute)}</span>{' '}
        with {load.busiest} {load.busiest === 1 ? 'job' : 'jobs'} — pick a quiet one
        when you add an offset.
        {load.everyMinute > 0 && (
          <>
            {' '}{load.everyMinute} {load.everyMinute === 1 ? 'job runs' : 'jobs run'} every
            minute and {load.everyMinute === 1 ? 'is' : 'are'} counted separately.
          </>
        )}
      </p>
    </div>
  )
}

const SECRET_LABELS = {
  tornstats_api_key: 'TornStats API key',
  bsp_api_key: 'BSP API key',
}

function SecretRow({ secret, onSave, disabled }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 text-sm text-gray-700 dark:text-gray-300">{SECRET_LABELS[secret.name] || secret.name}</span>
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${secret.configured
        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
        : 'bg-gray-200 text-gray-600 dark:bg-slate-700 dark:text-gray-400'}`}>
        {secret.configured ? `configured ••••${secret.hint ?? ''}` : 'not set'}
      </span>
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)}
        placeholder={secret.configured ? 'Replace key…' : 'Enter key…'} disabled={disabled}
        autoComplete="off" spellCheck={false}
        className="px-3 py-1.5 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm text-gray-900 dark:text-white w-64" />
      <button onClick={() => { onSave(value.trim()); setValue('') }} disabled={disabled || !value.trim()}
        className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm">
        Save
      </button>
    </div>
  )
}

function StatusBadge({ status }) {
  const styles = {
    success: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    active: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    failure: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    disabled: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    missing: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    'no-faction-access': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  }
  const labels = { missing: 'Missing', 'no-faction-access': 'No faction access' }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'}`}>
      {labels[status] || status}
    </span>
  )
}

// A sortable table header cell: click to sort by `col`, click again to flip.
function SortableTh({ label, col, sort, onSort, last }) {
  const active = sort.key === col
  return (
    <th
      className={`py-2 ${last ? '' : 'pr-4'} cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={active ? '' : 'opacity-0'}>{sort.dir === 'asc' ? '↑' : '↓'}</span>
      </span>
    </th>
  )
}



export default function GlobalAdminView() {
  const [jobs, setJobs] = useState([])
  const [runs, setRuns] = useState([])
  const [keys, setKeys] = useState([])
  const [secrets, setSecrets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyJob, setBusyJob] = useState(null)
  const [editingJob, setEditingJob] = useState(null)
  const [notice, setNotice] = useState(null)
  // Key Pool Health sort (all columns). Default: missing members surfaced first.
  const [keySort, setKeySort] = useState({ key: 'status', dir: 'desc' })

  const sortedKeys = useMemo(() => sortKeyPoolRows(keys, keySort.key, keySort.dir), [keys, keySort])
  const keyTotals = useMemo(() => ({
    total: keys.filter((k) => !k.missing).length,
    missing: keys.filter((k) => k.missing).length,
  }), [keys])
  const toggleKeySort = (key) =>
    setKeySort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))

  const load = useCallback(async () => {
    try {
      const [jobsData, runsData, keysData, secretsData] = await Promise.all([
        apiGet('/api/admin/scraper/jobs').catch((e) => ({ jobs: [], _err: e })),
        apiGet('/api/admin/scraper/runs?limit=30'),
        apiGet('/api/admin/key-pool'),
        apiGet('/api/admin/secrets').catch(() => ({ secrets: [] })),
      ])
      setJobs(jobsData.jobs || [])
      if (jobsData._err) setNotice({ kind: 'err', msg: jobsData._err.payload?.error || jobsData._err.message })
      setRuns(runsData.runs || [])
      setKeys(keysData.keys || [])
      setSecrets(secretsData.secrets || [])
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
      setNotice({
        kind: 'ok',
        msg: cron_schedule === null
          ? `${job.job_name} now follows the default — applies on the API's next restart.`
          : `${job.job_name} cadence saved — applies on the API's next restart.`,
      })
      setEditingJob(null)
      await load()
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setBusyJob(null)
    }
  }

  async function saveSecret(secret, value) {
    setNotice(null)
    try {
      await apiPut(`/api/admin/secrets/${secret.name}`, { value })
      setNotice({ kind: 'ok', msg: `${SECRET_LABELS[secret.name] || secret.name} saved.` })
      await load()
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    }
  }

  // Poll the run log until a specific run settles, refreshing the table as it
  // goes. Manual triggers now return immediately with a 'running' record (the
  // job runs in the background so a minutes-long job can't 502 the request), so
  // we watch it here instead of blocking on the trigger call.
  async function pollRunUntilDone(runId, { tries = 60, intervalMs = 4000 } = {}) {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, intervalMs))
      let data
      try { data = await apiGet('/api/admin/scraper/runs?limit=30') } catch { continue }
      setRuns(data.runs || [])
      const found = (data.runs || []).find((r) => r.id === runId)
      if (found && found.status !== 'running') return found
    }
    return null
  }

  async function runJob(job) {
    setBusyJob(job.job_name)
    setNotice(null)
    try {
      const { run } = await apiPost(`/api/admin/scraper/jobs/${job.job_name}/run`, {})
      if (run.status === 'running' && run.id != null) {
        setNotice({ kind: 'ok', msg: `${job.job_name}: started — running in the background…` })
        await load()
        const settled = await pollRunUntilDone(run.id)
        if (settled) {
          setNotice(settled.status === 'success'
            ? { kind: 'ok', msg: `${job.job_name}: ${settled.rows_written} rows written` }
            : { kind: 'err', msg: `${job.job_name} failed: ${settled.error}` })
        }
      } else {
        // Defensive: a run that already settled synchronously.
        setNotice(run.status === 'success'
          ? { kind: 'ok', msg: `${job.job_name}: ${run.rows_written} rows written` }
          : { kind: 'err', msg: `${job.job_name} failed: ${run.error}` })
        await load()
      }
    } catch (err) {
      setNotice({ kind: 'err', msg: err.payload?.error || err.message })
    } finally {
      setBusyJob(null)
    }
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
    <button onClick={load} aria-label="Refresh"
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
                <Fragment key={job.job_name}>
                <tr className={`border-gray-100 dark:border-slate-700/50 ${editingJob === job.job_name ? '' : 'border-b'}`}>
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">
                    {/* Was a native `title`, which mobile browsers show on
                        neither tap nor long press — so on a phone the whole
                        description was unreachable, with nothing on screen to
                        say anything was missing (#604). */}
                    <InfoTooltip label={job.job_name} className="font-medium">
                      {scraperJobSummary(job.job_name)}
                    </InfoTooltip>
                  </td>
                  <td className="py-2 pr-4">
                    <ScheduleCell
                      job={job}
                      disabled={busyJob !== null}
                      expanded={editingJob === job.job_name}
                      onToggle={() => setEditingJob((cur) => (cur === job.job_name ? null : job.job_name))}
                    />
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
                {editingJob === job.job_name && (
                  <tr className="border-b border-gray-100 dark:border-slate-700/50">
                    <td colSpan="4" className="pb-3 pr-4">
                      <CronEditor
                        value={job.effective_schedule ?? ''}
                        /* Only offer the revert when there IS an override to
                           revert — otherwise the button would write null over
                           null and read as a no-op that did something. */
                        defaultValue={job.cron_schedule != null ? job.effective_schedule : undefined}
                        busy={busyJob !== null}
                        onSave={(v) => saveSchedule(job, v)}
                        onCancel={() => setEditingJob(null)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
              {jobs.length === 0 && (
                <tr><td colSpan="4" className="py-3 text-gray-500 dark:text-gray-400">
                  Scrapers are not configured on this API (KEY_ENCRYPTION_KEY).
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {jobs.length > 0 && <MinuteLoadStrip jobs={jobs} />}
      </Card>

      <Card title="Recent Runs">
        <div className="overflow-auto max-h-[26rem]">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-800">
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
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300 whitespace-nowrap">{fmtDbTime(run.started_at)}</td>
                  <td className="py-2 pr-4"><StatusBadge status={run.status} /></td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{run.rows_written}</td>
                  <td className="py-2 text-red-500 dark:text-red-400 text-xs max-w-md">
                    {run.error
                      ? <InfoTooltip label={<span className="block truncate">{run.error}</span>} decoration="no-underline" className="block min-w-0">{run.error}</InfoTooltip>
                      : ''}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan="5" className="py-3 text-gray-500 dark:text-gray-400">No runs recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Spy Providers">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Per-faction TornStats/BSP keys for Update Spies — stored encrypted; only the last 4 characters are shown.
        </p>
        <div className="space-y-3">
          {secrets.map((secret) => (
            <SecretRow key={secret.name} secret={secret} disabled={busyJob !== null}
              onSave={(v) => saveSecret(secret, v)} />
          ))}
          {secrets.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Secrets need KEY_ENCRYPTION_KEY on the API.</p>
          )}
        </div>
      </Card>

      <Card title="Key Pool Health">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Metadata only — key material never leaves the server. Members join the pool by logging in.
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">
            <span className="font-semibold text-gray-900 dark:text-white">{keyTotals.total}</span> keys
            {keyTotals.missing > 0 && (
              <> · <span className="font-semibold text-red-600 dark:text-red-400">{keyTotals.missing}</span> missing</>
            )}
          </p>
        </div>
        <div className="overflow-auto max-h-[26rem]">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-800">
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-slate-700">
                <SortableTh label="Member"       col="member"       sort={keySort} onSort={toggleKeySort} />
                <SortableTh label="Level"        col="level"        sort={keySort} onSort={toggleKeySort} />
                <SortableTh label="Consent"      col="consent"      sort={keySort} onSort={toggleKeySort} />
                <SortableTh label="Status"       col="status"       sort={keySort} onSort={toggleKeySort} />
                <SortableTh label="Last claimed" col="last_claimed" sort={keySort} onSort={toggleKeySort} />
                <SortableTh label="Last error"   col="last_error"   sort={keySort} onSort={toggleKeySort} last />
              </tr>
            </thead>
            <tbody>
              {sortedKeys.map((k) => (
                <tr key={k.member_id} className="border-b border-gray-100 dark:border-slate-700/50">
                  <td className="py-2 pr-4 text-gray-900 dark:text-white">{k.member_name || k.member_id}</td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{k.key_level ?? '—'}</td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300">{k.consent_version || '—'}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={keyPoolStatus(k)} />
                  </td>
                  <td className="py-2 pr-4 text-gray-600 dark:text-gray-300 whitespace-nowrap">{k.last_claimed_at ? fmtDbTime(k.last_claimed_at) : '—'}</td>
                  <td className="py-2 text-red-500 dark:text-red-400 text-xs max-w-md">
                    {k.last_error
                      ? <InfoTooltip label={<span className="block truncate">{k.last_error}</span>} decoration="no-underline" className="block min-w-0">{k.last_error}</InfoTooltip>
                      : ''}
                  </td>
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
