// #773/#774 — reading the end of the chain back out of the samples.
import { describe, expect, it } from 'vitest'
import { chainOutcome } from '../src/chain/chainOutcome.js'
import { CHAIN_TARGET } from '../src/chain/chainProjection.js'

const T = Date.parse('2027-11-03T00:00:00Z')
const m = (n: number) => T + n * 60_000
const s = (at: number, chain: number | null, cooldown: number | null = null) => ({ at, chain, cooldown })

describe('chainOutcome', () => {
  it('⚠️ reads the end back hours later, from the first sample in cooldown', () => {
    // The whole reason for an append-only series: the War Room's singleton
    // would have overwritten this long before the payout was reconciled.
    const out = chainOutcome([
      s(m(0), 99_000), s(m(4), 99_600), s(m(8), CHAIN_TARGET),
      s(m(12), CHAIN_TARGET, 1_800), s(m(16), CHAIN_TARGET, 1_560),
    ])
    expect(out.state).toBe('ended')
    expect(out.endedAt).toBe(m(12))
  })

  it('⚠️ calls it dropped by the PEAK, not by which sample caught the timer', () => {
    const banked = chainOutcome([s(m(0), CHAIN_TARGET), s(m(4), CHAIN_TARGET, 1_800)])
    const dropped = chainOutcome([s(m(0), 61_204), s(m(4), 61_204, 1_800)])
    expect(banked.dropped).toBe(false)
    expect(dropped.dropped).toBe(true)
    // The distinction decides whether the raffle runs at all, so it has to come
    // from the chain's actual size.
    expect(dropped.state === 'ended' && dropped.peak).toBe(61_204)
  })

  it('says a live chain is running rather than guessing an end', () => {
    const out = chainOutcome([s(m(0), 4_000), s(m(4), 4_300)])
    expect(out.state).toBe('running')
    expect(out.endedAt).toBeNull()
    expect(out.peak).toBe(4_300)
  })

  it('⚠️ says "unknown" when nothing was sampled, never "ended"', () => {
    // No samples means the job was not running — which must not read as a
    // chain that finished at the start of time and pays nobody.
    const out = chainOutcome([])
    expect(out.state).toBe('unknown')
    expect(out.endedAt).toBeNull()
    expect(out.dropped).toBe(false)
  })

  it('takes the peak from the whole series, not from the final reading', () => {
    // Torn reports 0 once a chain closes. Reading the last sample as the peak
    // would call every completed chain a drop.
    const out = chainOutcome([s(m(0), 99_000), s(m(4), CHAIN_TARGET), s(m(8), 0, 1_800)])
    expect(out.state === 'ended' && out.peak).toBe(CHAIN_TARGET)
    expect(out.dropped).toBe(false)
  })

  it('is not confused by samples arriving out of order', () => {
    const out = chainOutcome([s(m(8), 500, 1_800), s(m(0), 400), s(m(4), 450)])
    expect(out.endedAt).toBe(m(8))
  })
})
