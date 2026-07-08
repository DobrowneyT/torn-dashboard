/**
 * Test Utilities for Payout Calculations
 * Use this to verify calculations match Google Sheets results
 */

import {
  getCurrentWeekRange,
  calculatePayouts,
  formatCurrency,
  formatTimeSpent
} from './payoutCalculations'

/**
 * Create sample test data matching your CSV structure
 */
export function createSampleData() {
  // Sample CPR database
  const cprData = {
    members: {
      "2250591": {
        name: "MonChoon",
        tier: 1,
        last_scraped: "2025-12-28 14:43:28",
        cpr_by_role: {
          "8": { "Imitator": 72, "Muscle": 68 },
          "7": { "Muscle": 86, "Bomber": 82 }
        }
      },
      "428286": {
        name: "AlleyCat",
        tier: 1,
        last_scraped: "2025-12-28 14:43:28",
        cpr_by_role: {
          "8": { "Cat Burglar": 80, "Assassin": 75 }
        }
      },
      "50716": {
        name: "Honey-Badger",
        tier: 1,
        last_scraped: "2025-12-28 14:43:28",
        cpr_by_role: {
          "8": { "Assassin": 75, "Robber": 69 }
        }
      }
    }
  }

  // Sample crimes database
  const crimesData = {
    crimes: {
      "778107": {
        id: 778107,
        name: "Pet Project",
        difficulty: 1,
        status: "Successful",
        created_at: 1735500000,
        executed_at: 1735590285,
        participant_ids: [2250591, 428286, 50716],
        rewards: {
          money: 767000,
          respect: 36
        }
      },
      "778108": {
        id: 778108,
        name: "Heist",
        difficulty: 8,
        status: "Successful",
        created_at: 1735500000,
        executed_at: 1735595000,
        participant_ids: [2250591, 428286],
        rewards: {
          money: 37751669,
          respect: 156
        }
      },
      "778109": {
        id: 778109,
        name: "Failed Job",
        difficulty: 5,
        status: "Failed",
        created_at: 1735500000,
        executed_at: 1735596000,
        participant_ids: [50716],
        rewards: {
          money: 0,
          respect: 0
        }
      }
    }
  }

  return { cprData, crimesData }
}

/**
 * Run a test calculation and display results
 */
export function runTestCalculation() {
  const { cprData, crimesData } = createSampleData()
  const timeWindow = getCurrentWeekRange()
  
  // Use fake config for testing
  const testConfig = {
    payoutTickets: {
      1: 40, 2: 30, 3: 15, 4: 7, 5: 3, 6: 2
    }
  }

  const results = calculatePayouts(
    crimesData,
    cprData,
    timeWindow.mondayTimestamp,
    timeWindow.sundayTimestamp,
    testConfig
  )

  return results
}

/**
 * Display test results in console
 */
export function displayTestResults(results) {
  console.group('🧪 Payout Calculation Test Results')
  
  console.log('📅 Time Window:')
  console.log(`  From: ${new Date(results.windowStart * 1000).toLocaleString()}`)
  console.log(`  To: ${new Date(results.windowEnd * 1000).toLocaleString()}`)
  console.log(`  Duration: ${results.windowDays} days`)
  console.log('')
  
  console.log('📊 Summary:')
  console.log(`  Total Payout: ${formatCurrency(results.totalPayout)}`)
  console.log(`  Total Members: ${results.members.length}`)
  console.log(`  Crimes Processed: ${results.crimesProcessed}`)
  console.log(`  Avg Payout: ${formatCurrency(results.totalPayout / results.members.length)}`)
  console.log('')
  
  console.log('👥 Member Breakdown:')
  results.members.forEach((member, index) => {
    console.log(`  ${index + 1}. ${member.name} (ID: ${member.userId})`)
    console.log(`     Tier: ${member.tier} | Tickets: ${member.tickets}`)
    console.log(`     Crimes: ${member.crimesCount} | Time: ${formatTimeSpent(member.timeSpent)}`)
    console.log(`     Payout: ${formatCurrency(member.payout)}`)
    
    if (member.crimeDetails && member.crimeDetails.length > 0) {
      console.log('     Crime Details:')
      member.crimeDetails.forEach(crime => {
        console.log(`       - ${crime.crimeName} (L${crime.difficulty}): ${formatCurrency(crime.reward)}`)
      })
    }
    console.log('')
  })
  
  console.groupEnd()
  
  return results
}

/**
 * Compare calculation with expected values
 * @param {Object} results - Calculation results
 * @param {Object} expected - Expected values from Google Sheets
 */
export function compareWithExpected(results, expected) {
  console.group('🔍 Comparison with Expected Results')
  
  const checks = {
    totalPayout: results.totalPayout === expected.totalPayout,
    memberCount: results.members.length === expected.memberCount,
    crimesProcessed: results.crimesProcessed === expected.crimesProcessed
  }
  
  console.log('Total Payout:')
  console.log(`  Calculated: ${formatCurrency(results.totalPayout)}`)
  console.log(`  Expected: ${formatCurrency(expected.totalPayout)}`)
  console.log(`  Match: ${checks.totalPayout ? '✅' : '❌'}`)
  console.log('')
  
  console.log('Member Count:')
  console.log(`  Calculated: ${results.members.length}`)
  console.log(`  Expected: ${expected.memberCount}`)
  console.log(`  Match: ${checks.memberCount ? '✅' : '❌'}`)
  console.log('')
  
  console.log('Crimes Processed:')
  console.log(`  Calculated: ${results.crimesProcessed}`)
  console.log(`  Expected: ${expected.crimesProcessed}`)
  console.log(`  Match: ${checks.crimesProcessed ? '✅' : '❌'}`)
  console.log('')
  
  // Check individual member payouts
  if (expected.members) {
    console.log('Member Payout Comparison:')
    expected.members.forEach(expectedMember => {
      const calculatedMember = results.members.find(m => m.userId === expectedMember.userId)
      
      if (calculatedMember) {
        const payoutMatch = calculatedMember.payout === expectedMember.payout
        console.log(`  ${expectedMember.name}:`)
        console.log(`    Calculated: ${formatCurrency(calculatedMember.payout)}`)
        console.log(`    Expected: ${formatCurrency(expectedMember.payout)}`)
        console.log(`    Match: ${payoutMatch ? '✅' : '❌'}`)
      } else {
        console.log(`  ${expectedMember.name}: ❌ NOT FOUND IN RESULTS`)
      }
    })
  }
  
  const allChecks = Object.values(checks).every(check => check === true)
  console.log('')
  console.log(`Overall: ${allChecks ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`)
  
  console.groupEnd()
  
  return allChecks
}

/**
 * Load expected results from your Google Sheets CSV
 * Use this to compare with actual results
 */
export function loadExpectedFromCSV(csvData) {
  // Parse CSV data from Payout_Calculator sheet
  const lines = csvData.trim().split('\n')
  const headers = lines[0].split(',')
  
  const members = []
  let totalPayout = 0
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',')
    
    if (values.length < 9) continue
    
    const name = values[0]
    const userId = parseInt(values[1])
    const tier = parseInt(values[4])
    const tickets = parseInt(values[5])
    const payoutStr = values[8].replace(/[$,"]/g, '')
    const payout = parseInt(payoutStr)
    
    if (isNaN(payout) || payout === 0) continue
    
    members.push({ name, userId, tier, tickets, payout })
    totalPayout += payout
  }
  
  return {
    totalPayout,
    memberCount: members.length,
    members
  }
}

/**
 * Quick test function - run this in browser console
 */
export function quickTest() {
  console.clear()
  console.log('🚀 Running Quick Payout Calculation Test...\n')
  
  const results = runTestCalculation()
  displayTestResults(results)
  
  return results
}

/**
 * Validate data structure
 */
export function validateDataStructure(crimesData, cprData) {
  const issues = []
  
  // Check crimes data
  if (!crimesData || !crimesData.crimes) {
    issues.push('❌ crimes_database.json missing or invalid structure')
  } else {
    const crimeCount = Object.keys(crimesData.crimes).length
    console.log(`✅ Found ${crimeCount} crimes in database`)
    
    // Check sample crime structure
    const sampleCrime = Object.values(crimesData.crimes)[0]
    if (sampleCrime) {
      if (!sampleCrime.executed_at) issues.push('⚠️ Some crimes missing executed_at timestamp')
      if (!sampleCrime.status) issues.push('⚠️ Some crimes missing status field')
      if (!sampleCrime.rewards) issues.push('⚠️ Some crimes missing rewards field')
      if (!sampleCrime.participant_ids) issues.push('⚠️ Some crimes missing participant_ids')
    }
  }
  
  // Check CPR data
  if (!cprData || !cprData.members) {
    issues.push('❌ cpr_database.json missing or invalid structure')
  } else {
    const memberCount = Object.keys(cprData.members).length
    console.log(`✅ Found ${memberCount} members in CPR database`)
    
    // Check sample member structure
    const sampleMember = Object.values(cprData.members)[0]
    if (sampleMember) {
      if (!sampleMember.name) issues.push('⚠️ Some members missing name field')
      if (!sampleMember.tier) issues.push('⚠️ Some members missing tier assignment')
    }
  }
  
  if (issues.length > 0) {
    console.group('⚠️ Data Validation Issues')
    issues.forEach(issue => console.log(issue))
    console.groupEnd()
    return false
  }
  
  console.log('✅ Data structure validation passed')
  return true
}

// For browser console testing
if (typeof window !== 'undefined') {
  window.payoutTest = {
    run: quickTest,
    display: displayTestResults,
    compare: compareWithExpected,
    validate: validateDataStructure,
    createSample: createSampleData
  }
  
  console.log('💡 Payout test utilities loaded! Use window.payoutTest in console')
}