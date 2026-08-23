// @vitest-environment jsdom
//
// Rendering-level proof for the Farm mode Abroad section (#561): the mobile
// War Room is a self-contained presentational component (props in, no
// internal fetching), so it can be mounted directly — unlike the desktop
// view, which owns its own auth/websocket data layer and has no rendering
// test precedent in this repo (see WarRoomViewV2's own farm-split coverage:
// the pure `splitFarmAbroad`/`isAbroadTarget` tests in
// warRoomFarmSort.test.js, which both war rooms share).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ViewStateProvider } from '../../contexts/ViewStateContext'
import { markTourSeen } from '../../utils/warRoomTour'
import MobileWarRoomView from '../MobileWarRoomView'

const NOW = Math.floor(Date.now() / 1000)

// Four members spanning the split: a green (main), a domestic hospital
// (main, has a timer), a plain traveller (abroad), and — the case MonChoon
// called out explicitly — a member hospitalized ABROAD (abroad, even though
// `state` is 'Hospital' and it has a release timer just like the domestic one).
const GREEN         = { id: 1, name: 'GreenMember',      level: 10, activity: 'Online',  lastActionTs: NOW, state: 'Okay',      description: 'Okay',                     until: null,       bsp: 1000 }
const DOMESTIC_HOSP = { id: 2, name: 'DomesticHospMember', level: 20, activity: 'Offline', lastActionTs: NOW, state: 'Hospital',  description: 'Hospitalized',             until: NOW + 100,  bsp: 2000 }
const TRAVELER      = { id: 3, name: 'TravelerMember',   level: 15, activity: 'Offline', lastActionTs: NOW, state: 'Traveling', description: 'Traveling from Torn to Mexico', until: NOW + 5000, bsp: 3000 }
const HOSP_ABROAD   = { id: 4, name: 'HospAbroadMember', level: 25, activity: 'Offline', lastActionTs: NOW, state: 'Hospital',  description: 'In a Canadian hospital',   until: NOW + 50,   bsp: 4000 }

const MEMBERS = [DOMESTIC_HOSP, GREEN, HOSP_ABROAD, TRAVELER]

function seedViewState(state) {
  localStorage.setItem(
    'torn-dashboard-view-states',
    JSON.stringify({ warroom_mobile: state })
  )
}

function renderMobile() {
  return render(
    <ViewStateProvider>
      <MobileWarRoomView
        members={MEMBERS}
        currentUserId="999"
        factionId="123"
        factionName="Enemy Faction"
        onClose={() => {}}
      />
    </ViewStateProvider>
  )
}

describe('MobileWarRoomView — Farm mode Abroad section (#561)', () => {
  beforeEach(() => {
    localStorage.clear()
    markTourSeen('mobile') // keep the first-run spotlight tour out of the way
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('splits abroad targets — including hospitalized-abroad — into their own section after the main list, when Farm mode is active', () => {
    seedViewState({ statusFilter: [], sortBy: 'farm', sortDir: 'asc' })
    renderMobile()

    const divider = screen.getByText(/Abroad — still needs travel time home/i)
    const green = screen.getByRole('link', { name: 'GreenMember' })
    const domesticHosp = screen.getByRole('link', { name: 'DomesticHospMember' })
    const traveler = screen.getByRole('link', { name: 'TravelerMember' })
    const hospAbroad = screen.getByRole('link', { name: 'HospAbroadMember' })

    // Main section (green + domestic hospital) renders BEFORE the divider.
    expect(divider.compareDocumentPosition(green) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(divider.compareDocumentPosition(domesticHosp) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()

    // Abroad section (traveller + hospitalized-abroad) renders AFTER it.
    expect(divider.compareDocumentPosition(traveler) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(divider.compareDocumentPosition(hospAbroad) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is a no-op when Farm mode is off — no divider, and the timer-sorted list is unchanged', () => {
    seedViewState({ statusFilter: [], sortBy: 'timer', sortDir: 'asc' })
    renderMobile()

    expect(screen.queryByText(/Abroad — still needs travel time home/i)).toBeNull()
    // Every member still renders — the split only changes ordering/grouping
    // in farm mode, it never hides anyone outside it.
    for (const m of MEMBERS) {
      expect(screen.getByRole('link', { name: m.name })).toBeTruthy()
    }
  })
})
