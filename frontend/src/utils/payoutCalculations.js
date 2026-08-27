/**
 * Payout Calculation Utilities
 *
 * Calculates member payouts based on tier, time spent, and crime participation.
 * Works directly with data loaded via payoutDataLoader.js.
 *
 * All times use TCT (Torn City Time) which is UTC/GMT.
 */

const TIER_TICKETS = {
  1: 40,
  2: 30,
  3: 15,
  4: 7,
  5: 3,
  6: 2
}

// Payout modes (#134):
//   tiered        — per-tier base tickets (Forge). The original behavior.
//   flat-weighted — every member gets the same base tickets (as if one tier);
//                   time-spent / sit-out weighting still applies.
//   equal         — even split among members who did >=1 OC; no weighting,
//                   no sit-out floor.
// Absent faction setting defaults to flat-weighted — tiered is Forge-specific,
// so the multi-faction default must not assume tiers.
export const PAYOUT_MODES = ['tiered', 'flat-weighted', 'equal']
export const DEFAULT_PAYOUT_MODE = 'flat-weighted'

// Whether a faction's payout mode makes the tier machinery meaningful (#136).
// Only `tiered` uses tiers; every other mode (and an absent/unknown setting,
// which defaults to flat-weighted) hides the tier UI entirely.
export function factionUsesTiers(mode) {
  return (mode ?? DEFAULT_PAYOUT_MODE) === 'tiered'
}

// #168: aggregate a member's "banked" time — seconds spent in crimes they LEFT
// before execution (the left-early participation stints), each clipped to the
// payout window. Returns { [memberId]: { seconds, crimes: [{crime_id,
// crime_name, seconds}] } }. Today's slot-based calc counts this as zero, so
// it's added on top (no double-count: they aren't in the current/executed slots).
export function bankedTimeByMember(participation, fromTimestamp, toTimestamp) {
  const byMember = {}
  for (const seg of participation || []) {
    const joined = Number(seg.joined_at)
    const left = Number(seg.left_at)
    if (!Number.isFinite(joined) || !Number.isFinite(left)) continue
    const start = Math.max(joined, fromTimestamp)
    const end = Math.min(left, toTimestamp)
    const seconds = end - start
    if (seconds <= 0) continue
    const id = String(seg.member_id)
    if (!byMember[id]) byMember[id] = { seconds: 0, crimes: [], intervals: [] }
    byMember[id].seconds += seconds
    byMember[id].crimes.push({ crime_id: String(seg.crime_id), crime_name: seg.crime_name || null, seconds })
    // #262: the clipped [start, end] bounds so the caller can UNION these with
    // completed-crime time instead of summing (which double-counts overlaps).
    byMember[id].intervals.push([start, end])
  }
  return byMember
}
// #262's interval union now lives in ./intervals so occupancyTime can use it
// without importing this module back. Re-exported: it is part of this module's
// published surface and the tests import it from here.
export { mergeIntervalSeconds } from './intervals'
import { mergeIntervalSeconds } from './intervals'
import { occupancySecondsByMember, pollCoverage, joinedAtDrift } from './occupancyTime'


// Uniform base for the non-tiered modes (Tier-1 value). In flat-weighted this
// cancels out of the share math — it's only what shows in the Tickets column.
const FLAT_BASE_TICKETS = TIER_TICKETS[1]

// Time thresholds for penalty calculation (in seconds)
const MIN_TIME_FOR_FULL_TICKETS = 120 * 3600  // 120 hours = 432,000 seconds
const MIN_TIME_FOR_ANY_PAYOUT = 48 * 3600     // 48 hours = 172,800 seconds

/**
 * Get week range from a date (Monday 00:00:00 UTC to Sunday 23:59:59 UTC)
 * Uses TCT (UTC) exclusively
 */
export function getWeekRangeFromDate(date) {
  // Create date in UTC
  // db-time-safe: `date` is a Date or a DATE-column string ("2026-08-03").
  const d = new Date(date)

  // Get day of week in UTC (0 = Sunday, 1 = Monday, etc.)
  const dayOfWeek = d.getUTCDay()

  // Calculate Monday of this week in UTC
  // db-time-safe: Date copy.
  const monday = new Date(d)
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  monday.setUTCDate(d.getUTCDate() - daysToSubtract)
  monday.setUTCHours(0, 0, 0, 0)

  // Sunday is 6 days after Monday, ends at 23:59:59.999
  // db-time-safe: Date copy.
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  sunday.setUTCHours(23, 59, 59, 999)

  return {
    monday,
    sunday,
    // Use >= fromTimestamp and < toTimestamp+1 to avoid overlap
    // Monday 00:00:00 UTC timestamp
    mondayTimestamp: Math.floor(monday.getTime() / 1000),
    // Sunday 23:59:59 UTC timestamp (we'll use < next Monday for filtering)
    sundayTimestamp: Math.floor(sunday.getTime() / 1000)
  }
}

/**
 * Get current week range in TCT (UTC)
 */
export function getCurrentWeekRange() {
  return getWeekRangeFromDate(new Date())
}

/**
 * Get previous week range in TCT (UTC)
 */
export function getPreviousWeekRange() {
  const currentWeek = getCurrentWeekRange()
  // db-time-safe: Date copy.
  const previousMonday = new Date(currentWeek.monday)
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7)
  return getWeekRangeFromDate(previousMonday)
}

/**
 * Format a date to YYYY-MM-DD in UTC
 */
export function formatDateUTC(date) {
  // db-time-safe: `date` is a Date or a DATE-column string.
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse a YYYY-MM-DD string as UTC midnight
 */
export function parseDateAsUTC(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
}

/**
 * Calculate time spent in a crime for a specific member
 * @param {number} joinedAt - When the member joined (Unix timestamp)
 * @param {number} timeReference - End time reference (executed_at or toTimestamp)
 * @param {number} fromTimestamp - Start of payout period
 * @param {number} toTimestamp - End of payout period
 * @returns {number} Time spent in seconds
 */
export function calculateTimeSpent(joinedAt, timeReference, fromTimestamp, toTimestamp) {
  if (!joinedAt || joinedAt > toTimestamp) {
    return 0
  }

  // Clamp to the payout window
  const effectiveStart = Math.max(joinedAt, fromTimestamp)
  const effectiveEnd = Math.min(timeReference, toTimestamp)

  if (effectiveStart >= effectiveEnd) {
    return 0
  }

  return effectiveEnd - effectiveStart
}

/**
 * Calculate sit-out penalty based on absolute time thresholds
 * 
 * >= 120 hours: NO penalty (full tickets)
 * < 48 hours: FULL penalty ($0 payout)
 * 48-120 hours: Sliding scale
 */
function calculateSitOutPenalty(timeSpent, baseTickets) {
  if (timeSpent >= MIN_TIME_FOR_FULL_TICKETS) {
    return 0
  }

  if (timeSpent < MIN_TIME_FOR_ANY_PAYOUT) {
    return -baseTickets
  }

  // Sliding scale between 48-120 hours
  const timeRange = MIN_TIME_FOR_FULL_TICKETS - MIN_TIME_FOR_ANY_PAYOUT
  const timeAboveMin = timeSpent - MIN_TIME_FOR_ANY_PAYOUT
  const percentOfRange = timeAboveMin / timeRange

  return Math.ceil(-(1 - percentOfRange) * baseTickets)
}

/**
 * Calculate theoretical payouts by splitting each crime's net value equally among its participants.
 *
 * For successful crimes: net = (money_reward + item_reward - item_cost) * (1 - factionCut)
 * For failed crimes: net = -item_cost (no faction cut — there's no reward to cut from)
 * per_member = floor(net / participant_count)
 *
 * Failed crimes charge participants for lost items. Members can have negative theoretical payouts.
 *
 * @param {Object} crimeValues - Map of crimeId -> { netValue, successful, participantIds }
 * @param {number} factionCutPercent - Faction cut as decimal (e.g. 0.20)
 * @returns {Object} Map of userId -> theoretical payout amount
 */
export function calculateTheoreticalPayouts(crimeValues, factionCutPercent) {
  const theoreticalByMember = {}

  for (const crime of Object.values(crimeValues)) {
    const participantCount = crime.participantIds.length
    if (participantCount === 0) continue

    // Apply faction cut only to successful crimes
    const netValue = crime.successful
      ? crime.netValue * (1 - factionCutPercent)
      : crime.netValue

    const perMember = Math.floor(netValue / participantCount)

    for (const userId of crime.participantIds) {
      if (!theoreticalByMember[userId]) theoreticalByMember[userId] = 0
      theoreticalByMember[userId] += perMember
    }
  }

  return theoreticalByMember
}

/**
 * Validate that no member appears in two active (non-completed) crimes at the same time.
 * Members cannot be in two OC crimes simultaneously in Torn, so any overlap indicates a data issue.
 *
 * @param {Object} crimesData - { crimes: { [crime_id]: crimeObject } }
 * @returns {{ valid: boolean, warnings: string[] }}
 */
export function validateNoOverlappingCrimes(crimesData) {
  const crimes = crimesData?.crimes || {}
  const warnings = []

  // Build intervals per member: { userId: [{ crimeId, start, end }] }
  const memberIntervals = {}

  for (const [crimeId, crime] of Object.entries(crimes)) {
    const slots = crime.slots || []
    const executedAt = crime.executed_at || 0
    const status = crime.status

    for (const slot of slots) {
      if (!slot.user || !slot.user.id) continue
      const userId = slot.user.id.toString()
      const joinedAt = slot.user.joined_at
      if (!joinedAt) continue

      // End of participation is when the crime completed (or now if still in progress)
      let endTime
      if (status === 'Successful' || status === 'Failed' || status === 'Failure') {
        endTime = executedAt
      } else {
        endTime = Math.floor(Date.now() / 1000)
      }

      if (!memberIntervals[userId]) memberIntervals[userId] = []
      memberIntervals[userId].push({ crimeId, start: joinedAt, end: endTime })
    }
  }

  // Check for overlaps within each member
  for (const [userId, intervals] of Object.entries(memberIntervals)) {
    if (intervals.length < 2) continue

    // Sort by start time
    const sorted = [...intervals].sort((a, b) => a.start - b.start)

    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start < sorted[i].end) {
          warnings.push(
            `Member ${userId}: overlap between crime ${sorted[i].crimeId} ` +
            `(${sorted[i].start}-${sorted[i].end}) and crime ${sorted[j].crimeId} ` +
            `(${sorted[j].start}-${sorted[j].end})`
          )
        }
      }
    }
  }

  return { valid: warnings.length === 0, warnings }
}

/**
 * Main payout calculation function
 * Works with data loaded via payoutDataLoader.js
 * 
 * IMPORTANT: Uses >= fromTimestamp and < toTimestamp to avoid overlaps
 * 
 * @param {Object} crimesData - { crimes: { [crime_id]: crimeObject } }
 * @param {Object} membersData - { members: { [member_id]: memberObject } }
 * @param {number} fromTimestamp - Start of payout period (inclusive)
 * @param {number} toTimestamp - End of payout period (exclusive for filtering, but use full range for time)
 * @param {number} factionCutPercent - Faction cut as decimal (e.g., 0.20 for 20%)
 * @returns {Object} Payout calculation results
 */
export function calculatePayouts(crimesData, membersData, fromTimestamp, toTimestamp, factionCutPercent = 0.20, mode = 'tiered') {
  console.log('\n===========================================')
  console.log('PAYOUT CALCULATION START')
  console.log('===========================================')
  console.log('Time range:', new Date(fromTimestamp * 1000).toISOString(), 'to', new Date(toTimestamp * 1000).toISOString())
  console.log('Faction cut:', (factionCutPercent * 100).toFixed(1) + '%')

  const crimes = crimesData?.crimes || {}
  const members = membersData?.members || {}

  if (Object.keys(crimes).length === 0) {
    console.log('No crimes data available')
    return createEmptyResult()
  }

  // Track participating members
  const participatingMembers = {}

  // Track totals - ONLY for crimes executed within range
  let totalMoneyReward = 0
  let totalItemReward = 0
  let totalItemCost = 0
  let crimesProcessed = 0
  const crimeIds = []

  // Item details for display
  const rewardItemDetails = []
  const consumedItemDetails = []

  // Per-crime values for theoretical payout calculation
  const crimeValues = {}

  // Crime statistics - ONLY for crimes executed within range
  const crimesByDifficulty = {}
  const crimesByStatus = { Successful: 0, Failed: 0, Planning: 0, Recruiting: 0 }

  // Process each crime
  for (const [crimeId, crime] of Object.entries(crimes)) {
    const status = crime.status
    const executedAt = crime.executed_at || 0
    const createdAt = crime.created_at || 0
    const difficulty = crime.difficulty || 1

    // When this crime stopped accruing time for its members (#392).
    //
    // This used to be "executed → executed_at, everything else → now", which
    // quietly meant EXPIRED crimes accrued to the window edge. An OC that
    // never filled and lapsed six hours into the week credited everyone
    // sitting in it the full 168 hours — a whole-interval error, and because
    // Time Spent is a share of the total, it moved money away from members who
    // had actually been in crimes.
    //
    // Only Planning and Recruiting are genuinely still running. Anything else
    // has stopped, and stopped when its resolution marker says: executed_at for
    // the executed statuses, expired_at for a lapsed one. An unrecognised
    // status falls to the same rule rather than to "still running", because the
    // status list has gone stale once already (the participation tracker spent
    // months matching a status Torn never sends) and the failure mode of
    // guessing "running" is the expensive one.
    const inProgress = status === 'Planning' || status === 'Recruiting'
    const resolvedAt = executedAt || crime.expired_at || 0
    const timeReference = inProgress || resolvedAt <= 0
      ? Math.min(Math.floor(Date.now() / 1000), toTimestamp)
      : resolvedAt

    // Check if crime was executed within our window
    // Use >= fromTimestamp and < toTimestamp to avoid double-counting at boundaries
    const inTimeWindow = executedAt >= fromTimestamp && executedAt < toTimestamp

    // Process successful crimes for rewards (only if in time window)
    if (status === 'Successful' && inTimeWindow) {
      crimesProcessed++
      crimeIds.push(crimeId)

      const crimeMoneyReward = crime.rewards?.money || 0
      const crimeItemReward = crime.item_reward_value || 0
      const crimeItemCost = crime.item_cost_value || 0

      totalMoneyReward += crimeMoneyReward
      totalItemReward += crimeItemReward
      totalItemCost += crimeItemCost

      // Track per-crime value for theoretical payout
      crimeValues[crimeId] = {
        netValue: crimeMoneyReward + crimeItemReward - crimeItemCost,
        moneyReward: crimeMoneyReward,
        successful: true,
        participantIds: []
      }

      crimesByStatus.Successful++

      // Initialize difficulty tracking
      if (!crimesByDifficulty[difficulty]) {
        crimesByDifficulty[difficulty] = { success: 0, failed: 0, total: 0 }
      }
      crimesByDifficulty[difficulty].success++
      crimesByDifficulty[difficulty].total++

      // Collect reward item details — skip quantity=0 rows. Torn's API
      // lists potential drops the crime *could* have produced even when
      // nothing was actually awarded (most visible on Window of
      // Opportunity). The Edge Function ingest filters these out, but the
      // Python scraper has historically not, so stale 0-qty rows can sit
      // in crime_reward_items. Defense in depth so the breakdown never
      // shows a Quantity 0 row even if the upstream filter misses.
      if (crime.reward_items && crime.reward_items.length > 0) {
        for (const item of crime.reward_items) {
          const qty = Number(item.quantity) || 0
          if (qty <= 0) continue
          rewardItemDetails.push({
            crimeId,
            crimeName: crime.name,
            itemId: item.item_id,
            itemName: item.item_name,
            quantity: qty,
            unitValue: item.unit_value || 0,
            totalValue: (item.unit_value || 0) * qty,
          })
        }
      }

      // Collect consumed item details
      if (crime.required_items && crime.required_items.length > 0) {
        for (const item of crime.required_items) {
          if (item.was_consumed) {
            consumedItemDetails.push({
              crimeId,
              crimeName: crime.name,
              itemId: item.item_id,
              itemName: item.item_name,
              userId: item.user_id,
              unitValue: item.unit_value || 0,
              outcome: item.outcome
            })
          }
        }
      }
    } else if ((status === 'Failed' || status === 'Failure') && inTimeWindow) {
      crimeIds.push(crimeId)
      crimesByStatus.Failed++

      if (!crimesByDifficulty[difficulty]) {
        crimesByDifficulty[difficulty] = { success: 0, failed: 0, total: 0 }
      }
      crimesByDifficulty[difficulty].failed++
      crimesByDifficulty[difficulty].total++

      // Collect consumed items from failed crimes too (items are still lost)
      let failedItemCost = 0
      if (crime.required_items && crime.required_items.length > 0) {
        for (const item of crime.required_items) {
          if (item.was_consumed) {
            failedItemCost += item.unit_value || 0
            totalItemCost += item.unit_value || 0
            consumedItemDetails.push({
              crimeId,
              crimeName: crime.name,
              itemId: item.item_id,
              itemName: item.item_name,
              userId: item.user_id,
              unitValue: item.unit_value || 0,
              outcome: item.outcome
            })
          }
        }
      }

      // Track failed crime for theoretical payout (no rewards, only item cost → negative)
      crimeValues[crimeId] = {
        netValue: -failedItemCost,
        moneyReward: 0,
        successful: false,
        participantIds: []
      }
    }
    // Note: Planning and Recruiting crimes are counted but not in time window stats

    // Process slots for time tracking (all crimes, not just successful ones)
    const slots = crime.slots || []

    for (const slot of slots) {
      if (!slot.user || !slot.user.id) continue

      const userId = slot.user.id.toString()
      const joinedAt = slot.user.joined_at

      // Skip if joined after our time window
      if (joinedAt > toTimestamp) continue

      // Get member data
      const memberData = members[userId] || {}

      // Initialize member tracking
      if (!participatingMembers[userId]) {
        const memberName = slot.user.name || memberData.name || 'Unknown'
        const displayName = memberName !== 'Unknown' ? `${memberName} [${userId}]` : `User ${userId}`

        participatingMembers[userId] = {
          userId: slot.user.id,
          name: displayName,
          tier: memberData.tier ?? 6,
          crimesCount: 0,
          timeSpent: 0,
          crimeIds: [],
          positions: [],
          completedIntervals: [],
          bankedIntervals: [],
        }
      }

      // #262: record this crime's clipped [start, end] rather than summing its
      // length — a member's total time is the UNION of their intervals (they can
      // only be in one OC at a time), computed after all crimes are collected.
      if (joinedAt && joinedAt <= toTimestamp) {
        const effStart = Math.max(joinedAt, fromTimestamp)
        const effEnd = Math.min(timeReference, toTimestamp)
        if (effEnd > effStart) participatingMembers[userId].completedIntervals.push([effStart, effEnd])
      }
      participatingMembers[userId].crimeIds.push(crimeId)

      // Only count as participated if crime is successful and in time window
      if (status === 'Successful' && inTimeWindow) {
        participatingMembers[userId].crimesCount++
      }

      // Track participants for theoretical payout (both successful and failed crimes)
      if (crimeValues[crimeId]) {
        crimeValues[crimeId].participantIds.push(userId)
      }

      participatingMembers[userId].positions.push({
        crimeId,
        difficulty,
        position: slot.position,
        cpr: slot.checkpoint_pass_rate || 0,
        status
      })
    }
  }

  // #168/#262: time banked in crimes a member LEFT before execution (the slot
  // loop above counts these as zero — they've been refilled). We UNION these
  // stints with the member's completed/current intervals rather than adding
  // them, so overlapping wall-clock time isn't double-counted. A member whose
  // ONLY window activity was a left-early stint is added here so they still get
  // credit.
  const banked = bankedTimeByMember(crimesData?.participation, fromTimestamp, toTimestamp)
  for (const [userId, info] of Object.entries(banked)) {
    if (info.seconds <= 0) continue
    if (!participatingMembers[userId]) {
      const memberData = members[userId] || {}
      const memberName = memberData.name || 'Unknown'
      participatingMembers[userId] = {
        userId,
        name: memberName !== 'Unknown' ? `${memberName} [${userId}]` : `User ${userId}`,
        tier: memberData.tier ?? 6,
        crimesCount: 0,
        timeSpent: 0,
        crimeIds: [],
        positions: [],
        completedIntervals: [],
        bankedIntervals: [],
      }
    }
    participatingMembers[userId].bankedIntervals.push(...info.intervals)
    participatingMembers[userId].bankedCrimes = info.crimes
  }

  // #262: collapse each member's intervals into actual elapsed time. timeSpent
  // is the union of completed + banked intervals (clipped to the window, so it
  // can never exceed the window duration); bankedSeconds is the *extra* credit
  // left-early stints add beyond the completed/current time (0 when they fully
  // overlap it) — this keeps the "Completed / current" breakdown coherent.
  for (const member of Object.values(participatingMembers)) {
    const completedSeconds = mergeIntervalSeconds(member.completedIntervals)
    member.timeSpent = mergeIntervalSeconds([...member.completedIntervals, ...member.bankedIntervals])
    member.bankedSeconds = Math.max(0, member.timeSpent - completedSeconds)
    // Time that DRIVES MONEY, as distinct from time that is displayed (#389).
    //
    // MonChoon, 2026-08-12: "do not use the early leave in the calculation,
    // only have the legacy time spent in crime as part of the ticket portion.
    // I will observe the data for a few weeks until I can verify its working."
    //
    // So banked (left-early) time stays fully visible — timeSpent and
    // bankedSeconds are unchanged and the page reads exactly as before — but
    // tickets, the sit-out penalty and the payout share are computed from the
    // completed/current intervals alone. Once the occupancy poller has enough
    // history to check banked time against, this collapses back to timeSpent.
    member.ticketTimeSpent = completedSeconds
    delete member.completedIntervals
    delete member.bankedIntervals
  }

  // #389 part 2: what the occupancy poller OBSERVED for the same window.
  //
  // Reported alongside the inferred figures, never instead of them. MonChoon is
  // watching these for a few weeks before they are allowed to move money, and
  // switching automatically the moment coverage looked complete would take that
  // decision away — after four passes where this calculation was confidently
  // wrong, "the numbers changed and nobody chose that" is the outcome most
  // worth designing against.
  //
  // Everything needed to make the call ships with it: per-member observed
  // seconds to compare against, whether the poller actually watched the
  // window, and how far our first sighting sits from Torn's own joined_at.
  const observed = occupancySecondsByMember(crimesData?.occupancy, fromTimestamp, toTimestamp)
  for (const member of Object.values(participatingMembers)) {
    member.observedSeconds = observed[String(member.userId)]?.seconds ?? 0
  }

  console.log('Crimes processed (successful in window):', crimesProcessed)
  console.log('Total money reward:', totalMoneyReward)
  console.log('Total item reward:', totalItemReward)
  console.log('Total item cost:', totalItemCost)
  console.log('Participating members:', Object.keys(participatingMembers).length)

  // Calculate total pool after faction cut
  const grossTotal = totalMoneyReward + totalItemReward - totalItemCost
  const factionCut = Math.floor(grossTotal * factionCutPercent)
  const memberPayoutTotal = grossTotal - factionCut

  // Convert to array and calculate tickets/penalties
  let memberArray = Object.values(participatingMembers)

  // Include any member who has time in any crime during the window (successful,
  // failed, planning, recruiting, or post-window) — matches Google Sheets behavior.
  // Also include current faction members even if they had no crime participation.
  memberArray = memberArray.filter(member => {
    // Member had time in at least one crime overlapping the window
    if (member.timeSpent > 0) return true

    // Current faction member (should appear with $0 if no participation)
    const memberData = members[member.userId.toString()]
    if (memberData?.is_current === true) return true

    return false
  })

  if (memberArray.length === 0) {
    console.log('No participating members found')
    return createEmptyResult()
  }

  const totalTimeSpent = memberArray.reduce((sum, m) => sum + m.timeSpent, 0)
  const averageTime = totalTimeSpent / memberArray.length

  // Calculate tickets and penalties for each member. tiered uses per-tier
  // tickets; flat-weighted and equal use a uniform base (equal ignores the
  // ticket weighting entirely below, but still carries a base for display).
  for (const member of memberArray) {
    const baseTickets = mode === 'tiered'
      ? (TIER_TICKETS[member.tier] || TIER_TICKETS[6])
      : FLAT_BASE_TICKETS
    const sitOutPenalty = calculateSitOutPenalty(member.ticketTimeSpent, baseTickets)

    member.baseTickets = baseTickets
    member.sitOutPenalty = sitOutPenalty
    member.adjustedTickets = Math.max(0, baseTickets + sitOutPenalty)
  }

  // Calculate theoretical payouts: split each crime's net value equally among participants.
  // Failed crimes contribute negative values (item costs charged to participants).
  const theoreticalByMember = calculateTheoreticalPayouts(crimeValues, factionCutPercent)

  for (const member of memberArray) {
    member.theoreticalPayout = theoreticalByMember[member.userId.toString()] || 0
  }

  // Calculate total adjusted tickets
  const totalAdjustedTickets = memberArray.reduce((sum, m) => sum + m.adjustedTickets, 0)

  // Calculate share and payout for each member.
  if (mode === 'equal') {
    // Even split among members who did at least one OC (participated in the
    // window) — no ticket weighting, no sit-out floor.
    // ticketTimeSpent, not timeSpent: a member whose only activity was a
    // left-early stint has no ticket time, so they do not take an equal share
    // while banked time is excluded from the money (#389).
    const participants = memberArray.filter(m => m.ticketTimeSpent > 0)
    const share = participants.length > 0 ? 1 / participants.length : 0
    const each = participants.length > 0 ? Math.floor(memberPayoutTotal / participants.length) : 0
    for (const member of memberArray) {
      const isParticipant = member.ticketTimeSpent > 0
      member.sharePercent = isParticipant ? share : 0
      member.payout = isParticipant ? each : 0
    }
  } else {
    // tiered + flat-weighted: proportional to adjusted (time-weighted) tickets.
    for (const member of memberArray) {
      if (totalAdjustedTickets > 0) {
        member.sharePercent = member.adjustedTickets / totalAdjustedTickets
        member.payout = Math.floor(member.sharePercent * memberPayoutTotal)
      } else {
        member.sharePercent = 0
        member.payout = 0
      }
    }
  }

  // Time percentage (mode-independent)
  for (const member of memberArray) {
    member.timePercent = totalTimeSpent > 0 ? (member.timeSpent / totalTimeSpent) * 100 : 0
  }

  // Sort by payout descending
  memberArray.sort((a, b) => b.payout - a.payout)

  // Calculate crime statistics
  const totalCrimes = crimesByStatus.Successful + crimesByStatus.Failed
  const successRate = totalCrimes > 0 ? (crimesByStatus.Successful / totalCrimes) * 100 : 0

  console.log('Crime stats - Successful:', crimesByStatus.Successful, 'Failed:', crimesByStatus.Failed)
  console.log('Success rate:', successRate.toFixed(1) + '%')
  console.log('===========================================\n')

  // Create item breakdown structure
  const itemBreakdown = {
    rewards: {},
    costs: {}
  }

  // Aggregate reward items
  for (const item of rewardItemDetails) {
    if (!itemBreakdown.rewards[item.itemId]) {
      itemBreakdown.rewards[item.itemId] = {
        name: item.itemName || `Item ${item.itemId}`,
        quantity: 0,
        totalValue: 0
      }
    }
    itemBreakdown.rewards[item.itemId].quantity += item.quantity
    itemBreakdown.rewards[item.itemId].totalValue += item.totalValue
  }

  // Aggregate consumed items
  for (const item of consumedItemDetails) {
    if (!itemBreakdown.costs[item.itemId]) {
      itemBreakdown.costs[item.itemId] = {
        name: item.itemName || `Item ${item.itemId}`,
        quantity: 0,
        totalValue: 0
      }
    }
    itemBreakdown.costs[item.itemId].quantity += 1
    itemBreakdown.costs[item.itemId].totalValue += item.unitValue
  }

  console.log('Item breakdown - Rewards:', Object.keys(itemBreakdown.rewards).length, 'unique items')
  console.log('Item breakdown - Costs:', Object.keys(itemBreakdown.costs).length, 'unique items')

  return {
    members: memberArray,
    payoutMode: mode,
    // #389 part 2 diagnostics. Present on every payout, load-bearing on none.
    occupancyCoverage: pollCoverage(crimesData?.occupancy_polls, fromTimestamp, toTimestamp),
    occupancyDrift: joinedAtDrift(crimesData?.occupancy),
    totalMoneyReward,
    totalItemReward,
    totalItemCost,
    netItemValue: totalItemReward - totalItemCost,
    grossTotal,
    factionCut,
    factionCutPercent: factionCutPercent * 100,
    memberPayoutTotal,
    participatingMembers: memberArray.length,
    payoutPerMember: memberArray.length > 0 ? Math.floor(memberPayoutTotal / memberArray.length) : 0,
    crimesProcessed,
    totalCrimes,  // Add total crimes (successful + failed)
    crimeIds,
    totalTimeSpent,
    averageTime,
    totalAdjustedTickets,
    minTimeForFullTickets: MIN_TIME_FOR_FULL_TICKETS,
    minTimeForAnyPayout: MIN_TIME_FOR_ANY_PAYOUT,
    windowStart: fromTimestamp,
    windowEnd: toTimestamp,
    // Crime statistics
    crimeStats: {
      successful: crimesByStatus.Successful,
      failed: crimesByStatus.Failed,
      planning: crimesByStatus.Planning,
      recruiting: crimesByStatus.Recruiting,
      total: totalCrimes,
      successRate,
      totalMoneyFromCrimes: totalMoneyReward,
      byDifficulty: crimesByDifficulty
    },
    // Item details for display
    rewardItemDetails,
    consumedItemDetails,
    itemBreakdown,
    // Per-crime values for theoretical recalculation after enrichment
    crimeValues
  }
}

/**
 * Create empty result object
 */
function createEmptyResult() {
  return {
    members: [],
    totalMoneyReward: 0,
    totalItemReward: 0,
    totalItemCost: 0,
    grossTotal: 0,
    factionCut: 0,
    factionCutPercent: 20,
    memberPayoutTotal: 0,
    participatingMembers: 0,
    payoutPerMember: 0,
    crimesProcessed: 0,
    crimeIds: [],
    totalTimeSpent: 0,
    averageTime: 0,
    totalAdjustedTickets: 0,
    minTimeForFullTickets: MIN_TIME_FOR_FULL_TICKETS,
    minTimeForAnyPayout: MIN_TIME_FOR_ANY_PAYOUT,
    windowStart: 0,
    windowEnd: 0,
    crimeStats: {
      successful: 0,
      failed: 0,
      planning: 0,
      recruiting: 0,
      total: 0,
      successRate: 0,
      totalMoneyFromCrimes: 0,
      byDifficulty: {}
    },
    rewardItemDetails: [],
    consumedItemDetails: [],
    crimeValues: {}
  }
}

/**
 * Format currency with full value (no abbreviation)
 * e.g., $2,020,221,000
 */
export function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '$0'
  return '$' + Math.floor(amount).toLocaleString()
}

/**
 * Format currency short (with abbreviation for display where space is limited)
 * e.g., $2.02B
 */
export function formatCurrencyShort(amount) {
  if (amount === null || amount === undefined) return '$0'

  const absAmount = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''

  if (absAmount >= 1e9) {
    return sign + '$' + (absAmount / 1e9).toFixed(2) + 'B'
  } else if (absAmount >= 1e6) {
    return sign + '$' + (absAmount / 1e6).toFixed(2) + 'M'
  } else if (absAmount >= 1e3) {
    return sign + '$' + (absAmount / 1e3).toFixed(1) + 'K'
  }
  return sign + '$' + Math.floor(absAmount).toLocaleString()
}

/**
 * Format percentage
 */
export function formatPercent(value) {
  if (value === null || value === undefined) return '0%'
  return value.toFixed(2) + '%'
}

/**
 * Format time in hours
 */
export function formatTimeHours(seconds) {
  if (!seconds) return '0h'
  const hours = seconds / 3600
  return hours.toFixed(1) + 'h'
}

/**
 * Format time in hours and minutes
 */
export function formatTimeHM(seconds) {
  if (!seconds) return '0h 0m'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}

/**
 * Downloaded/imported payout CSV filename, branded with the current
 * tenant's own faction rather than a hardcoded 'Forge' (#131 audit).
 */
export function exportPayoutFilename(fromDate, factionName) {
  const safe = (factionName || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return safe ? `${fromDate}-${safe}_OC_Payout.csv` : `${fromDate}-OC_Payout.csv`
}

/**
 * Export payouts to CSV
 */
export function exportPayoutsToCSV(members, metadata) {
  const headers = [
    'Member',
    'ID',
    'Time Spent (seconds)',
    'Time %',
    'Tier',
    'Base Tickets',
    'Sit-Out Penalty',
    'Adjusted Tickets',
    'OC Share %',
    'Crimes',
    'OC Payout',
    'Theoretical'
  ]

  const totalTime = metadata.totalTimeSpent || 1

  const rows = members.map(m => [
    m.name,
    m.userId,
    m.timeSpent,
    ((m.timeSpent / totalTime) * 100).toFixed(4) + '%',
    m.tier,
    m.baseTickets || 0,
    (m.sitOutPenalty || 0).toFixed(4),
    (m.adjustedTickets || 0).toFixed(4),
    ((m.sharePercent || 0) * 100).toFixed(6) + '%',
    m.crimesCount,
    Math.floor(m.payout),
    Math.floor(m.theoreticalPayout || 0)
  ])

  return [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
}

/**
 * Generate batch payout URL for Torn
 */
export function generateBatchPayoutURL(members) {
  const validMembers = members.filter(m => m.payout > 0)

  if (validMembers.length === 0) {
    return ''
  }

  const uids = validMembers.map(m => m.userId).join(',')
  const amounts = validMembers.map(m => Math.floor(m.payout)).join(',')

  return `https://www.torn.com/factions.php?step=your#/tab=controls&batbal_uids=${uids}&batbal_amounts=${amounts}`
}

// /**
//  * Parse payout CSV for import
//  */
// export function parsePayoutCSV(csvText) {
//   const lines = csvText.trim().split('\n')

//   if (lines.length < 2) {
//     throw new Error('CSV file is empty or invalid')
//   }

//   const headers = lines[0].split(',').map(h => h.trim().toLowerCase())

//   // Find column indexes - based on actual CSV structure
//   const memberCol = headers.findIndex(h => h.includes('member'))
//   const idCol = headers.findIndex(h => h === 'id')
//   const timeCol = headers.findIndex(h => h.includes('time spent') && !h.includes('%'))
//   const timePercentCol = headers.findIndex(h => h.includes('time') && h.includes('%'))
//   const tierCol = headers.findIndex(h => h === 'tier')
//   const ticketsCol = headers.findIndex(h => h.includes('tickets') && !h.includes('adjusted'))
//   const penaltyCol = headers.findIndex(h => h.includes('penalty'))
//   const shareCol = headers.findIndex(h => h.includes('share'))
//   const payoutCol = headers.findIndex(h => h.includes('payout') && !h.includes('theoretical'))

//   if (idCol === -1 || payoutCol === -1) {
//     throw new Error('CSV must have ID and Payout columns')
//   }

//   const members = []
//   let totalPayout = 0
//   let totalTime = 0
//   let totalTickets = 0

//   for (let i = 1; i < lines.length; i++) {
//     const line = lines[i].trim()
//     if (!line) continue

//     const values = line.split(',').map(v => v.trim())

//     const memberId = values[idCol]
//     if (!memberId || memberId === 'undefined') continue

//     const payoutStr = values[payoutCol]?.replace(/[$,"]/g, '') || '0'
//     const payout = parseInt(payoutStr) || 0

//     const timeSpent = timeCol !== -1 ? parseInt(values[timeCol]) || 0 : 0
//     const timePercent = timePercentCol !== -1 ? parseFloat(values[timePercentCol]?.replace('%', '')) || 0 : 0
//     const tier = tierCol !== -1 ? parseInt(values[tierCol]) || 6 : 6
//     const baseTickets = ticketsCol !== -1 ? parseInt(values[ticketsCol]) || 0 : 0
//     const penalty = penaltyCol !== -1 ? parseFloat(values[penaltyCol]) || 0 : 0
//     const sharePercent = shareCol !== -1 ? parseFloat(values[shareCol]?.replace('%', '')) || 0 : 0

//     members.push({
//       member_id: memberId,
//       member_name: memberCol !== -1 ? values[memberCol] : `Member ${memberId}`,
//       tier,
//       base_tickets: baseTickets,
//       sit_out_penalty: penalty,
//       adjusted_tickets: baseTickets + penalty,
//       time_spent: timeSpent,
//       time_spent_percent: timePercent,
//       share_percent: sharePercent,
//       payout,
//       theoretical_payout: 0, // Not in CSV, will be recalculated if needed
//       crimes_count: 0, // Will be filled by import function
//       crimes_participated: [] // Will be filled by import function
//     })

//     totalPayout += payout
//     totalTime += timeSpent
//     totalTickets += (baseTickets + penalty)
//   }

//   return {
//     members,
//     totalPayout,
//     totalTime,
//     totalTickets,
//     memberCount: members.length
//   }
// }

/**
 * Get crime statistics from crimes data
 * @param {Object} crimes - Crimes object with crime data
 * @returns {Object} Statistics about crimes
 */
export function getCrimeStats(crimes) {
  const stats = {
    totals: {
      count: 0,
      success: 0,
      failed: 0,
      totalMoney: 0
    },
    byDifficulty: {},
    crimesList: []
  }

  if (!crimes) return stats

  Object.values(crimes).forEach(crime => {
    const isSuccess = crime.status === 'Successful' || crime.status === 'Success'
    const isFailed = crime.status === 'Failed' || crime.status === 'Failure'
    const isPending = crime.status === 'Planning' || crime.status === 'Recruiting'

    stats.totals.count++

    // Count by status
    if (isSuccess) {
      stats.totals.success++
      stats.totals.totalMoney += crime.rewards?.money || crime.rewards_money || crime.moneyReward || 0
    } else if (isFailed) {
      stats.totals.failed++
    }

    // Count by difficulty - ONLY for executed crimes (success or failed)
    const difficulty = crime.difficulty || 1
    if (!stats.byDifficulty[difficulty]) {
      stats.byDifficulty[difficulty] = {
        total: 0,
        success: 0,
        failed: 0
      }
    }

    // Only count in difficulty stats if the crime was executed (not pending)
    if (!isPending) {
      stats.byDifficulty[difficulty].total++
      if (isSuccess) {
        stats.byDifficulty[difficulty].success++
      } else if (isFailed) {
        stats.byDifficulty[difficulty].failed++
      }
    }

    // Extract participant IDs from slots
    const participantIds = (crime.slots || [])
      .filter(slot => slot.user && slot.user.id)
      .map(slot => slot.user.id)

    // Add to crimes list for expandable view
    stats.crimesList.push({
      id: crime.crime_id,
      name: crime.name,
      difficulty: crime.difficulty,
      status: crime.status,
      moneyReward: crime.rewards?.money || crime.rewards_money || 0,
      executed_at: crime.executed_at,
      slots: crime.slots || [],
      participants: participantIds
    })
  })

  // Sort crimes list by execution time (most recent first)
  stats.crimesList.sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0))

  return stats
}

/**
 * A raw `crime_slots` row → the nested shape the crime views consume.
 *
 * Extracted (#391) because the live calculator and the saved-week history were
 * building this independently, and the saved-week side simply wasn't — it
 * hardcoded an empty array, so Crime Statistics reported "0 participants" for
 * every archived week. One shared shaper means the two cannot diverge again.
 *
 * `memberNames` maps member_id → current display name; absent for saved weeks,
 * where the name stored on the slot is what we have.
 */
export function toSlotShape(slot, memberNames = {}) {
  return {
    position: slot.position,
    position_id: slot.position_id,
    position_number: slot.position_number,
    checkpoint_pass_rate: parseFloat(slot.checkpoint_pass_rate) || 0,
    user: slot.user_id ? {
      id: parseInt(slot.user_id),
      name: memberNames[slot.user_id] || slot.user_name || `User ${slot.user_id}`,
      joined_at: slot.joined_at,
      outcome: slot.user_outcome,
      progress: slot.user_progress,
      item_outcome: slot.item_outcome_id
        ? { item_id: slot.item_outcome_id, outcome: slot.item_outcome_outcome }
        : null,
    } : null,
    item_requirement: slot.item_requirement_id ? {
      id: slot.item_requirement_id,
      name: slot.item_requirement_name,
      is_reusable: slot.item_requirement_is_reusable,
      is_available: slot.item_requirement_is_available,
    } : null,
  }
}

/** Group flat slot rows by crime_id. */
export function groupSlotsByCrime(slots, memberNames = {}) {
  const byCrime = new Map()
  for (const slot of slots || []) {
    const id = slot?.crime_id
    if (id == null) continue
    if (!byCrime.has(id)) byCrime.set(id, [])
    byCrime.get(id).push(toSlotShape(slot, memberNames))
  }
  return byCrime
}

/**
 * Shape the rows from GET /api/payouts/weeks/:id/crimes into the crime map
 * getCrimeStats() consumes (keyed by crime_id; rewards_money nested under
 * rewards.money). Shared by Payout Management and the Payouts history view so
 * the Crime Statistics breakdown is built identically in both.
 *
 * #391: `slots` used to be hardcoded empty here, because the endpoint didn't
 * return any — so every saved week reported "0 participants" and the expand
 * showed "no data". The endpoint now sends them; pass them in.
 */
export function weekCrimeRowsToMap(rows, slots = [], memberNames = {}) {
  const slotsByCrime = groupSlotsByCrime(slots, memberNames)
  const map = {}
  for (const c of rows || []) {
    map[c.crime_id] = {
      crime_id: c.crime_id,
      name: c.name,
      difficulty: c.difficulty,
      status: c.status,
      executed_at: c.executed_at,
      rewards: { money: c.rewards_money || 0 },
      // Still defaults to empty when the caller passes nothing, so an older
      // caller degrades to the previous behaviour rather than throwing.
      slots: slotsByCrime.get(c.crime_id) || [],
    }
  }
  return map
}

/**
 * The crimesData shape for a reopened saved week (#389 fix).
 *
 * The endpoint that fetches a saved week's linked crimes returns
 * `{ crimes, slots }` only — no occupancy data — because that is a separate
 * endpoint (`/api/payouts/crime-data`, keyed by the week's date window, not
 * by crime id). Building crimesData from the crimes response alone silently
 * wiped occupancy/occupancy_polls every time a saved week was reopened:
 * OccupancyPanel read `crimesData.occupancy_polls === undefined`, which
 * reads exactly like a genuinely unwatched window (pollCount 0) rather than
 * a missing field. `occupancyForWeek` is the earlier crime-data fetch's
 * result, carried in by the caller.
 */
export function buildHistoricalWeekCrimesData(rows, slots, occupancyForWeek = {}) {
  return {
    crimes: weekCrimeRowsToMap(rows, slots),
    occupancy: occupancyForWeek.occupancy || [],
    occupancy_polls: occupancyForWeek.occupancy_polls || [],
  }
}

/**
 * Parse a single CSV line respecting quoted fields.
 * Handles values like "$15,170,274" where commas appear inside quotes.
 */
function parseCSVLine(line) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  values.push(current.trim())
  return values
}

/**
 * Find a column index using flexible matching against multiple possible header names.
 * Returns -1 if no match found.
 */
function findColumn(headers, ...patterns) {
  for (const pattern of patterns) {
    const idx = headers.findIndex(h => {
      if (typeof pattern === 'function') return pattern(h)
      return h === pattern || h.includes(pattern)
    })
    if (idx !== -1) return idx
  }
  return -1
}

/**
 * Clean a numeric string by removing currency symbols, commas, quotes, and percent signs.
 */
function cleanNumeric(val) {
  if (val === null || val === undefined || val === '') return 0
  const cleaned = String(val).replace(/[$,"%]/g, '').trim()
  return cleaned
}

/**
 * Parse payout CSV for import.
 * Handles both system-exported CSVs and Google Sheets-exported CSVs.
 * Properly parses quoted fields with embedded commas.
 * Includes all members (even those with 0 payout).
 */
export function parsePayoutCSV(csvText, weekStart, weekEnd) {
  const lines = csvText.trim().split('\n')

  if (lines.length < 2) {
    throw new Error('CSV file is empty or invalid')
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase())

  // Flexible column detection supporting both system-export and Google Sheets formats
  const memberCol = findColumn(headers, 'member', 'name')
  const idCol = findColumn(headers, h => h === 'id', 'member id', 'user_id')
  const timeCol = findColumn(headers,
    h => h.includes('time spent') && !h.includes('%'),
    h => h.includes('time') && h.includes('oc') && !h.includes('%'),
    'time_in_crimes'
  )
  const timePercentCol = findColumn(headers,
    h => h.includes('time') && h.includes('%'),
    'time spent %', 'time_pct'
  )
  const tierCol = findColumn(headers, h => h === 'tier')
  const ticketsCol = findColumn(headers, 'base tickets', h => h === 'tickets')
  const adjustedTicketsCol = findColumn(headers, 'adjusted tickets', 'adj tickets')
  const penaltyCol = findColumn(headers, 'penalty', 'sit-out', 'sitout', 'sit_out')
  const shareCol = findColumn(headers, 'share', 'oc share')
  const payoutCol = findColumn(headers, 'oc payout', 'payout')
  const theoreticalCol = findColumn(headers, 'theoretical')
  const crimesCol = findColumn(headers, h => h === 'crimes', 'crime_count', 'crimes_count')

  if (idCol === -1) {
    throw new Error('CSV must have an ID column')
  }
  if (payoutCol === -1) {
    throw new Error('CSV must have a Payout column (e.g., "OC Payout")')
  }

  const members = []
  let totalPayout = 0
  let totalTime = 0
  let totalTickets = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const values = parseCSVLine(line)

    const memberId = values[idCol]?.replace(/['"]/g, '').trim()
    if (!memberId || memberId === 'undefined' || memberId === '') continue

    const payout = parseInt(cleanNumeric(values[payoutCol])) || 0
    const timeSpent = timeCol !== -1 ? parseInt(cleanNumeric(values[timeCol])) || 0 : 0
    const timePercent = timePercentCol !== -1 ? parseFloat(cleanNumeric(values[timePercentCol])) || 0 : 0
    // Preserve tier 0 (Review) when present in CSV — only fall back to 6 if
    // the cell is missing or non-numeric (NaN), not when it parses to 0.
    const parsedTier = tierCol !== -1 ? parseInt(cleanNumeric(values[tierCol])) : NaN
    const tier = Number.isFinite(parsedTier) ? parsedTier : 6
    const baseTickets = ticketsCol !== -1 ? parseFloat(cleanNumeric(values[ticketsCol])) || 0 : 0
    const penalty = penaltyCol !== -1 ? parseFloat(cleanNumeric(values[penaltyCol])) || 0 : 0
    const adjustedTickets = adjustedTicketsCol !== -1
      ? parseFloat(cleanNumeric(values[adjustedTicketsCol])) || 0
      : Math.max(0, baseTickets + penalty)
    const sharePercent = shareCol !== -1 ? parseFloat(cleanNumeric(values[shareCol])) || 0 : 0
    const theoretical = theoreticalCol !== -1 ? parseInt(cleanNumeric(values[theoreticalCol])) || 0 : 0
    const crimesCount = crimesCol !== -1 ? parseInt(cleanNumeric(values[crimesCol])) || 0 : 0

    // Extract clean member name (strip bracketed ID if present, e.g., "Pierce [2163818]")
    let memberName = memberCol !== -1 ? values[memberCol]?.trim() : `Member ${memberId}`
    memberName = memberName.replace(/\s*\[\d+\]\s*$/, '')

    members.push({
      member_id: memberId,
      member_name: memberName,
      tier,
      base_tickets: baseTickets,
      sit_out_penalty: penalty,
      adjusted_tickets: adjustedTickets,
      time_spent: timeSpent,
      time_spent_percent: timePercent,
      share_percent: sharePercent,
      payout,
      theoretical_payout: theoretical,
      crimes_count: crimesCount,
      week_start: weekStart,
      week_end: weekEnd
    })

    totalPayout += payout
    totalTime += timeSpent
    totalTickets += adjustedTickets
  }

  return {
    members,
    totalPayout,
    totalTime,
    totalTickets,
    memberCount: members.length
  }
}

/**
 * Parse an XLSX file's Payout_Calculator sheet for import.
 * Also extracts item_outcomes data if present.
 *
 * @param {Array<Array>} payoutRows - 2D array of the Payout_Calculator sheet (with headers in row 0)
 * @param {Array<Array>|null} itemRows - 2D array of the item_outcomes sheet (optional)
 * @param {string} weekStart - Week start date string (YYYY-MM-DD)
 * @param {string} weekEnd - Week end date string (YYYY-MM-DD)
 * @returns {Object} Parsed payout data
 */
export function parsePayoutXLSX(payoutRows, itemRows, weekStart, weekEnd) {
  if (!payoutRows || payoutRows.length < 2) {
    throw new Error('Payout_Calculator sheet is empty or invalid')
  }

  const headers = payoutRows[0].map(h => (h || '').toString().trim().toLowerCase())

  const memberCol = findColumn(headers, 'member', 'name')
  const idCol = findColumn(headers, h => h === 'id', 'member id', 'user_id')
  const timeCol = findColumn(headers,
    h => h.includes('time spent') && !h.includes('%'),
    h => h.includes('time') && h.includes('oc') && !h.includes('%')
  )
  const timePercentCol = findColumn(headers, h => h.includes('time') && h.includes('%'))
  const tierCol = findColumn(headers, h => h === 'tier')
  const ticketsCol = findColumn(headers, 'base tickets', h => h === 'tickets')
  const penaltyCol = findColumn(headers, 'penalty', 'sit-out', 'sitout')
  const shareCol = findColumn(headers, 'share', 'oc share')
  const payoutCol = findColumn(headers, 'oc payout', 'payout')

  if (idCol === -1) {
    throw new Error('Payout_Calculator sheet must have an ID column')
  }
  if (payoutCol === -1) {
    throw new Error('Payout_Calculator sheet must have a Payout column')
  }

  const members = []
  let totalPayout = 0
  let totalTime = 0
  let totalTickets = 0

  for (let i = 1; i < payoutRows.length; i++) {
    const row = payoutRows[i]
    if (!row) continue

    const rawId = row[idCol]
    if (rawId === null || rawId === undefined || rawId === '') continue

    const memberId = String(Math.floor(Number(rawId)))
    if (!memberId || memberId === 'NaN' || memberId === '0') continue

    const payout = Math.floor(Number(row[payoutCol]) || 0)
    const timeSpent = Math.floor(Number(row[timeCol]) || 0)
    // Preserve tier 0 (Review) when present in XLSX — only fall back to 6
    // if the cell is empty/non-numeric.
    const parsedTierRaw = Number(row[tierCol])
    const tier = Number.isFinite(parsedTierRaw) ? Math.floor(parsedTierRaw) : 6
    const baseTickets = Number(row[ticketsCol]) || 0
    const penalty = Number(row[penaltyCol]) || 0
    const adjustedTickets = Math.max(0, baseTickets + penalty)

    // Share percent: XLSX stores as decimal (e.g., 0.02134), convert to percentage
    let sharePercent = Number(row[shareCol]) || 0
    if (sharePercent > 0 && sharePercent < 1) {
      sharePercent = sharePercent * 100
    }

    let timePercent = Number(row[timePercentCol]) || 0
    if (timePercent > 0 && timePercent < 1) {
      timePercent = timePercent * 100
    }

    let memberName = memberCol !== -1 ? String(row[memberCol] || '').trim() : `Member ${memberId}`
    memberName = memberName.replace(/\s*\[\d+\]\s*$/, '')

    members.push({
      member_id: memberId,
      member_name: memberName,
      tier,
      base_tickets: baseTickets,
      sit_out_penalty: penalty,
      adjusted_tickets: adjustedTickets,
      time_spent: timeSpent,
      time_spent_percent: timePercent,
      share_percent: sharePercent,
      payout,
      theoretical_payout: 0,
      crimes_count: 0,
      week_start: weekStart,
      week_end: weekEnd
    })

    totalPayout += payout
    totalTime += timeSpent
    totalTickets += adjustedTickets
  }

  // Parse item outcomes if available
  let itemOutcomes = null
  if (itemRows && itemRows.length > 1) {
    itemOutcomes = {
      items: [],
      netTotal: 0,
      rewardsTotal: 0,
      usedTotal: 0
    }

    const itemHeaders = itemRows[0].map(h => (h || '').toString().trim().toLowerCase())
    const itemIdCol = findColumn(itemHeaders, h => h === 'id')
    const itemNameCol = findColumn(itemHeaders, 'name')
    const itemStatusCol = findColumn(itemHeaders, 'status')
    const itemValueCol = findColumn(itemHeaders, 'market value', 'value')
    const itemQtyCol = findColumn(itemHeaders, 'quantity', 'qty')
    const itemTotalCol = findColumn(itemHeaders, 'total price', 'total')

    for (let i = 1; i < itemRows.length; i++) {
      const row = itemRows[i]
      if (!row || !row[itemIdCol]) continue

      const id = Number(row[itemIdCol])
      if (isNaN(id) || id === 0) continue

      const status = String(row[itemStatusCol] || '').trim().toLowerCase()
      const marketValue = Number(row[itemValueCol]) || 0
      const quantity = Number(row[itemQtyCol]) || 0
      const totalPrice = itemTotalCol !== -1 ? Number(row[itemTotalCol]) || 0 : 0

      itemOutcomes.items.push({
        id,
        name: String(row[itemNameCol] || ''),
        status,
        marketValue,
        quantity,
        totalPrice
      })

      if (status === 'reward') {
        itemOutcomes.rewardsTotal += Math.abs(totalPrice)
      } else if (status === 'used') {
        itemOutcomes.usedTotal += Math.abs(totalPrice)
      }
    }
    itemOutcomes.netTotal = itemOutcomes.rewardsTotal - itemOutcomes.usedTotal
  }

  return {
    members,
    totalPayout,
    totalTime,
    totalTickets,
    memberCount: members.length,
    itemOutcomes
  }
}

