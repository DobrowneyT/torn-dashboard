export default function StatsOverview({ cprData, crimesData }) {
  const members = cprData?.members || {}
  const crimes = crimesData?.crimes || {}

  const totalMembers = Object.keys(members).length
  
  // Count completed crimes by checking for success/completed statuses
  const completedCrimes = Object.values(crimes).filter(c => {
    const status = c.status?.toLowerCase()
    return status === 'successful' || status === 'success' || status === 'completed'
  })
  
  const totalCrimes = completedCrimes.length
  const totalPayout = completedCrimes.reduce((sum, c) => sum + (c.rewards?.money || 0), 0)

  let totalCpr = 0, cprCount = 0
  Object.values(members).forEach(member => {
    const cprByRole = member.cpr_by_role || {}
    Object.values(cprByRole).forEach(level => {
      Object.values(level).forEach(cpr => {
        if (typeof cpr === 'number') {
          totalCpr += cpr
          cprCount++
        }
      })
    })
  })
  const avgCpr = cprCount > 0 ? (totalCpr / cprCount).toFixed(1) : 0

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label="Total Members" value={totalMembers} />
      <StatCard label="Crimes Completed" value={totalCrimes.toLocaleString()} />
      <StatCard label="Total Payout" value={`$${(totalPayout / 1e6).toFixed(1)}M`} />
      <StatCard label="Average CPR" value={avgCpr} />
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="card hover:shadow-md transition-shadow">
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
        {label}
      </div>
    </div>
  )
}