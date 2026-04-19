import { useState, useMemo, useEffect } from 'react'
import { supabase } from '../utils/supabase'
import { useAuth } from '../contexts/AuthContext'
import * as adminApi from '../utils/adminApi'
import { config } from '../config'

export default function TierManagement() {
  const { user } = useAuth()
  const [searchTerm, setSearchTerm] = useState('')
  const [editingMember, setEditingMember] = useState(null)
  const [newTier, setNewTier] = useState(null)
  const [saveSuccess, setSaveSuccess] = useState(null)
  
  const [members, setMembers] = useState([])
  const [tierRequirements, setTierRequirements] = useState({})
  const [payoutTickets, setPayoutTickets] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      setLoading(true)
      setError(null)

      const { data: membersData, error: membersError } = await supabase
        .from('members')
        .select('*')
        .eq('is_current', true)
        .order('member_name')

      if (membersError) throw membersError

      const { data: cprData, error: cprError } = await supabase
        .from('member_cpr_v2')
        .select('member_id, crime_name, difficulty, position_label, cpr_value')

      if (cprError) throw cprError

      const membersWithCpr = membersData.map(member => {
        const memberCprRecords = cprData.filter(c => c.member_id === member.member_id)

        // Build { crime_name: { position_label: cpr_value } } for tier matching
        const cprByCrime = {}
        // Build { difficulty: [cpr_values] } for average calculations
        const cprByLevel = {}
        memberCprRecords.forEach(record => {
          const val = parseFloat(record.cpr_value)
          if (!cprByCrime[record.crime_name]) cprByCrime[record.crime_name] = {}
          cprByCrime[record.crime_name][record.position_label] = val
          if (!cprByLevel[record.difficulty]) cprByLevel[record.difficulty] = []
          cprByLevel[record.difficulty].push(val)
        })

        return {
          id: member.member_id,
          name: member.member_name,
          tier: member.tier_override || member.tier,
          hasOverride: member.tier_override !== null,
          cprByCrime,
          cprByLevel,
          avgCpr: calculateAvgCpr(memberCprRecords),
          last_scraped: member.last_scraped
        }
      })

      setMembers(membersWithCpr)

      const { data: requirementsData, error: reqError } = await supabase
        .from('tier_requirements')
        .select('*')
        .order('tier, requirement_index')

      if (reqError) throw reqError

      const requirementsByTier = {}
      const ticketsByTier = {}
      
      requirementsData.forEach(req => {
        if (!requirementsByTier[req.tier]) {
          requirementsByTier[req.tier] = []
          // Get tickets from first requirement of each tier
          ticketsByTier[req.tier] = req.payout_tickets
        }
        requirementsByTier[req.tier].push({
          level: req.difficulty_level,
          role: req.role_name,
          minCpr: req.min_cpr,
          isAverage: req.is_average
        })
      })
      
      setTierRequirements(requirementsByTier)
      setPayoutTickets(ticketsByTier)

    } catch (err) {
      console.error('Error loading data:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const filteredMembers = useMemo(() => {
    if (!searchTerm) return members

    return members.filter(m =>
      m.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.id.toString().includes(searchTerm)
    )
  }, [members, searchTerm])

  function handleEditTier(member) {
    setEditingMember(member)
    setNewTier(member.tier || 6)
    setSaveSuccess(null)
  }

  function handleCancelEdit() {
    setEditingMember(null)
    setNewTier(null)
  }

  async function handleSaveTier() {
    try {
      const response = await adminApi.adminUpdate(
        'members',
        {
          tier_override: newTier,
          updated_at: new Date().toISOString()
        },
        { member_id: editingMember.id },
        user.apiKey
      )

      if (!response.success) {
        throw new Error(response.error || 'Failed to update tier')
      }

      setMembers(prev => prev.map(m =>
        m.id === editingMember.id
          ? { ...m, tier: newTier, hasOverride: true }
          : m
      ))

      setSaveSuccess(`${editingMember.name} tier updated to ${newTier}`)
      setEditingMember(null)
      setNewTier(null)

      setTimeout(() => setSaveSuccess(null), 5000)

    } catch (err) {
      console.error('Error saving tier:', err)
      alert(`Failed to save tier: ${err.message}`)
    }
  }

  function getMeetsRequirements(member, tier) {
    // Use config.tierRequirements (has crime field) for matching
    const requirements = config.tierRequirements[tier] || []
    const cprByCrime = member.cprByCrime || {}
    const cprByLevel = member.cprByLevel || {}

    let metCount = 0
    requirements.forEach(req => {
      if (req.isAverage) {
        const values = cprByLevel[req.level] || []
        const avg = values.length > 0
          ? values.reduce((sum, v) => sum + v, 0) / values.length
          : 0
        if (avg >= req.minCpr) metCount++
      } else {
        const cpr = cprByCrime[req.crime]?.[req.role]
        if (cpr != null && cpr >= req.minCpr) metCount++
      }
    })

    const requiredCount = Math.ceil(requirements.length * (2 / 3))
    return { metCount, requiredCount, totalCount: requirements.length, meetsRequirement: metCount >= requiredCount }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading members...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card">
        <div className="text-center py-8">
          <h3 className="text-lg font-semibold text-red-600 mb-2">Error Loading Data</h3>
          <p className="text-gray-600 dark:text-gray-400 mb-4">{error}</p>
          <button onClick={loadData} className="btn-primary">
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Tier Management</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Manage member tier assignments
            </p>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Search members..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input w-64"
            />
            <button
              onClick={loadData}
              className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              title="Refresh data"
            >
              Refresh
            </button>
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
              {filteredMembers.length === 0 ? (
                <tr>
                  <td colSpan="5" className="py-8 text-center text-gray-500">
                    No members found
                  </td>
                </tr>
              ) : (
                filteredMembers.map(member => {
                  const currentTier = member.tier || 6
                  const qualification = getMeetsRequirements(member, currentTier)
                  const isEditing = editingMember?.id === member.id

                  return (
                    <tr key={member.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                      <td className="py-3 px-4">
                        <div>
                          <div className="font-medium">{member.name || `Member ${member.id}`}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            ID: {member.id}
                            {member.hasOverride && (
                              <span className="ml-2 px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 rounded text-xs">
                                Override
                              </span>
                            )}
                          </div>
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
                          totalCount={qualification.totalCount}
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

      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Tier Requirements Reference</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(tierRequirements).map(([tier, requirements]) => (
            <div key={tier} className="border border-gray-200 dark:border-slate-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <TierBadge tier={parseInt(tier)} />
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {payoutTickets[tier]} tickets
                </span>
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                Must meet {Math.ceil(requirements.length * (2 / 3))} of {requirements.length} requirements
              </div>
              <div className="space-y-1">
                {requirements.map((req, idx) => (
                  <div key={idx} className="text-xs text-gray-500 dark:text-gray-500">
                    L{req.level} {req.role}: {req.minCpr}+ CPR
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = { 1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3', 4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6' }
  return <span className={`inline-block px-3 py-1 rounded-lg text-white font-semibold text-sm ${colors[tier]}`}>Tier {tier}</span>
}

function QualificationBadge({ metCount, requiredCount, totalCount, meetsRequirement }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-sm ${meetsRequirement ? 'text-green-600 dark:text-green-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
        {metCount}/{totalCount}
      </span>
      <span className="text-xs text-gray-400">(need {requiredCount})</span>
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

function calculateAvgCpr(cprRecords) {
  if (!cprRecords || cprRecords.length === 0) return 'N/A'
  const total = cprRecords.reduce((sum, r) => sum + parseFloat(r.cpr_value), 0)
  return Math.round(total / cprRecords.length)
}