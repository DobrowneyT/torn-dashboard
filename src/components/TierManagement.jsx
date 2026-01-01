import { useState, useMemo, useEffect } from 'react'
import { config } from '../config'

export default function TierManagement({ cprData }) {
  const [searchTerm, setSearchTerm] = useState('')
  const [editingMember, setEditingMember] = useState(null)
  const [newTier, setNewTier] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(null)
  
  // Load tier overrides from localStorage
  const [tierOverrides, setTierOverrides] = useState(() => {
    const saved = localStorage.getItem('memberTierOverrides')
    return saved ? JSON.parse(saved) : {}
  })

  // Save tier overrides to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('memberTierOverrides', JSON.stringify(tierOverrides))
  }, [tierOverrides])

  const members = useMemo(() => {
    if (!cprData?.members) return []
    
    let filtered = Object.entries(cprData.members).map(([id, data]) => ({
      id,
      ...data,
      // Use override tier if exists, otherwise use data tier
      tier: tierOverrides[id] !== undefined ? tierOverrides[id] : data.tier,
      avgCpr: calculateAvgCpr(data)
    }))

    if (searchTerm) {
      filtered = filtered.filter(m => 
        m.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        m.id.toString().includes(searchTerm)
      )
    }
    
    return filtered.sort((a, b) => (a.tier || 6) - (b.tier || 6))
  }, [cprData, searchTerm, tierOverrides])

  function handleEditTier(member) {
    setEditingMember(member)
    setNewTier(member.tier || 6)
    setSaveSuccess(null)
  }

  function handleCancelEdit() {
    setEditingMember(null)
    setNewTier(null)
  }

  function handleSaveTier() {
    // Save tier override to localStorage
    const updatedOverrides = {
      ...tierOverrides,
      [editingMember.id]: newTier
    }
    
    setTierOverrides(updatedOverrides)
    
    setSaveSuccess(`${editingMember.name} tier updated to ${newTier}`)
    setEditingMember(null)
    setNewTier(null)

    // Auto-dismiss success message
    setTimeout(() => setSaveSuccess(null), 5000)
  }

  function getMeetsRequirements(member, tier) {
    const requirements = config.tierRequirements[tier] || []
    const cprByRole = member.cpr_by_role || {}
    
    let metCount = 0
    requirements.forEach(req => {
      const levelData = cprByRole[req.level] || {}
      
      if (req.isAverage) {
        // Check average CPR for this level
        const cprValues = Object.values(levelData).filter(v => typeof v === 'number')
        const avg = cprValues.length > 0 
          ? cprValues.reduce((sum, v) => sum + v, 0) / cprValues.length 
          : 0
        if (avg >= req.minCpr) metCount++
      } else {
        // Check specific role
        const cpr = levelData[req.role]
        if (cpr && cpr >= req.minCpr) metCount++
      }
    })

    const requiredCount = Math.ceil(requirements.length * (2/3))
    return { metCount, requiredCount, meetsRequirement: metCount >= requiredCount }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Tier Management</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Manage member tier assignments
            </p>
          </div>
          <div>
            <input
              type="text"
              placeholder="Search members..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input w-64"
            />
          </div>
        </div>

        {saveSuccess && (
          <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-600 dark:text-green-400 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-green-600 dark:text-green-400">{saveSuccess}</p>
            </div>
          </div>
        )}
      </div>

      {/* Members Table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-3 px-4 font-semibold text-sm">Member</th>
                <th className="py-3 px-4 font-semibold text-sm">Current Tier</th>
                <th className="py-3 px-4 font-semibold text-sm">Avg CPR</th>
                <th className="py-3 px-4 font-semibold text-sm">Qualification</th>
                <th className="py-3 px-4 font-semibold text-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan="5" className="py-8 text-center text-gray-500">
                    No members found
                  </td>
                </tr>
              ) : (
                members.map(member => {
                  const currentTier = member.tier || 6
                  const qualification = getMeetsRequirements(member, currentTier)
                  const isEditing = editingMember?.id === member.id

                  return (
                    <tr key={member.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                      <td className="py-3 px-4">
                        <div>
                          <div className="font-medium">{member.name || `Member ${member.id}`}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">ID: {member.id}</div>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {isEditing ? (
                          <select
                            value={newTier}
                            onChange={(e) => setNewTier(parseInt(e.target.value))}
                            className="input py-1 px-2"
                          >
                            {[1, 2, 3, 4, 5, 6].map(t => (
                              <option key={t} value={t}>Tier {t}</option>
                            ))}
                          </select>
                        ) : (
                          <TierBadge tier={currentTier} />
                        )}
                      </td>
                      <td className="py-3 px-4">{member.avgCpr}</td>
                      <td className="py-3 px-4">
                        <QualificationBadge 
                          metCount={qualification.metCount}
                          requiredCount={qualification.requiredCount}
                          meetsRequirement={qualification.meetsRequirement}
                        />
                      </td>
                      <td className="py-3 px-4">
                        {isEditing ? (
                          <div className="flex gap-2">
                            <button
                              onClick={handleSaveTier}
                              className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700"
                            >
                              Save
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="px-3 py-1 bg-gray-600 text-white text-sm rounded hover:bg-gray-700"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleEditTier(member)}
                            className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
                          >
                            Edit Tier
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tier Requirements Reference */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Tier Requirements Reference</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(config.tierRequirements).map(([tier, requirements]) => (
            <div key={tier} className="border border-gray-200 dark:border-slate-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <TierBadge tier={parseInt(tier)} />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {config.payoutTickets[tier]} tickets
                </span>
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400">
                Must meet {Math.ceil(requirements.length * (2/3))} of {requirements.length} requirements
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = {1:'bg-tier-1',2:'bg-tier-2',3:'bg-tier-3',4:'bg-tier-4',5:'bg-tier-5',6:'bg-tier-6'}
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold text-sm ${colors[tier]}`}>Tier {tier}</span>
}

function QualificationBadge({ metCount, requiredCount, meetsRequirement }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-sm ${meetsRequirement ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
        {metCount}/{requiredCount}
      </span>
      {meetsRequirement ? (
        <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ) : (
        <svg className="w-4 h-4 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      )}
    </div>
  )
}

function calculateAvgCpr(memberData) {
  const cprByRole = memberData.cpr_by_role || {}
  let total = 0, count = 0
  Object.values(cprByRole).forEach(level => {
    Object.values(level).forEach(cpr => {
      if (typeof cpr === 'number') { total += cpr; count++ }
    })
  })
  return count > 0 ? (total / count).toFixed(1) : 'N/A'
}