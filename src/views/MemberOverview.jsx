import { useEffect, useState } from 'react'
import { supabase } from '../utils/supabase'

/**
 * Leadership > Member Overview
 *
 * Phase 1 scaffold — simple list of current faction members so the Leadership
 * page has something to land on. Phase 5 replaces this with the full telemetry
 * view (filters, time windows, color-coded compliance against the faction's
 * requirements). See the plan file for details.
 */
export default function MemberOverview() {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('members')
        .select('member_id, member_name, tier, last_scraped')
        .eq('is_current', true)
        .order('member_name', { ascending: true })
      if (cancelled) return
      if (error) {
        setError(error.message)
      } else {
        setMembers(data ?? [])
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading members…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card border-red-300 dark:border-red-700">
        <p className="text-sm text-red-600 dark:text-red-400">Failed to load members: {error}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Member Overview</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">{members.length} current members</span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Full telemetry view (filters, time windows, requirement warnings) coming in the next pass.
          For now this is a basic list of current faction members.
        </p>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                <th className="py-2.5 px-4 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700">Name</th>
                <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700">Tier</th>
                <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800/80 border-b border-gray-200 dark:border-slate-700">Last Scraped</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, idx) => (
                <tr key={m.member_id} className={idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/50 dark:bg-slate-800/40'}>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <a
                      href={`https://www.torn.com/profiles.php?XID=${m.member_id}`}
                      target="_blank" rel="noopener noreferrer"
                      className="font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {m.member_name}
                    </a>
                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-600">[{m.member_id}]</span>
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap text-gray-700 dark:text-gray-300">
                    {m.tier ?? '—'}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                    {m.last_scraped ? new Date(m.last_scraped).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
