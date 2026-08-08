import { describe, it, expect } from 'vitest'
import { ROWS } from '../ApiKeyDisclosure'

// The disclosure is the one place members read exactly how their key is
// used/stored before consenting — it must describe THIS stack (self-hosted,
// AES-256-GCM, per-faction Postgres), not the legacy Supabase system.
// Regression guard: the legacy wording silently described the wrong system
// for a long time after the migration, undetected because nothing pinned it.

function rowText(label) {
  return ROWS.find(([l]) => l === label)?.[1] ?? ''
}

describe('ApiKeyDisclosure content', () => {
  it('never mentions the legacy storage mechanism (Supabase / pgp_sym_encrypt)', () => {
    const allText = ROWS.map(([, v]) => v).join(' ')
    expect(allText).not.toMatch(/supabase/i)
    expect(allText).not.toMatch(/pgp_sym_encrypt/i)
  })

  it('Storage row describes AES-256-GCM at rest in the faction\'s own database', () => {
    const storage = rowText('Storage')
    expect(storage).toMatch(/AES-256-GCM/)
    expect(storage).toMatch(/faction/i)
  })

  it('does not claim the scrapers run "nightly" (cadence is mixed, minutes to daily)', () => {
    expect(rowText('Purpose')).not.toMatch(/nightly/i)
  })

  it('Torn API Calls row covers the faction-wide endpoints actually used (attacks, revives, rankedwars)', () => {
    const calls = rowText('Torn API Calls')
    expect(calls).toMatch(/attacks/)
    expect(calls).toMatch(/revives/)
    expect(calls).toMatch(/rankedwars/)
  })

  it('names the bars + cooldowns selections now read from every member (#336)', () => {
    // Adding a selection to the sweep without adding it here would leave the
    // consent screen quietly understating what we collect.
    const calls = rowText('Torn API Calls')
    expect(calls).toMatch(/bars/)
    expect(calls).toMatch(/cooldowns/)
  })

  it('discloses live energy and drug cooldowns in plain language, not just as an endpoint', () => {
    // A member reading "GET /v2/user (…, bars, cooldowns)" cannot reasonably
    // work out that it means their energy and overdose state, so the plain
    // description is the actual disclosure.
    const live = rowText('Live War Stats')
    expect(live).toMatch(/energy/i)
    expect(live).toMatch(/cooldown/i)
    expect(live).toMatch(/overdose/i)
  })

  it('states the limits that make the collection acceptable', () => {
    // Each of these is a real constraint the implementation enforces; if one
    // stops being true the disclosure has to change with it.
    const live = rowText('Live War Stats')
    expect(live).toMatch(/30 seconds/)       // the cadence floor
    expect(live).toMatch(/war room is off/i) // never swept outside a war
    expect(live).toMatch(/discarded|never stored/i) // nerve/happy/life dropped
  })

  it('says the live stats are lead-only rather than faction-wide', () => {
    // The Sharing row otherwise reads "visible to your faction", which would
    // be wrong for this data — the hub withholds it from ordinary members.
    expect(rowText('Sharing')).toMatch(/war leads/i)
  })
})
