// #756 — the schedule model behind the Scraper Jobs editor.
//
// ⚠️ The whole point of this module is that a schedule survives a trip through
// a UI. An editor that quietly rewrites a cadence is worse than the text box it
// replaces: the text box at least fails loudly. So the load-bearing test here is
// the round trip over the REAL shipped schedules, not the unit cases.
import { describe, expect, it } from 'vitest'
import {
  parseCron, buildCron, describeCron, nextRuns, minuteLoad,
} from '../cronSentence'

// Straight from server/src/scraper/registerJobs.ts. If a job's cadence changes
// there and this list is not updated, the round-trip test below is the thing
// that should start failing.
const SHIPPED = {
  'items-sync':           '0 15 */6 * * *',
  'inventory-sync':       '0 0 * * * *',
  'crimes-sync':          '0 */30 * * * *',
  'crime-occupancy':      '30 * * * * *',
  'cpr-scan':             '0 30 5,17 * * *',
  'members-sync':         '0 5 * * * *',
  'member-stats':         '0 5 1 * * *',
  'member-profile':       '0 20 1 * * *',
  'member-battle-stats':  '0 45 2 * * *',
  'stats-samples-prune':  '0 40 1 * * *',
  'scraper-runs-prune':   '0 50 1 * * *',
  'wars-sync':            '0 10 */3 * * *',
  'attacks-sync':         '0 20,50 * * * *',
  'revives-sync':         '0 5,35 * * * *',
  'factions-sync':        '0 40 * * * *',
  'war-lifecycle':        '0 */3 * * * *',
  'competitions-resolve': '0 */15 * * * *',
  'faction-upgrades':     '0 10 2 * * *',
  'member-event-windows': '0 35 4 * * *',
}

describe('parseCron / buildCron round trip', () => {
  it('⚠️ returns every shipped schedule unchanged', () => {
    // The editor is not allowed to "tidy" a cadence on open. A job that opens
    // and closes untouched must write back the bytes it started with.
    for (const [job, expr] of Object.entries(SHIPPED)) {
      const state = parseCron(expr)
      expect(state, `${job} did not parse`).not.toBeNull()
      expect(buildCron(state), `${job} did not round-trip`).toBe(expr)
    }
  })

  it('⚠️ keeps crime-occupancy on the :30 second mark', () => {
    // The offset is the #389 decision this whole editor exists to preserve —
    // an off-the-shelf five-field widget would silently drop it onto :00.
    const s = parseCron('30 * * * * *')
    expect(s.period).toBe('minute')
    expect(s.secs).toEqual([30])
    expect(buildCron(s)).toBe('30 * * * * *')
  })

  it('reads a five-field expression as seconds-zero', () => {
    // ⚠️ node-cron accepts five fields, so the column may already hold one.
    // Treating it as "unparseable" would strand a working job in a text box.
    const s = parseCron('*/15 * * * *')
    expect(s.period).toBe('nminutes')
    expect(s.n).toBe(15)
    expect(s.secs).toEqual([0])
    expect(buildCron(s)).toBe('0 */15 * * * *')
  })

  it('always writes six fields, whatever it was handed', () => {
    for (const expr of ['*/5 * * * *', '0 */5 * * * *']) {
      expect(buildCron(parseCron(expr)).split(' ')).toHaveLength(6)
    }
  })
})

describe('parseCron — what it refuses', () => {
  // ⚠️ Refusing is a feature. A sentence that cannot say "the 1st of the month"
  // must not round a schedule off to something it CAN say; the caller falls
  // back to a raw text box instead.
  it('refuses a day-of-month constraint rather than dropping it', () => {
    expect(parseCron('0 0 3 1 * *')).toBeNull()
  })

  it('refuses a month constraint', () => {
    expect(parseCron('0 0 3 * 6 *')).toBeNull()
  })

  it('refuses a range it cannot render as chips', () => {
    expect(parseCron('0 0 9-17 * * *')).toBeNull()
  })

  it('refuses malformed input instead of guessing', () => {
    expect(parseCron('')).toBeNull()
    expect(parseCron('nonsense')).toBeNull()
    expect(parseCron('0 0 0 0')).toBeNull()
    expect(parseCron(null)).toBeNull()
  })

  it('refuses an out-of-range value', () => {
    // 5-field standard cron has no seconds, so "99" here is a minute.
    expect(parseCron('99 * * * *')).toBeNull()
    expect(parseCron('0 0 25 * * *')).toBeNull()
  })
})

describe('buildCron', () => {
  it('builds each period shape', () => {
    expect(buildCron({ period: 'minute', secs: [0] })).toBe('0 * * * * *')
    expect(buildCron({ period: 'nminutes', n: 5, secs: [0] })).toBe('0 */5 * * * *')
    expect(buildCron({ period: 'hour', mins: [5, 35], secs: [0] })).toBe('0 5,35 * * * *')
    expect(buildCron({ period: 'nhours', n: 6, mins: [15], secs: [0] })).toBe('0 15 */6 * * *')
    expect(buildCron({ period: 'day', mins: [30], hours: [5, 17], secs: [0] })).toBe('0 30 5,17 * * *')
    expect(buildCron({ period: 'week', mins: [0], hours: [9], dows: [1], secs: [0] })).toBe('0 0 9 * * 1')
  })

  it('sorts and de-duplicates the chip selections', () => {
    // The chips can be clicked in any order; the stored value should not
    // depend on which one a human pressed first.
    expect(buildCron({ period: 'hour', mins: [35, 5, 35], secs: [0] })).toBe('0 5,35 * * * *')
  })

  it('falls back to a safe expression rather than emitting nonsense', () => {
    // An empty selection cannot happen through the UI (chips enforce one), but
    // a caller passing junk should not produce an expression node-cron would
    // reject and the scheduler would then fall back from anyway.
    expect(buildCron({ period: 'hour', mins: [], secs: [] })).toBe('0 0 * * * *')
    expect(buildCron(null)).toBe('0 0 * * * *')
  })
})

describe('describeCron', () => {
  it('says the shipped schedules in English', () => {
    expect(describeCron('0 */30 * * * *')).toBe('Every 30 minutes')
    expect(describeCron('0 0 * * * *')).toBe('Hourly, on the hour')
    expect(describeCron('0 5,35 * * * *')).toBe('Hourly at :05 and :35')
    expect(describeCron('0 15 */6 * * *')).toBe('Every 6 hours, at :15')
    expect(describeCron('0 5 1 * * *')).toBe('Daily at 01:05')
    expect(describeCron('0 30 5,17 * * *')).toBe('Twice daily at 05:30 and 17:30')
  })

  it('⚠️ names the seconds offset, because that is the whole point of it', () => {
    expect(describeCron('30 * * * * *')).toBe('Every minute, at :30 seconds')
  })

  it('calls a sub-minute cadence what it is', () => {
    // "Every minute at seconds 00 and 30" understates it — this is twice a
    // minute, and the reader is about to double a job's API cost.
    expect(describeCron('0,30 * * * * *')).toBe('Twice a minute, at :00 and :30 seconds')
  })

  it('hands back an unmodellable expression rather than mis-describing it', () => {
    expect(describeCron('0 0 3 1 * *')).toBe('0 0 3 1 * *')
  })
})

describe('nextRuns', () => {
  const FROM = new Date(Date.UTC(2026, 8, 20, 10, 0, 0))

  it('lists the next fire times in UTC, which is TCT', () => {
    expect(nextRuns('0 5,35 * * * *', 3, FROM).map((d) => d.toISOString())).toEqual([
      '2026-09-20T10:05:00.000Z',
      '2026-09-20T10:35:00.000Z',
      '2026-09-20T11:05:00.000Z',
    ])
  })

  it('⚠️ honours the seconds field', () => {
    // Without this the preview would show :00 for crime-occupancy and quietly
    // agree with the bug the seconds field exists to avoid.
    expect(nextRuns('30 * * * * *', 2, FROM).map((d) => d.toISOString())).toEqual([
      '2026-09-20T10:00:30.000Z',
      '2026-09-20T10:01:30.000Z',
    ])
  })

  it('crosses a day boundary', () => {
    const from = new Date(Date.UTC(2026, 8, 20, 23, 59, 0))
    expect(nextRuns('0 5 1 * * *', 1, from)[0].toISOString()).toBe('2026-09-21T01:05:00.000Z')
  })

  it('returns nothing for an expression it cannot evaluate', () => {
    expect(nextRuns('nonsense', 3, FROM)).toEqual([])
  })
})

describe('minuteLoad', () => {
  it('counts how many jobs land on each minute of the hour', () => {
    const load = minuteLoad(['0 0 * * * *', '0 0,30 * * * *', '0 5 1 * * *'])
    expect(load.counts).toHaveLength(60)
    expect(load.counts[0]).toBe(2)
    expect(load.counts[30]).toBe(1)
    expect(load.counts[5]).toBe(1)
    expect(load.counts[7]).toBe(0)
  })

  it('⚠️ separates the every-minute jobs instead of flattening the chart', () => {
    // A job on every minute occupies all 60 and would swamp the counts, hiding
    // precisely the quiet minutes the strip exists to reveal.
    const load = minuteLoad(['30 * * * * *', '0 0 * * * *'])
    expect(load.everyMinute).toBe(1)
    expect(load.counts[0]).toBe(1)
    expect(load.counts[7]).toBe(0)
  })

  it('reports the busiest minute, which is the one to avoid', () => {
    const load = minuteLoad(Object.values(SHIPPED))
    expect(load.busiestMinute).toBe(0)
    expect(load.busiest).toBeGreaterThan(1)
  })

  it('ignores an expression it cannot read rather than throwing', () => {
    const load = minuteLoad(['0 0 * * * *', 'nonsense', null])
    expect(load.counts[0]).toBe(1)
  })
})
