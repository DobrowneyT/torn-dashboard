// Range parsing and SQL construction (#517). Pure — no database.
import { describe, expect, it } from 'vitest'
import { EXPORT_TABLES } from '../src/exportRegistry.js'
import {
  buildExportQuery,
  parseTctBound,
  rangeBounds,
  type ColumnInfo,
} from '../src/exportQuery.js'

const bound = (s: string) => {
  const b = parseTctBound(s)
  if (!b) throw new Error(`unparseable: ${s}`)
  return b
}

describe('parseTctBound', () => {
  it('accepts a bare day and a day with a time', () => {
    expect(parseTctBound('2026-08-19')?.ms).toBe(Date.UTC(2026, 7, 19))
    expect(parseTctBound('2026-08-19T14:30')?.ms).toBe(Date.UTC(2026, 7, 19, 14, 30))
    expect(parseTctBound('2026-08-19T14:30:45')?.ms).toBe(Date.UTC(2026, 7, 19, 14, 30, 45))
  })

  it('reads the input as TCT regardless of where the container runs', () => {
    // `new Date('2026-08-19 12:00')` is LOCAL-time parsed, so the same request
    // would select different rows on a machine in another timezone.
    expect(parseTctBound('2026-08-19 12:00')?.ms).toBe(Date.UTC(2026, 7, 19, 12, 0))
    expect(parseTctBound('2026-08-19T12:00Z')?.ms).toBe(Date.UTC(2026, 7, 19, 12, 0))
  })

  it('records whether a time of day was given', () => {
    expect(parseTctBound('2026-08-19')?.hasTime).toBe(false)
    expect(parseTctBound('2026-08-19T00:00')?.hasTime).toBe(true)
  })

  it('rejects a date that does not exist rather than rolling it forward', () => {
    // Date.UTC turns Feb 31 into Mar 3 without complaint.
    expect(parseTctBound('2026-02-31')).toBeNull()
    expect(parseTctBound('2026-13-01')).toBeNull()
  })

  it('rejects free-form input', () => {
    expect(parseTctBound('yesterday')).toBeNull()
    expect(parseTctBound('19/08/2026')).toBeNull()
    expect(parseTctBound('')).toBeNull()
    expect(parseTctBound(undefined)).toBeNull()
    expect(parseTctBound(1786919295)).toBeNull()
  })
})

describe('rangeBounds', () => {
  const from = bound('2026-08-01')
  const to = bound('2026-08-19')

  it('converts to epoch seconds for epoch columns', () => {
    expect(rangeBounds('epoch', from, to)).toEqual({
      lo: Date.UTC(2026, 7, 1) / 1000,
      hi: Date.UTC(2026, 7, 19) / 1000,
      hiInclusive: false,
    })
  })

  it('is half-open on instants, so consecutive exports neither drop nor duplicate a row', () => {
    expect(rangeBounds('timestamptz', from, to).hiInclusive).toBe(false)
    expect(rangeBounds('timestamp', from, to).hiInclusive).toBe(false)
    expect(rangeBounds('epoch', from, to).hiInclusive).toBe(false)
  })

  it('takes the end DAY whole on a date column', () => {
    // A date is a day LABEL. "Aug 1 to Aug 19" plainly includes the 19th, and
    // half-open would silently drop a full day of snapshots.
    const b = rangeBounds('date', from, to)
    expect(b).toEqual({ lo: '2026-08-01', hi: '2026-08-19', hiInclusive: true })
  })

  it('still takes the end day whole when a time of day was supplied', () => {
    expect(rangeBounds('date', from, bound('2026-08-19T09:00')).hi).toBe('2026-08-19')
  })

  it('emits naked timestamps without a zone and tz ones as ISO', () => {
    expect(rangeBounds('timestamp', from, to).lo).toBe('2026-08-01 00:00:00')
    expect(rangeBounds('timestamptz', from, to).lo).toBe('2026-08-01T00:00:00.000Z')
  })
})

describe('buildExportQuery', () => {
  const attackCols: ColumnInfo[] = [
    { name: 'attack_id', dataType: 'bigint' },
    { name: 'started', dataType: 'bigint' },
    { name: 'ended', dataType: 'bigint' },
    { name: 'attacker_id', dataType: 'integer' },
    { name: 'attacker_name', dataType: 'text' },
    { name: 'created_at', dataType: 'timestamp with time zone' },
  ]
  const built = () =>
    buildExportQuery(
      'faction_attacks',
      EXPORT_TABLES.faction_attacks,
      attackCols,
      rangeBounds('epoch', bound('2026-08-01'), bound('2026-08-19'))
    )

  it('puts each readable companion immediately after the value it explains', () => {
    expect(built().columns).toEqual([
      'attack_id',
      'started', 'started_tct',
      'ended', 'ended_tct',
      'attacker_id',
      'attacker_name',
      'created_at',
    ])
  })

  it('keeps the raw value as well as the readable one', () => {
    const { columns } = built()
    expect(columns).toContain('started')
    expect(columns).toContain('started_tct')
  })

  it('filters on the declared column, not on our insert time', () => {
    const { sql } = built()
    expect(sql).toContain('WHERE t."started" >= $1 AND t."started" < $2')
    expect(sql).not.toContain('"created_at" >=')
  })

  it('binds the bounds rather than interpolating them', () => {
    expect(built().params).toEqual([Date.UTC(2026, 7, 1) / 1000, Date.UTC(2026, 7, 19) / 1000])
  })

  it('blanks a zero epoch instead of claiming 1970', () => {
    // Torn writes 0 for "never happened" — an `ended` of 0 on an unfinished
    // attack. A confident 1970-01-01 beside a raw 0 is worse than a blank.
    expect(built().sql).toContain('NULLIF(t."ended", 0)')
  })

  it('renders timestamps in SQL so no JS clock touches them', () => {
    const { sql } = built()
    expect(sql).toContain(`to_char(t."created_at" AT TIME ZONE 'UTC'`)
  })

  it('quotes a column named after a reserved word', () => {
    // faction_revives has a column literally called `timestamp`.
    const { sql, columns } = buildExportQuery(
      'faction_revives',
      EXPORT_TABLES.faction_revives,
      [
        { name: 'revive_id', dataType: 'bigint' },
        { name: 'timestamp', dataType: 'bigint' },
      ],
      rangeBounds('epoch', bound('2026-08-01'), bound('2026-08-19'))
    )
    expect(sql).toContain('t."timestamp"')
    expect(columns).toEqual(['revive_id', 'timestamp', 'timestamp_tct'])
  })

  it('joins the roster only for ids with no name stored beside them', () => {
    const { sql, columns } = buildExportQuery(
      'member_cpr_v2',
      EXPORT_TABLES.member_cpr_v2,
      [
        { name: 'member_id', dataType: 'text' },
        { name: 'cpr_value', dataType: 'double precision' },
        { name: 'last_seen_at', dataType: 'timestamp with time zone' },
      ],
      rangeBounds('timestamptz', bound('2026-08-01'), bound('2026-08-19'))
    )
    expect(sql).toContain('LEFT JOIN members n0 ON n0.member_id = t."member_id"::text')
    expect(columns).toEqual(['member_id', 'member_id_name', 'cpr_value', 'last_seen_at'])
  })

  it('does not join for attacks, whose names are already as-of-event', () => {
    expect(built().sql).not.toContain('LEFT JOIN')
  })

  it('orders by the declared time column so the file reads chronologically', () => {
    expect(built().sql).toContain('ORDER BY t."started" ASC')
  })

  it('switches to an inclusive upper bound for date columns', () => {
    const { sql } = buildExportQuery(
      'member_daily_stats',
      EXPORT_TABLES.member_daily_stats,
      [{ name: 'snapshot_date', dataType: 'date' }],
      rangeBounds('date', bound('2026-08-01'), bound('2026-08-19'))
    )
    expect(sql).toContain('t."snapshot_date" <= $2')
  })
})
