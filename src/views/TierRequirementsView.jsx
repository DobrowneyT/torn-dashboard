import { config } from '../config'

export default function TierRequirementsView() {
  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Tier Requirements & Progression</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          Members must meet at least 2/3 of requirements for each tier to qualify.
        </p>
      </div>
      {Object.entries(config.tierRequirements).sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([tier, requirements]) => (
        <TierCard key={tier} tier={parseInt(tier)} requirements={requirements} />
      ))}
    </div>
  )
}

function TierCard({ tier, requirements }) {
  const tickets = config.payoutTickets[tier]
  const requiredCount = Math.ceil(requirements.length * (2/3))
  const borderColors = {1:'border-tier-1',2:'border-tier-2',3:'border-tier-3',4:'border-tier-4',5:'border-tier-5',6:'border-tier-6'}

  return (
    <div className={`card border-l-4 ${borderColors[tier]}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <TierBadge tier={tier} />
          <h3 className="text-lg font-semibold">Requirements</h3>
        </div>
        <div className="text-sm text-gray-600 dark:text-gray-400">{tickets} payout tickets</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {requirements.map((req, idx) => (
          <div key={idx} className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-slate-700/50 rounded-lg">
            <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm">
              {req.isAverage ? `Level ${req.level} Average ≥ ${req.minCpr} CPR` : `Level ${req.level} ${req.role} ≥ ${req.minCpr} CPR`}
            </span>
          </div>
        ))}
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Must meet {requiredCount} out of {requirements.length} requirements
      </p>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold ${colors[tier]}`}>Tier {tier}</span>
}