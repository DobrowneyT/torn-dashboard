import { useState, useMemo, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useFactionConfig } from '../contexts/FactionConfigContext'
import { apiGet, apiDelete } from '../utils/apiClient'
import {
  loadCrimesForPayout,
  loadMembers,
  loadPayoutWeeks,
  savePayoutWeek,
  checkExistingWeek
} from '../utils/payoutDataLoader'
import {
  getCurrentWeekRange,
  getPreviousWeekRange,
  getWeekRangeFromDate,
  calculatePayouts,
  calculateTheoreticalPayouts,
  formatCurrency,
  formatCurrencyShort,
  formatPercent,
  formatTimeHours,
  exportPayoutsToCSV,
  exportPayoutFilename,
  generateBatchPayoutURL,
  getCrimeStats,
  buildHistoricalWeekCrimesData,
  PAYOUT_MODES,
  DEFAULT_PAYOUT_MODE,
  payoutShare,
  countEqualParticipants
} from '../utils/payoutCalculations'
import { useFactionIdentity } from '../utils/factionIdentity'
import { enrichItemBreakdown } from '../utils/lookupHelpers'
import CrimeStatsView from './CrimeStatsView'
import OccupancyPanel from './OccupancyPanel'
import { coverageVerdict, formatDelta } from '../utils/occupancyReport'
import { fmtDbTime } from '../utils/time'
import { X } from 'lucide-react'
import InfoTooltip, { InfoDot } from './InfoTooltip'
import { sortRows, nextDirection } from '../utils/tableSort.js'

/**
 * The OC weekly payout sheet's sortable columns.
 *
 * ⚠️ Replaces a comparator that coerced ONLY `name` and let every other column
 * fall through to a raw `<` / `>` on whatever the API returned — the exact
 * defect epic #803 was filed about. `userId` is the clearest casualty: it
 * arrives as a string, so it was compared lexically and "1712182" sorted before
 * "873341".
 *
 * ⚠️ `timePercent` and `sharePercent` are fractions, `timeSpent` and
 * `observedSeconds` are seconds, and the money columns are whole numbers — all
 * numeric, none of them safe to compare as text.
 */
export const OC_PAYOUT_COLUMNS = [
  { key: 'name',              kind: 'text',   accessor: (m) => m.name },
  { key: 'userId',            kind: 'number', accessor: (m) => m.userId },
  { key: 'tier',              kind: 'number', accessor: (m) => m.tier },
  { key: 'timeSpent',         kind: 'number', accessor: (m) => m.timeSpent },
  { key: 'observedSeconds',   kind: 'number', accessor: (m) => m.observedSeconds },
  { key: 'timePercent',       kind: 'number', accessor: (m) => m.timePercent },
  { key: 'baseTickets',       kind: 'number', accessor: (m) => m.baseTickets },
  { key: 'sitOutPenalty',     kind: 'number', accessor: (m) => m.sitOutPenalty },
  { key: 'sharePercent',      kind: 'number', accessor: (m) => m.sharePercent },
  { key: 'payout',            kind: 'number', accessor: (m) => m.payout },
  { key: 'theoreticalPayout', kind: 'number', accessor: (m) => m.theoreticalPayout },
]

/**
 * Recompute payout totals + per-member payouts from the current unit values
 * in `results.itemBreakdown`.  Used when the user manually edits a reward
 * unit price so the totals, faction cut, member pool, and payouts all stay
 * in sync.
 */
function recalculateWithItemPrices(results, factionCutPercent, mode) {
  if (!results || !results.itemBreakdown) return results

  // Refresh totalValue for every item from its current unitValue.
  const updatedRewards = {}
  Object.entries(results.itemBreakdown.rewards || {}).forEach(([id, d]) => {
    updatedRewards[id] = { ...d, totalValue: (d.unitValue || 0) * (d.quantity || 0) }
  })
  const updatedCosts = {}
  Object.entries(results.itemBreakdown.costs || {}).forEach(([id, d]) => {
    updatedCosts[id] = { ...d, totalValue: (d.unitValue || 0) * (d.quantity || 0) }
  })

  const newTotalItemReward = Object.values(updatedRewards).reduce((s, i) => s + (i.totalValue || 0), 0)
  const newTotalItemCost   = Object.values(updatedCosts).reduce((s, i) => s + (i.totalValue || 0), 0)
  const newNetItemValue    = newTotalItemReward - newTotalItemCost
  const newGrossTotal      = (results.totalMoneyReward || 0) + newNetItemValue
  const newFactionCut      = Math.floor(newGrossTotal * (factionCutPercent / 100))
  const newMemberPayoutTotal = newGrossTotal - newFactionCut

  // Rebuild per-crime net values with current prices.
  const crimeValues = {}
  for (const [crimeId, crime] of Object.entries(results.crimeValues || {})) {
    crimeValues[crimeId] = {
      ...crime,
      netValue: crime.successful ? (crime.moneyReward || 0) : 0,
    }
  }
  for (const item of results.rewardItemDetails || []) {
    const c = crimeValues[item.crimeId]
    if (!c) continue
    const price = updatedRewards[item.itemId]?.unitValue || 0
    c.netValue += price * (item.quantity || 1)
  }
  for (const item of results.consumedItemDetails || []) {
    const c = crimeValues[item.crimeId]
    if (!c) continue
    const price = updatedCosts[item.itemId]?.unitValue || 0
    c.netValue -= price
  }

  const theoreticalByMember = calculateTheoreticalPayouts(crimeValues, factionCutPercent / 100)
  const totalAdjustedTickets = results.totalAdjustedTickets
    ?? (results.members || []).reduce((s, m) => s + (m.adjustedTickets || 0), 0)

  // ⚠️ `mode` reaches here now. This path had NO equal branch: because
  // `totalAdjustedTickets` is non-zero on an equal week too, editing a single
  // item price re-split that week by tickets and quietly abandoned the even
  // split the faction had chosen.
  const equalParticipants = countEqualParticipants(results.members)
  const recalculatedMembers = (results.members || []).map(m => ({
    ...m,
    ...payoutShare(m, {
      mode, pot: newMemberPayoutTotal, totalAdjustedTickets, equalParticipants,
    }),
    theoreticalPayout: theoreticalByMember[m.userId.toString()] || 0,
  }))

  return {
    ...results,
    itemBreakdown: { rewards: updatedRewards, costs: updatedCosts },
    totalItemReward: newTotalItemReward,
    totalItemCost: newTotalItemCost,
    netItemValue: newNetItemValue,
    grossTotal: newGrossTotal,
    factionCut: newFactionCut,
    memberPayoutTotal: newMemberPayoutTotal,
    members: recalculatedMembers,
    crimeValues,
    totalAdjustedTickets,
  }
}

export default function PayoutManagement() {
  const { user, isVisitor } = useAuth()
  // Non-tiered factions hide the Tier column in the results table (#136).
  const { usesTiers, payoutMode: factionPayoutMode } = useFactionConfig()
  const faction = useFactionIdentity()

  // Date range state
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [fromTimestamp, setFromTimestamp] = useState(null)
  const [toTimestamp, setToTimestamp] = useState(null)
  const [factionCutPercent, setFactionCutPercent] = useState(20)
  // Payout mode (#134). Pre-filled from the faction default; a leader can pick
  // a different mode for any individual week, and that choice wins from the
  // moment they make it (#587). Absent faction setting → the multi-faction
  // default (equal), resolved server-side so every consumer agrees.
  const [payoutMode, setPayoutMode] = useState(DEFAULT_PAYOUT_MODE)
  // Set once the user picks a mode by hand. The faction default arrives
  // asynchronously and a saved week carries its own mode; neither may
  // overwrite a deliberate choice that is already on screen.
  const modeChosenByUser = useRef(false)

  // Data loading state
  const [crimesData, setCrimesData] = useState(null)
  const [membersData, setMembersData] = useState(null)
  const [loadingData, setLoadingData] = useState(false)
  const [dataError, setDataError] = useState(null)

  // Calculation state
  const [hasCalculated, setHasCalculated] = useState(false)
  const [payoutResults, setPayoutResults] = useState(null)

  // Add to state declarations (around line 38)
  const [penaltyOverrides, setPenaltyOverrides] = useState({})
  const [editingPenalty, setEditingPenalty] = useState(null)
  const [editingRewardPrice, setEditingRewardPrice] = useState(null)

  // Save state
  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState(null)

  // UI state
  const [showBatchURL, setShowBatchURL] = useState(false)
  const [showCrimeStats, setShowCrimeStats] = useState(false)
  const [sortConfig, setSortConfig] = useState({ key: 'payout', direction: 'desc' })
  // ⚠️ Manual pay eligibility (MonChoon, 2026-10-01). The ticket penalty does
  // not reach the EQUAL and FLAT models, so without this there is no way to
  // withhold somebody's pay short of deleting their row — which also deletes
  // the record that they were there.
  const [ineligibleMembers, setIneligibleMembers] = useState(() => new Set())
  const toggleEligible = (userId) => setIneligibleMembers((prev) => {
    const next = new Set(prev)
    const key = String(userId)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  // Historical payouts
  const [historicalPayouts, setHistoricalPayouts] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [showHistory, setShowHistory] = useState(false)


  // Item breakdown state
  const [showItemRewards, setShowItemRewards] = useState(false)
  const [showItemCosts, setShowItemCosts] = useState(false)

  // Initialize with current week
  useEffect(() => {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
  }, [])

  // Pre-fill the mode from the faction default (absent → equal, decided by the
  // server). This resolves after first paint, so it must not land on top of a
  // mode the user has already clicked in the meantime (#587).
  useEffect(() => {
    let on = true
    apiGet('/api/oc-config')
      .then(cfg => {
        const m = cfg?.payout_mode
        if (on && !modeChosenByUser.current && PAYOUT_MODES.includes(m)) setPayoutMode(m)
      })
      .catch(() => { /* keep the default */ })
    return () => { on = false }
  }, [])

  /** A deliberate pick: it holds against the faction default and week history. */
  function choosePayoutMode(mode) {
    modeChosenByUser.current = true
    setPayoutMode(mode)
  }

  // Load historical payouts when tab is shown
  useEffect(() => {
    if (showHistory) {
      loadHistoricalPayouts()
    }
  }, [showHistory])

  async function loadHistoricalPayouts() {
    try {
      setLoadingHistory(true)
      const data = await loadPayoutWeeks(20)
      setHistoricalPayouts(data)
    } catch (err) {
      console.error('Error loading historical payouts:', err)
    } finally {
      setLoadingHistory(false)
    }
  }

  async function handleDeleteHistoricalWeek(payout) {
    if (!confirm(`Delete the payout for ${payout.week_start} to ${payout.week_end}? This removes its member records and unlinks its crimes. This cannot be undone.`)) return
    try {
      await apiDelete(`/api/payouts/weeks/${payout.id}`)
      await loadHistoricalPayouts()
    } catch (err) {
      console.error('Error deleting payout week:', err)
      alert(err.message || 'Failed to delete payout')
    }
  }

  async function loadPayoutData() {
    if (!fromTimestamp || !toTimestamp) return

    try {
      setLoadingData(true)
      setDataError(null)

      // Load crimes and members from the faction API
      const [crimes, members] = await Promise.all([
        loadCrimesForPayout(fromTimestamp, toTimestamp),
        loadMembers()
      ])

      setCrimesData(crimes)
      setMembersData(members)

      console.log('Loaded crimes:', Object.keys(crimes.crimes || {}).length)
      console.log('Loaded members:', Object.keys(members.members || {}).length)

    } catch (err) {
      console.error('Error loading payout data:', err)
      setDataError(err.message)
    } finally {
      setLoadingData(false)
    }
  }

  function handleSetCurrentWeek() {
    const currentWeek = getCurrentWeekRange()
    setFromDate(currentWeek.monday.toISOString().split('T')[0])
    setToDate(currentWeek.sunday.toISOString().split('T')[0])
    setFromTimestamp(currentWeek.mondayTimestamp)
    setToTimestamp(currentWeek.sundayTimestamp)
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleSetPreviousWeek() {
    // Navigate one week back from the currently displayed week
    if (fromTimestamp) {
      const currentFrom = new Date(fromTimestamp * 1000)
      currentFrom.setUTCDate(currentFrom.getUTCDate() - 7)
      const prevWeek = getWeekRangeFromDate(currentFrom)
      setFromDate(prevWeek.monday.toISOString().split('T')[0])
      setToDate(prevWeek.sunday.toISOString().split('T')[0])
      setFromTimestamp(prevWeek.mondayTimestamp)
      setToTimestamp(prevWeek.sundayTimestamp)
    } else {
      const previousWeek = getPreviousWeekRange()
      setFromDate(previousWeek.monday.toISOString().split('T')[0])
      setToDate(previousWeek.sunday.toISOString().split('T')[0])
      setFromTimestamp(previousWeek.mondayTimestamp)
      setToTimestamp(previousWeek.sundayTimestamp)
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleSetNextWeek() {
    // Navigate one week forward from the currently displayed week
    if (fromTimestamp) {
      const currentFrom = new Date(fromTimestamp * 1000)
      currentFrom.setUTCDate(currentFrom.getUTCDate() + 7)
      const nextWeek = getWeekRangeFromDate(currentFrom)
      setFromDate(nextWeek.monday.toISOString().split('T')[0])
      setToDate(nextWeek.sunday.toISOString().split('T')[0])
      setFromTimestamp(nextWeek.mondayTimestamp)
      setToTimestamp(nextWeek.sundayTimestamp)
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleEditPenalty(userId, currentPenalty) {
    setEditingPenalty({ userId, value: currentPenalty.toString() })
  }

  function handleSavePenalty(userId) {
    const newPenalty = parseInt(editingPenalty.value, 10) || 0
    setPenaltyOverrides(prev => ({ ...prev, [userId]: newPenalty }))
    setEditingPenalty(null)
  }

  function handleCancelPenalty() {
    setEditingPenalty(null)
  }

  function handleResetPenalty(userId) {
    setPenaltyOverrides(prev => {
      const updated = { ...prev }
      delete updated[userId]
      return updated
    })
  }

  // Manual override of a reward item's unit price.  Mirrors the penalty
  // edit pattern: edit button opens a tiny inline input with confirm/cancel
  // buttons.  Cost prices are NOT editable — they come from inventory
  // weighted-average.  Saving recalculates the entire payout downstream.
  function handleEditRewardPrice(itemId, currentValue) {
    setEditingRewardPrice({ itemId, value: String(currentValue ?? 0) })
  }

  function handleSaveRewardPrice() {
    if (!editingRewardPrice) return
    const { itemId, value } = editingRewardPrice
    const sanitized = Math.max(0, parseInt(value, 10) || 0)
    setPayoutResults(prev => {
      if (!prev?.itemBreakdown?.rewards?.[itemId]) return prev
      const next = {
        ...prev,
        itemBreakdown: {
          ...prev.itemBreakdown,
          rewards: {
            ...prev.itemBreakdown.rewards,
            [itemId]: {
              ...prev.itemBreakdown.rewards[itemId],
              unitValue: sanitized,
              priceSource: 'manual',
            },
          },
        },
      }
      return recalculateWithItemPrices(next, factionCutPercent, payoutMode)
    })
    setEditingRewardPrice(null)
  }

  function handleCancelRewardPrice() {
    setEditingRewardPrice(null)
  }

  function handleResetRewardPrice(itemId) {
    setPayoutResults(prev => {
      const item = prev?.itemBreakdown?.rewards?.[itemId]
      if (!item) return prev
      const original = item.originalUnitValue ?? item.unitValue ?? 0
      const next = {
        ...prev,
        itemBreakdown: {
          ...prev.itemBreakdown,
          rewards: {
            ...prev.itemBreakdown.rewards,
            [itemId]: {
              ...item,
              unitValue: original,
              // Drop the manual marker — go back to whatever source the original came from.
              priceSource: item.priceSource === 'manual' ? 'auto' : item.priceSource,
            },
          },
        },
      }
      return recalculateWithItemPrices(next, factionCutPercent, payoutMode)
    })
  }

  function handleFromDateChange(e) {
    const newDate = e.target.value
    setFromDate(newDate)
    if (newDate) {
      const [y, m, d] = newDate.split('-').map(Number)
      const date = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
      setFromTimestamp(Math.floor(date.getTime() / 1000))
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  function handleToDateChange(e) {
    const newDate = e.target.value
    setToDate(newDate)
    if (newDate) {
      const [y, m, d] = newDate.split('-').map(Number)
      const date = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
      setToTimestamp(Math.floor(date.getTime() / 1000))
    }
    setHasCalculated(false)
    setPayoutResults(null)
  }

  async function handleRunPayout() {
    if (!fromTimestamp || !toTimestamp) {
      alert('Please select both FROM and TO dates')
      return
    }

    if (fromTimestamp >= toTimestamp) {
      alert('FROM date must be before TO date')
      return
    }

    // Load fresh data
    await loadPayoutData()

    if (!crimesData && !membersData) {
      // Data loading failed, error already shown
      return
    }
  }

  // Calculate payouts when data is loaded
  useEffect(() => {
    if (crimesData && membersData && fromTimestamp && toTimestamp) {
      const results = calculatePayouts(
        crimesData,
        membersData,
        fromTimestamp,
        toTimestamp,
        factionCutPercent / 100,
        payoutMode,
        ineligibleMembers
      )

      // Penalty overrides adjust ticket-weighted shares, so they apply only to
      // the ticket modes (tiered / flat-weighted). In equal mode there's no
      // ticket weighting — calculatePayouts' even split stands untouched.
      let totalAdjustedTickets = 0
      if (payoutMode !== 'equal') {
        // Apply penalty overrides
        results.members = results.members.map(member => {
          const override = penaltyOverrides[member.userId]
          if (override === undefined) return member
          // ⚠️ `member.isEligible === false` wins over the override. This
          // recomputes `adjustedTickets` from `baseTickets`, which would
          // RESURRECT the tickets calculatePayouts zeroed — a member who is
          // both excluded from pay and carrying a sit-out penalty would get
          // paid, because the penalty pass overwrote the exclusion.
          const newAdjustedTickets = member.isEligible === false
            ? 0
            : Math.max(0, member.baseTickets + override)
          return {
            ...member,
            sitOutPenalty: override,
            adjustedTickets: newAdjustedTickets,
            penaltyOverridden: true
          }
        })

        // Recalculate shares after penalty overrides
        totalAdjustedTickets = results.members.reduce((sum, m) => sum + m.adjustedTickets, 0)
        const memberPayoutTotal = results.memberPayoutTotal
        const overrideParticipants = countEqualParticipants(results.members)

        results.members = results.members.map(member => ({
          ...member,
          ...payoutShare(member, {
            mode: payoutMode,
            pot: memberPayoutTotal,
            totalAdjustedTickets,
            equalParticipants: overrideParticipants,
          }),
        }))
      }

      // Enrich item breakdown and recalculate totals
      enrichItemBreakdown(results.itemBreakdown).then(enriched => {
        // Build enriched price maps (itemId -> unit price)
        const rewardPrices = {}
        Object.entries(enriched.rewards || {}).forEach(([itemId, data]) => {
          rewardPrices[itemId] = data.unitValue || 0
        })
        const costPrices = {}
        Object.entries(enriched.costs || {}).forEach(([itemId, data]) => {
          costPrices[itemId] = data.unitValue || 0
        })

        // Calculate new totals from enriched item data
        const newTotalItemReward = Object.values(enriched.rewards || {}).reduce(
          (sum, item) => sum + (item.totalValue || 0),
          0
        )

        const newTotalItemCost = Object.values(enriched.costs || {}).reduce(
          (sum, item) => sum + (item.totalValue || 0),
          0
        )

        const newNetItemValue = newTotalItemReward - newTotalItemCost

        // Recalculate gross total and faction cut with new item values
        const newGrossTotal = results.totalMoneyReward + newTotalItemReward - newTotalItemCost
        const newFactionCut = Math.floor(newGrossTotal * (factionCutPercent / 100))
        const newMemberPayoutTotal = newGrossTotal - newFactionCut

        // Rebuild per-crime net values with enriched item prices
        const enrichedCrimeValues = { ...results.crimeValues }
        // Reset item-based values (keep money rewards from successful crimes, zero out item portions)
        for (const [crimeId, crime] of Object.entries(enrichedCrimeValues)) {
          if (crime.successful) {
            // Start with money reward only (strip out old zero-value items)
            enrichedCrimeValues[crimeId] = { ...crime, netValue: crime.moneyReward || 0 }
          } else {
            // Failed crime: reset to 0, will add item costs below
            enrichedCrimeValues[crimeId] = { ...crime, netValue: 0 }
          }
        }
        // Add enriched reward item values per crime
        for (const item of results.rewardItemDetails) {
          if (enrichedCrimeValues[item.crimeId]) {
            const price = rewardPrices[item.itemId] || 0
            enrichedCrimeValues[item.crimeId].netValue += price * (item.quantity || 1)
          }
        }
        // Subtract enriched cost item values per crime
        for (const item of results.consumedItemDetails) {
          if (enrichedCrimeValues[item.crimeId]) {
            const price = costPrices[item.itemId] || 0
            enrichedCrimeValues[item.crimeId].netValue -= price
          }
        }

        // Recalculate theoretical payouts with enriched per-crime values
        const theoreticalByMember = calculateTheoreticalPayouts(enrichedCrimeValues, factionCutPercent / 100)

        // Recalculate member payouts against the item-enriched pool, through
        // the same `payoutShare` the first pass used.
        // ⚠️ This is the pass that produces what the screen SHOWS — it runs
        // last and overwrites calculatePayouts' numbers. It used to read
        // `m.timeSpent > 0` with no eligibility check, so marking somebody
        // ineligible on an equal week changed nobody's figure: the excluded
        // member kept their share and the pot never redistributed, which is
        // exactly what MonChoon saw (2026-10-02). The ticket modes looked
        // right only because their branch reads `adjustedTickets`, which was
        // already zeroed upstream.
        const equalParticipants = countEqualParticipants(results.members)
        const recalculatedMembers = results.members.map(member => ({
          ...member,
          ...payoutShare(member, {
            mode: payoutMode, pot: newMemberPayoutTotal, totalAdjustedTickets, equalParticipants,
          }),
          theoreticalPayout: theoreticalByMember[member.userId.toString()] || 0,
        }))

        // Update results with enriched data and recalculated totals
        const updatedResults = {
          ...results,
          itemBreakdown: enriched,
          totalItemReward: newTotalItemReward,
          totalItemCost: newTotalItemCost,
          netItemValue: newNetItemValue,
          grossTotal: newGrossTotal,
          factionCut: newFactionCut,
          memberPayoutTotal: newMemberPayoutTotal,
          members: recalculatedMembers,
          crimeValues: enrichedCrimeValues
        }

        setPayoutResults(updatedResults)
        setHasCalculated(true)
      })
    }
  // ⚠️ `ineligibleMembers` is a dependency: excluding somebody changes the
  // DENOMINATOR, so every other member's share moves. Leaving it out would show
  // a sheet where one row reads zero and nobody else's number has changed —
  // which does not add up to the pot.
  }, [crimesData, membersData, fromTimestamp, toTimestamp, factionCutPercent, penaltyOverrides, payoutMode, ineligibleMembers, user.apiKey])

  async function handleSaveWeek() {
    if (!payoutResults || payoutResults.members.length === 0) {
      alert('No payout data to save')
      return
    }

    // Check for existing week before saving
    try {
      const existing = await checkExistingWeek(fromDate, toDate)
      if (existing) {
        const confirmOverwrite = window.confirm(
          `A payout for this week (${fromDate} to ${toDate}) already exists.\n\n` +
          `Saved on: ${fmtDbTime(existing.saved_at)}\n` +
          `Members: ${existing.member_count || 'N/A'}\n` +
          `Total payout: $${(existing.member_payout_total || 0).toLocaleString()}\n\n` +
          `Do you want to overwrite it?`
        )
        if (!confirmOverwrite) return
      }
    } catch (err) {
      console.warn('Could not check for existing week, proceeding with save:', err)
    }

    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(false)

    try {
      const weekData = {
        week_start: fromDate,
        week_end: toDate,
        week_start_timestamp: fromTimestamp,
        week_end_timestamp: toTimestamp,
        total_money_reward: payoutResults.totalMoneyReward,
        total_item_reward: payoutResults.totalItemReward,
        total_item_cost: payoutResults.totalItemCost,
        net_item_value: payoutResults.netItemValue,
        faction_cut_percent: factionCutPercent,
        faction_cut_amount: payoutResults.factionCut,
        member_payout_total: payoutResults.memberPayoutTotal,
        crimes_processed: payoutResults.crimesProcessed,
        total_time_spent: payoutResults.totalTimeSpent,
        average_time_spent: payoutResults.averageTime,
        total_adjusted_tickets: payoutResults.totalAdjustedTickets,
        payout_mode: payoutMode
      }

      const memberData = payoutResults.members.map(m => ({
        member_id: m.userId.toString(),
        member_name: m.name,
        tier: m.tier,
        base_tickets: m.baseTickets,
        sit_out_penalty: m.sitOutPenalty,
        adjusted_tickets: m.adjustedTickets,
        time_spent: m.timeSpent,
        ticket_time_spent: m.ticketTimeSpent ?? null,
        time_spent_percent: m.timePercent,
        share_percent: m.sharePercent * 100,
        payout: m.payout,
        theoretical_payout: m.theoreticalPayout,
        crimes_count: m.crimesCount,
        crimes_participated: m.crimeIds,
        // ⚠️ Saved with the week. Without it, a leader who withheld somebody's
        // pay, saved, and came back would find them paid again — and the
        // sheet's totals would differ from what was actually handed out.
        is_eligible: m.isEligible !== false
      }))

      await savePayoutWeek(weekData, memberData, payoutResults.crimeIds, user.name, user.apiKey)

      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 5000)

    } catch (err) {
      console.error('Error saving payout:', err)
      setSaveError(err.message)
    } finally {
      setIsSaving(false)
    }
  }

  function handleExportCSV() {
    if (!payoutResults) return

    const csvContent = exportPayoutsToCSV(sortedMembers, payoutResults)
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = exportPayoutFilename(fromDate, faction.displayName)
    a.click()
    window.URL.revokeObjectURL(url)
  }

  function handleCopyBatchURL() {
    if (!payoutResults) return

    // ⚠️ Excluded members are dropped from the batch link. `generateBatchPayoutURL`
    // already filters on payout > 0, and an ineligible member's payout IS zero —
    // but filtering explicitly means the link cannot pay somebody a leader has
    // withheld, even if the arithmetic ever changes underneath it.
    const batchURL = generateBatchPayoutURL(sortedMembers.filter((m) => m.isEligible !== false))

    if (!batchURL) {
      alert('No valid payouts to generate URL')
      return
    }

    navigator.clipboard.writeText(batchURL).then(() => {
      setShowBatchURL(true)
      setTimeout(() => setShowBatchURL(false), 3000)

      // Prompt to save the current week to the database
      if (window.confirm('Batch URL copied! Would you like to save this payout week to the database?')) {
        handleSaveWeek()
      }
    }).catch(err => {
      console.error('Failed to copy:', err)
      alert('Failed to copy URL to clipboard')
    })
  }

  async function handleLoadHistoricalWeek(weekId) {
    try {
      // Load the week directly by id (not limited to the newest page)
      const { week: weekData } = await apiGet(`/api/payouts/weeks/${weekId}`)

      // Load member payouts for this week
      const { members } = await apiGet(`/api/payouts/weeks/${weekId}/members`)

      // Build item breakdown from linked crimes
      let itemBreakdown = { rewards: {}, costs: {} }
      const crimeIds = weekData.crime_ids || []
      // #389: occupancy + occupancy_polls for this week's window, carried
      // from the crime-data fetch below into the final setCrimesData call
      // further down — see the comment there for why this can't just be
      // read off windowData directly.
      let occupancyForWeek = { occupancy: [], occupancy_polls: [] }

      if (crimeIds.length > 0) {
        // The window endpoint returns item rows for a superset of the linked
        // crimes; filter down to exactly the linked ids.
        // db-time-safe: week_start/week_end are DATE columns ("2026-08-03"),
        // which parse as UTC midnight — no offset to mangle.
        const fromTs = weekData.week_start_timestamp ?? Math.floor(new Date(weekData.week_start).getTime() / 1000)
        // db-time-safe: DATE column, as above.
        const toTs = weekData.week_end_timestamp ?? (Math.floor(new Date(weekData.week_end).getTime() / 1000) + 86400)
        const windowData = await apiGet(`/api/payouts/crime-data?from=${fromTs}&to=${toTs}`)
        occupancyForWeek = {
          occupancy: windowData.occupancy || [],
          occupancy_polls: windowData.occupancy_polls || [],
        }
        const idSet = new Set(crimeIds)

        // Aggregate reward items by item_id
        const rewards = {}
        for (const r of (windowData.reward_items || []).filter(i => idSet.has(i.crime_id))) {
          const id = r.item_id.toString()
          if (!rewards[id]) rewards[id] = { quantity: 0 }
          rewards[id].quantity += (r.quantity || 1)
        }

        // Aggregate cost items by item_id
        const costs = {}
        for (const c of (windowData.required_items || []).filter(i => idSet.has(i.crime_id) && i.was_consumed)) {
          const id = c.item_id.toString()
          if (!costs[id]) costs[id] = { quantity: 0 }
          costs[id].quantity += 1
        }

        itemBreakdown = { rewards, costs }
      }

      // Set the date range
      setFromDate(weekData.week_start)
      setToDate(weekData.week_end)
      setFromTimestamp(weekData.week_start_timestamp)
      setToTimestamp(weekData.week_end_timestamp)
      setFactionCutPercent(weekData.faction_cut_percent || 20)
      // Show the mode this week was computed with. Weeks saved before #587 have
      // no stored mode (savePayoutWeek dropped the field), so fall back to what
      // the faction is set to rather than assuming tiered — that assumption
      // silently retagged every equal/flat-weighted faction's history.
      if (PAYOUT_MODES.includes(weekData.payout_mode)) {
        setPayoutMode(weekData.payout_mode)
      } else if (!modeChosenByUser.current) {
        setPayoutMode(factionPayoutMode ?? DEFAULT_PAYOUT_MODE)
      }

      // Transform member data to match expected format
      const transformedMembers = members.map(m => ({
        userId: m.member_id,
        name: m.member_name,
        tier: m.tier,
        baseTickets: m.base_tickets || 0,
        sitOutPenalty: m.sit_out_penalty || 0,
        adjustedTickets: m.adjusted_tickets || 0,
        timeSpent: m.time_spent || 0,
        // ⚠️ Falls back to time_spent for pre-0066 rows, which is what those
        // weeks were actually paid on — so reopening an old week recalculates
        // the way it originally calculated, rather than zeroing everyone.
        ticketTimeSpent: m.ticket_time_spent ?? m.time_spent ?? 0,
        timePercent: m.time_spent_percent || 0,
        sharePercent: (m.share_percent || 0) / 100,
        payout: m.payout || 0,
        theoreticalPayout: m.theoretical_payout || 0,
        crimesCount: m.crimes_count || 0,
        crimeIds: m.crimes_participated || [],
        // ⚠️ `!== false`, not `|| true`: a row saved before 0065 has no column
        // at all, and those weeks were paid on the old rules.
        isEligible: m.is_eligible !== false
      }))

      // ⚠️ Rehydrate the eligibility SET too, not just the flag on each row.
      // The flag is what the table renders; the set is what the recalculation
      // reads. Restoring one without the other means the sheet looks right
      // until anything triggers a recompute, and then quietly pays somebody a
      // leader had withheld.
      setIneligibleMembers(new Set(
        transformedMembers.filter((m) => m.isEligible === false).map((m) => String(m.userId))))

      // Set the payout results
      const results = {
        members: transformedMembers,
        totalMoneyReward: weekData.total_money_reward || 0,
        totalItemReward: weekData.total_item_reward || 0,
        totalItemCost: weekData.total_item_cost || 0,
        netItemValue: weekData.net_item_value || 0,
        grossTotal: (weekData.total_money_reward || 0) + (weekData.net_item_value || 0),
        factionCut: weekData.faction_cut_amount || 0,
        factionCutPercent: weekData.faction_cut_percent || 20,
        memberPayoutTotal: weekData.member_payout_total || weekData.total_member_payout || 0,
        participatingMembers: members.length,
        crimesProcessed: weekData.crimes_processed || 0,
        crimeIds,
        totalTimeSpent: weekData.total_time_spent || 0,
        averageTime: weekData.average_time_spent || 0,
        totalAdjustedTickets: weekData.total_adjusted_tickets || 0,
        itemBreakdown
      }

      // Enrich item breakdown with names for display only.
      // Summary totals (totalItemReward, totalItemCost, netItemValue) are kept
      // from the stored snapshot — do NOT overwrite with current market prices,
      // as item prices are volatile and the snapshot is the source of truth.
      if (Object.keys(itemBreakdown.rewards).length > 0 || Object.keys(itemBreakdown.costs).length > 0) {
        enrichItemBreakdown(itemBreakdown).then(enriched => {
          setPayoutResults(prev => ({
            ...prev,
            itemBreakdown: enriched,
          }))
        })
      }

      setPayoutResults(results)
      setHasCalculated(true)
      setShowHistory(false)

      // Fetch the linked crimes so Crime Statistics can render. Slots are part
      // of that (#391) — the participant list IS the thing people reopen a
      // saved week to look at. occupancyForWeek carries the earlier crime-data
      // fetch's occupancy into the mix — see buildHistoricalWeekCrimesData
      // for why that can't just be left off (#389).
      setMembersData(null)
      if (crimeIds.length > 0) {
        apiGet(`/api/payouts/weeks/${weekId}/crimes`)
          .then(({ crimes: crimesRows, slots: slotRows }) => {
            setCrimesData(buildHistoricalWeekCrimesData(crimesRows, slotRows, occupancyForWeek))
          })
          .catch((crimesErr) => {
            console.error('Error loading crimes for stats:', crimesErr)
            setCrimesData(null)
          })
      } else {
        setCrimesData(null)
      }

    } catch (error) {
      console.error('Error loading historical week:', error)
      alert(`Failed to load historical week: ${error.message}`)
    }
  }

  // Sort members
  const sortedMembers = useMemo(() => {
    if (!payoutResults?.members) return []

    const sorted = [...payoutResults.members]

    return sortRows(sorted, OC_PAYOUT_COLUMNS, sortConfig.key, sortConfig.direction,
                    { tieBreak: 'name' })
  }, [payoutResults, sortConfig])

  const handleSort = (key) => {
    setSortConfig(prev => ({ key, direction: nextDirection(key, prev.key, prev.direction) }))
  }

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) {
      return <span className="ml-1 text-gray-400">-</span>
    }
    return <span className="ml-1">{sortConfig.direction === 'asc' ? '^' : 'v'}</span>
  }

  // #389: the Observed column appears only when the poller actually watched
  // this window. A window it never covered would otherwise render a full column
  // of 0h, and a zero looks like an observation — the exact confusion between
  // "we didn't look" and "nothing happened" that cost a fortnight on #330.
  const showObserved = useMemo(() => {
    const state = coverageVerdict(
      payoutResults?.occupancyCoverage,
      payoutResults?.windowStart,
      payoutResults?.windowEnd
    ).state
    return state === 'watched' || state === 'degraded'
  }, [payoutResults])

  // #389 part 3: once a window is fully watched, tickets/payout come from the
  // occupancy poller instead of the legacy crime_slots calculation — see
  // payoutCalculations.js's `usingOccupancy`. `timeSource` says which happened
  // for this specific payout.
  const usingOccupancy = payoutResults?.timeSource === 'occupancy'

  // Crime statistics
  const crimeStats = useMemo(() => {
    if (!crimesData?.crimes) return null
    return getCrimeStats(crimesData.crimes)
  }, [crimesData])

  return (
    <div className="space-y-6">
      {/* Date Range Selection */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Payout Analysis Window</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-green-600">From Date:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={fromDate}
                onChange={handleFromDateChange}
                className="input bg-green-50 dark:bg-green-900/20 border-green-300"
              />
              <input
                type="text"
                value={fromTimestamp || ''}
                readOnly
                className="input bg-orange-50 dark:bg-orange-900/20 border-orange-300 text-sm"
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2 text-green-600">To Date:</label>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="date"
                value={toDate}
                onChange={handleToDateChange}
                className="input bg-green-50 dark:bg-green-900/20 border-green-300"
              />
              <input
                type="text"
                value={toTimestamp || ''}
                readOnly
                className="input bg-orange-50 dark:bg-orange-900/20 border-orange-300 text-sm"
                placeholder="Unix timestamp"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2 text-purple-600">Faction Cut (%):</label>
            <input
              type="number"
              value={factionCutPercent}
              onChange={(e) => setFactionCutPercent(parseFloat(e.target.value) || 0)}
              min="0"
              max="100"
              step="0.1"
              className="input bg-purple-50 dark:bg-purple-900/20 border-purple-300"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Payout Mode:</label>
            <div className="inline-flex rounded-lg border border-gray-300 dark:border-slate-600 overflow-hidden">
              {PAYOUT_MODES.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => choosePayoutMode(m)}
                  className={`px-3 py-2 text-sm capitalize transition-colors ${
                    payoutMode === m
                      ? 'bg-blue-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700'
                  }`}
                >
                  {m.replace('-', ' ')}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {payoutMode === 'tiered' && 'Per-tier tickets × time weighting.'}
              {payoutMode === 'flat-weighted' && 'Everyone one tier; time/sit-out weighting applies.'}
              {payoutMode === 'equal' && 'Even split among everyone who did ≥1 OC.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={handleSetPreviousWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Previous Week
          </button>
          <button
            onClick={handleSetCurrentWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Current Week
          </button>
          <button
            onClick={handleSetNextWeek}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Next Week
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
          >
            {showHistory ? 'Hide' : 'View'} History
          </button>
        </div>

        <button
          onClick={handleRunPayout}
          disabled={!fromTimestamp || !toTimestamp || loadingData}
          className="px-8 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loadingData ? (
            <>
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
              Loading Data...
            </>
          ) : (
            'Run Payout'
          )}
        </button>

        {dataError && (
          <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <p className="text-sm text-red-600 dark:text-red-400">{dataError}</p>
          </div>
        )}
      </div>

      {/* Historical Payouts */}
      {showHistory && (
        <HistoricalPayoutsView
          payouts={historicalPayouts}
          loading={loadingHistory}
          onRefresh={loadHistoricalPayouts}
          onLoadWeek={handleLoadHistoricalWeek}
          onDelete={handleDeleteHistoricalWeek}
        />
      )}

      {/* Payout Results */}
      {hasCalculated && payoutResults && (
        <>
          {/* Summary Cards */}
          <div className="card bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-700 border-2 border-blue-200 dark:border-blue-700">
            <h2 className="text-xl font-semibold mb-4">Payout Summary</h2>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Money Reward" value={formatCurrency(payoutResults.totalMoneyReward)} color="orange" />
              <StatCard
                label="Item Reward"
                value={formatCurrency(payoutResults.totalItemReward)}
                color="blue"
                clickable={true}
                onClick={() => setShowItemRewards(!showItemRewards)}
              />
              <StatCard
                label="Item Cost"
                value={formatCurrency(payoutResults.totalItemCost)}
                color="red"
                clickable={true}
                onClick={() => setShowItemCosts(!showItemCosts)}
              />
              <StatCard label="Net Total" value={formatCurrency(payoutResults.totalMoneyReward + payoutResults.netItemValue)} color="green" />

              <StatCard label="Faction Cut" value={`${formatCurrency(payoutResults.factionCut)} [${factionCutPercent}%]`} color="purple" />
              <StatCard label="Member Pool" value={formatCurrency(payoutResults.memberPayoutTotal)} color="indigo" />
              <StatCard label="Members" value={payoutResults.participatingMembers} color="teal" />
              <StatCard label="Crimes" value={payoutResults.totalCrimes || payoutResults.crimesProcessed} color="gray" />
            </div>

            <button
              onClick={() => setShowCrimeStats(!showCrimeStats)}
              className="mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              {showCrimeStats ? 'Hide' : 'Show'} Crime Statistics
            </button>
          </div>

          {/* Crime Statistics */}
          {showCrimeStats && crimeStats && (
            <CrimeStatsView
              stats={crimeStats}
              fromTimestamp={fromTimestamp}
              toTimestamp={toTimestamp}
              onClose={() => setShowCrimeStats(false)}
            />
          )}

          {/* Item Rewards Breakdown */}
          {showItemRewards && payoutResults.itemBreakdown?.rewards && (
            <div className="card bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-200 dark:border-blue-700">
              <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-3">Item Rewards Breakdown</h4>

              <div className="overflow-x-auto">
                <div className="min-w-full">
                  {/* Header Row */}
                  <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-blue-700 dark:text-blue-300 border-b border-blue-300 dark:border-blue-700 pb-2 mb-2">
                    <div>Item Name</div>
                    <div className="text-right">Unit Value</div>
                    <div className="text-right">Quantity</div>
                    <div className="text-right">Total Value</div>
                  </div>

                  {/* Data Rows */}
                  <div className="space-y-1">
                    {Object.entries(payoutResults.itemBreakdown.rewards).map(([itemId, data]) => {
                      const unitValue = data.unitValue
                        ?? (data.quantity > 0 ? Math.floor(data.totalValue / data.quantity) : 0)
                      const isManual = data.priceSource === 'manual'
                      const isEditing = editingRewardPrice?.itemId === itemId
                      return (
                        <div key={itemId} className="grid grid-cols-4 gap-2 text-sm items-center">
                          <InfoTooltip
                            label={<span className="block truncate">{data.name}</span>}
                            decoration="no-underline"
                            className="block min-w-0 text-blue-800 dark:text-blue-200"
                          >{data.name}</InfoTooltip>
                          <div className="text-right">
                            {isEditing ? (
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="number"
                                  value={editingRewardPrice.value}
                                  onChange={e => setEditingRewardPrice({ ...editingRewardPrice, value: e.target.value })}
                                  className="input py-0 px-1 text-xs w-24 text-right"
                                  step="1"
                                  min="0"
                                  autoFocus
                                />
                                <button
                                  onClick={handleSaveRewardPrice}
                                  className="px-1 py-0 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                                  aria-label="Save price"
                                >
                                  ✓
                                </button>
                                <button
                                  onClick={handleCancelRewardPrice}
                                  className="px-1 py-0 bg-gray-600 text-white rounded text-xs hover:bg-gray-700"
                                  aria-label="Cancel"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                <span className={isManual ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-blue-700 dark:text-blue-300'}>
                                  {formatCurrency(unitValue)}
                                </span>
                                {isManual && (
                                  <InfoTooltip label="*" decoration="no-underline" className="text-amber-600">Manually adjusted</InfoTooltip>
                                )}
                                <button
                                  onClick={() => handleEditRewardPrice(itemId, unitValue)}
                                  className="px-1 py-0 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 ml-1"
                                  aria-label="Edit price"
                                >
                                  ✎
                                </button>
                                {isManual && (
                                  <button
                                    onClick={() => handleResetRewardPrice(itemId)}
                                    className="px-1 py-0 bg-orange-600 text-white rounded text-xs hover:bg-orange-700"
                                    aria-label="Reset to market price"
                                  >
                                    ↻
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="text-right text-blue-700 dark:text-blue-300">
                            {data.quantity.toLocaleString()}
                          </div>
                          <div className="text-right font-semibold text-blue-900 dark:text-blue-100">
                            {formatCurrency(data.totalValue)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-blue-300 dark:border-blue-700 flex justify-between font-bold">
                <span className="text-blue-900 dark:text-blue-100">Total:</span>
                <span className="text-blue-900 dark:text-blue-100">{formatCurrency(payoutResults.totalItemReward)}</span>
              </div>
            </div>
          )}

          {/* Item Costs Breakdown */}
          {showItemCosts && payoutResults.itemBreakdown?.costs && (
            <div className="card bg-red-50 dark:bg-red-900/20 border-2 border-red-200 dark:border-red-700">
              <h4 className="font-semibold text-red-900 dark:text-red-100 mb-3">Item Costs Breakdown</h4>

              <div className="overflow-x-auto">
                <div className="min-w-full">
                  {/* Header Row */}
                  <div className="grid grid-cols-4 gap-2 text-xs font-semibold text-red-700 dark:text-red-300 border-b border-red-300 dark:border-red-700 pb-2 mb-2">
                    <div>Item Name</div>
                    <div className="text-right">Unit Value</div>
                    <div className="text-right">Quantity</div>
                    <div className="text-right">Total Value</div>
                  </div>

                  {/* Data Rows */}
                  <div className="space-y-1">
                    {Object.entries(payoutResults.itemBreakdown.costs).map(([itemId, data]) => {
                      const unitValue = data.quantity > 0 ? Math.floor(data.totalValue / data.quantity) : 0
                      return (
                        <div key={itemId} className="grid grid-cols-4 gap-2 text-sm">
                          <InfoTooltip
                            label={<span className="block truncate">{data.name}</span>}
                            decoration="no-underline"
                            className="block min-w-0 text-red-800 dark:text-red-200"
                          >{data.name}</InfoTooltip>
                          <div className="text-right text-red-700 dark:text-red-300">
                            {formatCurrency(unitValue)}
                          </div>
                          <div className="text-right text-red-700 dark:text-red-300">
                            {data.quantity.toLocaleString()}
                          </div>
                          <div className="text-right font-semibold text-red-900 dark:text-red-100">
                            {formatCurrency(data.totalValue)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-red-300 dark:border-red-700 flex justify-between font-bold">
                <span className="text-red-900 dark:text-red-100">Total:</span>
                <span className="text-red-900 dark:text-red-100">{formatCurrency(payoutResults.totalItemCost)}</span>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="card">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
              >
                Export CSV
              </button>
              <button
                onClick={handleCopyBatchURL}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                Copy Batch URL
              </button>
              <button
                onClick={handleSaveWeek}
                disabled={isSaving || payoutResults.members.length === 0 || isVisitor}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : (isVisitor ? 'Save disabled (visitor)' : 'Save to Database')}
              </button>
            </div>

            {saveSuccess && (
              <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <p className="text-sm text-green-600 dark:text-green-400">
                  Payout saved successfully! {payoutResults.crimeIds.length} crimes linked.
                </p>
              </div>
            )}

            {saveError && (
              <div className="mt-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              </div>
            )}

            {showBatchURL && (
              <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <p className="text-sm text-blue-600 dark:text-blue-400">
                  Batch payout URL copied to clipboard!
                </p>
              </div>
            )}
          </div>

          {/* #389: what the poller observed for this window, alongside what was counted. */}
          <OccupancyPanel results={payoutResults} />

          {/* Member Payouts Table */}
          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Member Payouts</h3>
            <div className="overflow-auto max-h-[70vh] relative scrollbar-thin">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="text-left">
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 left-0 z-30 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600 whitespace-nowrap" onClick={() => handleSort('name')}>
                      Member <SortIcon columnKey="name" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('userId')}>
                      ID <SortIcon columnKey="userId" />
                    </th>
                    <th
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600"
                      onClick={() => handleSort('timeSpent')}
                    >
                      Time <SortIcon columnKey="timeSpent" />
                      {usingOccupancy && (
                        <span onClick={(e) => e.stopPropagation()} className="inline-flex ml-1">
                          <InfoDot label="About the Time column" size={11}>
                            Sourced from the occupancy poller (#389) — this window was
                            fully watched.
                          </InfoDot>
                        </span>
                      )}
                    </th>
                    {showObserved && (
                    <th
                      className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600 whitespace-nowrap"
                      onClick={() => handleSort('observedSeconds')}
                    >
                      Observed <SortIcon columnKey="observedSeconds" />
                      <span onClick={(e) => e.stopPropagation()} className="inline-flex ml-1">
                        <InfoDot label="About the Observed column" size={11}>
                          {usingOccupancy
                            ? 'What the occupancy poller watched (#389) — same as the Time column, this window was fully watched.'
                            : 'What the occupancy poller actually watched (#389). This window had a coverage gap, so payouts still use the legacy calculation.'}
                        </InfoDot>
                      </span>
                    </th>
                    )}
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('timePercent')}>
                      Time % <SortIcon columnKey="timePercent" />
                    </th>
                    {usesTiers && (
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('tier')}>
                      Tier <SortIcon columnKey="tier" />
                    </th>
                    )}
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('baseTickets')}>
                      Tickets <SortIcon columnKey="baseTickets" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('sitOutPenalty')}>
                      Penalty <SortIcon columnKey="sitOutPenalty" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('sharePercent')}>
                      Share % <SortIcon columnKey="sharePercent" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('payout')}>
                      Payout <SortIcon columnKey="payout" />
                    </th>
                    <th className="py-2 px-2 font-semibold text-xs cursor-pointer hover:bg-gray-200 dark:hover:bg-slate-600 sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600" onClick={() => handleSort('theoreticalPayout')}>
                      Theoretical <SortIcon columnKey="theoreticalPayout" />
                    </th>
                    {/* ⚠️ Not sortable — it is a control, and `payout` already
                        orders by the same fact. */}
                    <th className="py-2 px-2 font-semibold text-xs sticky top-0 z-20 bg-gray-50 dark:bg-slate-700 border-b-2 border-gray-200 dark:border-slate-600 text-right">
                      Eligible
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMembers.length === 0 ? (
                    <tr>
                      <td colSpan={(usesTiers ? 11 : 10) + (showObserved ? 1 : 0)} className="py-8 text-center text-gray-500">
                        No payouts calculated. Click "Run Payout" to calculate.
                      </td>
                    </tr>
                  ) : (
                    sortedMembers.map((member) => (
                      <tr key={member.userId} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                        <td className="py-2 px-2 font-medium text-xs whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800">{member.name}</td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">{member.userId}</td>
                        <TimeCell member={member} usingOccupancy={usingOccupancy} />
                        {showObserved && <ObservedCell member={member} usingOccupancy={usingOccupancy} />}
                        <td className="py-2 px-2 text-xs">{member.timePercent.toFixed(2)}%</td>
                        {usesTiers && <td className="py-2 px-2"><TierBadge tier={member.tier} /></td>}
                        <td className="py-2 px-2 text-xs">{member.baseTickets}</td>
                        <td className="py-2 px-2 text-xs">
                          {editingPenalty?.userId === member.userId ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                value={editingPenalty.value}
                                onChange={(e) => setEditingPenalty({ ...editingPenalty, value: e.target.value })}
                                className="input py-0 px-1 text-xs w-16"
                                step="1"
                              />
                              <button
                                onClick={() => handleSavePenalty(member.userId)}
                                className="px-1 py-0 bg-green-600 text-white rounded text-xs hover:bg-green-700"
                                aria-label="Save penalty"
                              >
                                ✓
                              </button>
                              <button
                                onClick={handleCancelPenalty}
                                className="px-1 py-0 bg-gray-600 text-white rounded text-xs hover:bg-gray-700"
                                aria-label="Cancel"
                              >
                                ✕
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className={member.sitOutPenalty < 0 ? 'text-red-600' : ''}>
                                {member.sitOutPenalty.toFixed(0)}
                              </span>
                              {member.penaltyOverridden && (
                                <InfoTooltip label="*" decoration="no-underline" className="text-blue-600">Override applied</InfoTooltip>
                              )}
                              <button
                                onClick={() => handleEditPenalty(member.userId, member.sitOutPenalty)}
                                className="px-1 py-0 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 ml-1"
                                aria-label="Edit penalty"
                              >
                                ✎
                              </button>
                              {member.penaltyOverridden && (
                                <button
                                  onClick={() => handleResetPenalty(member.userId)}
                                  className="px-1 py-0 bg-orange-600 text-white rounded text-xs hover:bg-orange-700"
                                  aria-label="Reset penalty to calculated"
                                >
                                  ↻
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs">{(member.sharePercent * 100).toFixed(4)}%</td>
                        <td className="py-2 px-2 font-semibold text-blue-600 dark:text-blue-400 text-xs">
                          {formatCurrency(member.payout)}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                          {formatCurrency(member.theoreticalPayout)}
                          {member.payout > member.theoreticalPayout && (
                            <span className="ml-1 text-green-600">+</span>
                          )}
                          {member.payout < member.theoreticalPayout && (
                            <span className="ml-1 text-red-600">-</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right">
                          {/* ⚠️ Excluding somebody REDISTRIBUTES their share —
                              the pot is fixed, so everybody else's number moves
                              with this click. The label says which way it will
                              go rather than showing a state to interpret. */}
                          <button
                            type="button"
                            onClick={() => toggleEligible(member.userId)}
                            data-testid={`oc-eligible-${member.userId}`}
                            className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                              member.isEligible === false
                                ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                                : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-700 dark:text-gray-400'
                            }`}
                            title={member.isEligible === false
                              ? 'Not being paid — click to include them, which lowers everybody else'
                              : 'Being paid — click to withhold, which raises everybody else'}
                          >
                            {member.isEligible === false ? 'Not paid' : 'Eligible'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                {sortedMembers.length > 0 && (
                  <tfoot>
                    <tr className="font-bold sticky left-0">
                      <td colSpan="8" className="py-2 px-2 text-right text-xs border-t-2 border-gray-300 dark:border-slate-600">TOTAL:</td>
                      <td className="py-2 px-2 text-blue-600 dark:text-blue-400 text-xs border-t-2 border-gray-300 dark:border-slate-600">
                        {formatCurrency(payoutResults.memberPayoutTotal)}
                      </td>
                      <td className="py-2 px-2 text-gray-600 dark:text-gray-400 text-xs border-t-2 border-gray-300 dark:border-slate-600">
                        {formatCurrency(sortedMembers.reduce((sum, m) => sum + m.theoreticalPayout, 0))}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </>
      )}

      {/* Help Text */}
      {!hasCalculated && !showHistory && (
        <div className="card bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">How to Use</h3>
          <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
            <li>Select date range (or use Current/Previous Week buttons)</li>
            <li>Adjust Faction Cut % if needed (default: 20%)</li>
            <li>Click "Run Payout" to load data and calculate</li>
            <li>Review the Payout Summary and Member Payouts table</li>
            <li>Compare Actual Payout vs Theoretical Payout per member</li>
            <li>Click "Save to Database" to store the payout with crime links</li>
          </ol>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, color, clickable, onClick }) {
  const colorClasses = {
    orange: 'border-orange-200 dark:border-orange-700',
    blue: 'border-blue-200 dark:border-blue-700',
    red: 'border-red-200 dark:border-red-700',
    green: 'border-green-200 dark:border-green-700',
    purple: 'border-purple-200 dark:border-purple-700',
    indigo: 'border-indigo-200 dark:border-indigo-700',
    teal: 'border-teal-200 dark:border-teal-700',
    gray: 'border-gray-200 dark:border-gray-700'
  }

  const textClasses = {
    orange: 'text-orange-600 dark:text-orange-400',
    blue: 'text-blue-600 dark:text-blue-400',
    red: 'text-red-600 dark:text-red-400',
    green: 'text-green-600 dark:text-green-400',
    purple: 'text-purple-600 dark:text-purple-400',
    indigo: 'text-indigo-600 dark:text-indigo-400',
    teal: 'text-teal-600 dark:text-teal-400',
    gray: 'text-gray-600 dark:text-gray-400'
  }

  return (
    <div
      className={`bg-white dark:bg-slate-800 rounded-lg p-3 border-2 ${colorClasses[color]} ${clickable ? 'cursor-pointer hover:shadow-lg transition-shadow' : ''}`}
      onClick={clickable ? onClick : undefined}
    >
      <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
        {label}
        {clickable && <span className="ml-1 text-gray-400">▼</span>}
      </div>
      <div className={`text-lg font-bold ${textClasses[color]}`}>{value}</div>
    </div>
  )
}

function TierBadge({ tier }) {
  const colors = { 0: 'bg-tier-review', 1: 'bg-tier-1', 2: 'bg-tier-2', 3: 'bg-tier-3', 4: 'bg-tier-4', 5: 'bg-tier-5', 6: 'bg-tier-6' }
  const label = tier === 0 ? 'Review' : `T${tier}`
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-white font-semibold text-xs ${colors[tier] ?? 'bg-tier-review'}`}>
      {label}
    </span>
  )
}

// Time-spent cell with a breakdown behind it (#168). When a member banked time
// in crimes they left before execution, flag it red and list those stints so
// leadership can see a legitimate reassignment vs join-and-bail farming.
//
// #389 part 3: once occupancy drives the payout, `bankedSeconds` is a stale
// legacy figure — occupancy already reflects true continuous presence through
// an early leave or a seat change, so there is nothing left to flag.
function TimeCell({ member, usingOccupancy }) {
  const bankedCrimes = member.bankedCrimes || []
  const bankedSeconds = member.bankedSeconds || 0
  const hasBanked = !usingOccupancy && bankedSeconds > 0
  if (!hasBanked) {
    return <td className="py-2 px-2 text-xs">{formatTimeHours(member.timeSpent)}</td>
  }
  // ⚠️ Was a `group-hover` panel, so the breakdown behind the ⚑ did not exist on
  // a phone — and the ⚑ still rendered, announcing banked time nobody could
  // account for (#612).
  return (
    <td className="py-2 px-2 text-xs">
      <InfoTooltip
        label={<>{formatTimeHours(member.timeSpent)}<span className="ml-1 text-red-500">⚑</span></>}
        decoration="underline decoration-dashed decoration-red-400 underline-offset-2"
      >
        <div className="w-64">
          <div className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 mb-1">
            Time breakdown — includes banked time from crimes left early
          </div>
          <div className="flex justify-between text-[11px] text-gray-600 dark:text-gray-300">
            <span>Completed / current</span>
            <span>{formatTimeHours(Math.max(0, member.timeSpent - bankedSeconds))}</span>
          </div>
          <div className="mt-1 pt-1 border-t border-gray-100 dark:border-slate-700 space-y-0.5">
            {bankedCrimes.map((c) => (
              <div key={c.crime_id} className="flex justify-between gap-2 text-[11px] text-red-600 dark:text-red-400">
                <span className="truncate">{c.crime_name || 'Crime'} #{c.crime_id} · left early</span>
                <span className="whitespace-nowrap">+{formatTimeHours(c.seconds)}</span>
              </div>
            ))}
          </div>
        </div>
      </InfoTooltip>
    </td>
  )
}

// What the poller watched for this member (#389), next to what the legacy
// crime_slots calculation counted. Once a window is fully watched (#389 part
// 3), this IS the figure driving the payout — member.timeSpent already equals
// observedSeconds, so the delta compares against legacyTimeSpent instead, to
// keep showing how far the old method would have landed.
//
// A member with no observation at all renders as an em dash, never 0h — the
// difference between "we watched and saw none" and "we have no record" is the
// entire point of the coverage tracking this column relies on.
function ObservedCell({ member, usingOccupancy }) {
  const observed = member.observedSeconds
  if (observed === undefined || observed === null) {
    return (
      <td className="py-2 px-2 text-xs text-gray-400">
        <InfoTooltip label="—">No occupancy record for this member.</InfoTooltip>
      </td>
    )
  }
  const compareAgainst = usingOccupancy ? (member.legacyTimeSpent ?? 0) : (member.timeSpent ?? 0)
  const delta = observed - compareAgainst
  // Only the direction that indicates the bug gets colour. The poller seeing
  // LESS is expected while its history is short and does not need flagging.
  const overInferred = delta < -30 * 60
  return (
    <td className="py-2 px-2 text-xs whitespace-nowrap">
      <span className="tabular-nums">{formatTimeHours(observed)}</span>
      {Math.abs(delta) >= 30 * 60 && (
        <InfoTooltip
          label={formatDelta(delta)}
          className={`ml-1 tabular-nums ${overInferred ? 'text-red-500' : 'text-gray-400'}`}
        >
          {overInferred
            ? 'The legacy crime_slots calculation credits more time than the poller ever saw.'
            : 'The poller saw less — likely it was not running for part of this stint.'}
        </InfoTooltip>
      )}
    </td>
  )
}

function HistoricalPayoutsView({ payouts, loading, onRefresh, onLoadWeek, onDelete }) {
  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mr-3"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading historical payouts...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Historical Payouts</h3>
        <button
          onClick={onRefresh}
          className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          Refresh
        </button>
      </div>

      {payouts.length === 0 ? (
        <p className="text-center text-gray-500 py-8">No historical payouts found</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b-2 border-gray-200 dark:border-slate-700">
              <tr className="text-left">
                <th className="py-2 px-2 font-semibold text-xs">Week</th>
                <th className="py-2 px-2 font-semibold text-xs">Total Payout</th>
                <th className="py-2 px-2 font-semibold text-xs">Members</th>
                <th className="py-2 px-2 font-semibold text-xs">Crimes</th>
                <th className="py-2 px-2 font-semibold text-xs">Faction Cut</th>
                <th className="py-2 px-2 font-semibold text-xs">Saved By</th>
                <th className="py-2 px-2 font-semibold text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((payout) => (
                <tr key={payout.id} className="border-b border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700/50">
                  <td className="py-2 px-2 text-xs">
                    <button
                      onClick={() => onLoadWeek(payout.id)}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      {payout.week_start} to {payout.week_end}
                    </button>
                  </td>
                  <td className="py-2 px-2 text-xs font-semibold text-blue-600">
                    {formatCurrencyShort(payout.member_payout_total || payout.total_member_payout || 0)}
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.member_count || '-'}</td>
                  <td className="py-2 px-2 text-xs">
                    {payout.crimes_processed || (payout.crime_ids?.length || 0)}
                  </td>
                  <td className="py-2 px-2 text-xs">{payout.faction_cut_percent?.toFixed(0) || 20}%</td>
                  <td className="py-2 px-2 text-xs text-gray-500">{payout.saved_by}</td>
                  <td className="py-2 px-2 text-xs">
                    <div className="flex gap-2">
                      <button
                        onClick={() => onLoadWeek(payout.id)}
                        className="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 text-xs"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => onDelete(payout)}
                        className="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-xs"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


