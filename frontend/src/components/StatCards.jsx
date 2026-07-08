/**
 * Reusable stat cards displayed as a responsive grid.
 *
 * Usage:
 *   <StatCards stats={[
 *     { label: 'Total Earned', value: '$1.2M', color: 'text-blue-600' },
 *     { label: 'Weeks Active', value: 12 },
 *   ]} />
 */
export default function StatCards({ stats }) {
  if (!stats || stats.length === 0) return null

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((stat, i) => (
        <div key={i} className="card">
          <div className={`text-2xl font-bold ${stat.color || 'text-gray-900 dark:text-gray-100'}`}>
            {stat.value}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400 uppercase tracking-wide mt-1">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  )
}
