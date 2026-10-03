// Range parsing and SQL construction for the CSV exporter (#517).
//
// Two design choices carry most of the weight here:
//
//  1. EVERY column is cast to text IN SQL. node-pg otherwise hands back JS
//     Dates, and a `timestamp without time zone` becomes a Date interpreted in
//     the SERVER's timezone — so an export's readability would depend on the
//     container's TZ. Casting in the query means this module hands the CSV
//     writer strings it never has to parse, and there is no clock in the
//     pipeline at all.
//
//  2. Columns are ENUMERATED from information_schema rather than `SELECT *`.
//     That is what lets the readable companions sit BESIDE the raw values
//     (`started, started_tct, ended, ended_tct`) instead of being bolted on at
//     the end. It weakens nothing: the table name is resolved against the
//     registry first, and information_schema is only ever asked about a name
//     that already passed that gate.
import type pg from 'pg'
import type { ExportTable, TimeType } from './exportRegistry.js'

/**
 * TCT IS UTC. Every timestamp this module emits or accepts is TCT, and the
 * conversion is therefore the identity — no offset arithmetic anywhere, and no
 * timezone for a caller to get wrong.
 */
const TCT_FORMAT = 'YYYY-MM-DD HH24:MI:SS'

/**
 * Accepted range inputs: a bare TCT day, or a day with a time.
 *
 * ⚠️ Strict on purpose — NOT `new Date(input)`. `new Date('2026-08-19 12:00')`
 * is parsed in the runtime's LOCAL timezone, so the same request would select
 * a different set of rows depending on where the container runs. Matching a
 * fixed shape and building the instant with Date.UTC removes that entirely.
 */
const RANGE_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/

export interface ParsedBound {
  /** Milliseconds since epoch, UTC. */
  ms: number
  /** Whether the caller supplied a time of day (affects date-column bounds). */
  hasTime: boolean
}

export function parseTctBound(input: unknown): ParsedBound | null {
  if (typeof input !== 'string') return null
  const m = RANGE_INPUT.exec(input.trim())
  if (!m) return null
  const [, y, mo, d, hh, mm, ss] = m
  const ms = Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)
  )
  if (!Number.isFinite(ms)) return null
  // Date.UTC happily rolls 2026-02-31 into March. Round-tripping catches it,
  // so a typo is a 400 rather than a silently shifted range.
  const iso = new Date(ms).toISOString()
  if (iso.slice(0, 10) !== `${y}-${mo}-${d}`) return null
  return { ms, hasTime: hh !== undefined }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** `YYYY-MM-DD HH:MM:SS`, UTC — the wire form for the naked timestamp columns. */
function utcStamp(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  )
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export interface RangeBounds {
  lo: string | number
  hi: string | number
  /**
   * Whether the upper bound is inclusive.
   *
   * ⚠️ It differs by column type, and both readings are the correct one for
   * their type. An INSTANT column is half-open [from, to): a row at exactly
   * 12:00:00 belongs to the range that starts there, not to the one that ends
   * there, so consecutive exports neither duplicate nor drop it. A DATE column
   * is a day LABEL, not an instant — "Aug 1 to Aug 19" plainly includes the
   * 19th, and half-open there would drop a whole day of snapshots with nothing
   * on screen to suggest it had.
   */
  hiInclusive: boolean
}

export function rangeBounds(type: TimeType, from: ParsedBound, to: ParsedBound): RangeBounds {
  switch (type) {
    case 'epoch':
      return { lo: Math.floor(from.ms / 1000), hi: Math.floor(to.ms / 1000), hiInclusive: false }
    case 'timestamptz':
      return { lo: new Date(from.ms).toISOString(), hi: new Date(to.ms).toISOString(), hiInclusive: false }
    case 'timestamp':
      return { lo: utcStamp(from.ms), hi: utcStamp(to.ms), hiInclusive: false }
    case 'date':
      // A time of day has no meaning below the day, so it is DISCARDED here
      // rather than rounded — with an inclusive bound, truncating to the day
      // already takes the end day whole, and nudging the instant first would
      // spill the range into the following day.
      return { lo: utcDay(from.ms), hi: utcDay(to.ms), hiInclusive: true }
  }
}

export interface ColumnInfo {
  name: string
  dataType: string
}

/** Columns of an ALREADY-ALLOWLISTED table, in their declared order. */
export async function introspectColumns(db: pg.Pool, table: string): Promise<ColumnInfo[]> {
  const res = await db.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  )
  return res.rows.map((r: { column_name: string; data_type: string }) => ({
    name: r.column_name,
    dataType: r.data_type,
  }))
}

/**
 * Quote an identifier for interpolation.
 *
 * ⚠️ Not decoration. `faction_revives` has a column literally named
 * `timestamp`, a reserved word that is a syntax error unquoted. Every
 * identifier reaching here has already been read out of the registry or out of
 * information_schema, so this is correctness, not a sanitiser — the injection
 * gate is the registry lookup, which happens before anything gets this far.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Cast one column to text, preserving its meaning. */
function textExpr(col: ColumnInfo): string {
  const ref = `t.${ident(col.name)}`
  switch (col.dataType) {
    case 'timestamp with time zone':
      return `to_char(${ref} AT TIME ZONE 'UTC', '${TCT_FORMAT}')`
    case 'timestamp without time zone':
      return `to_char(${ref}, '${TCT_FORMAT}')`
    case 'date':
      return `to_char(${ref}, 'YYYY-MM-DD')`
    default:
      return `${ref}::text`
  }
}

export interface BuiltQuery {
  sql: string
  params: Array<string | number>
  /** Header row, companions already interleaved. */
  columns: string[]
}

/**
 * Build the streaming SELECT for one table and range.
 *
 * Companion columns sit immediately after the value they explain:
 *   • an epoch integer gains `<col>_tct`, because nobody reads 1786919295
 *   • a bare member id gains `<col>_name`, resolved against the roster
 *
 * Nothing stored is altered or dropped — the raw column is always still there.
 */
/**
 * Restrict an export to rows belonging to one member (#867).
 *
 * ⚠️ The VALUE is a bound parameter and the COLUMN comes from the registry,
 * never from the request. A self-service export must have no way to express
 * "somebody else" — not a checked parameter, not a filtered one. The route
 * supplies the caller's own id from their verified session claims and nothing
 * reaches this from the query string.
 */
export interface ScopeToMember {
  column: string
  memberId: string
}

export function buildExportQuery(
  table: string,
  spec: ExportTable,
  cols: ColumnInfo[],
  bounds: RangeBounds,
  scope?: ScopeToMember
): BuiltQuery {
  const epochCols = new Set(spec.epochCols ?? [])
  const resolve = new Set(spec.resolveNames ?? [])

  const select: string[] = []
  const columns: string[] = []
  const joins: string[] = []

  for (const col of cols) {
    select.push(`${textExpr(col)} AS ${ident(col.name)}`)
    columns.push(col.name)

    if (epochCols.has(col.name)) {
      const alias = `${col.name}_tct`
      // ⚠️ NULLIF(...,0): Torn writes 0 for "never happened" (an `ended` of 0
      // on an unfinished attack). Rendering that as 1970-01-01 would put a
      // confident, wrong date in the readable column beside a raw 0.
      select.push(
        `to_char(to_timestamp(NULLIF(t.${ident(col.name)}, 0)) AT TIME ZONE 'UTC', '${TCT_FORMAT}') AS ${ident(alias)}`
      )
      columns.push(alias)
    }

    if (resolve.has(col.name)) {
      const j = `n${joins.length}`
      joins.push(
        `LEFT JOIN members ${j} ON ${j}.member_id = t.${ident(col.name)}::text`
      )
      const alias = `${col.name}_name`
      select.push(`${j}.member_name AS ${ident(alias)}`)
      columns.push(alias)
    }
  }

  const cmp = bounds.hiInclusive ? '<=' : '<'
  const timeRef = `t.${ident(spec.timeCol)}`
  const params: (string | number)[] = [bounds.lo, bounds.hi]

  // ⚠️ The scoping column is `ident()`-quoted like every other identifier here
  // and its value is bound, not interpolated. Both halves matter: the column
  // name is chosen by the route from the registry, and the id is the session's.
  let scopeSql = ''
  if (scope) {
    params.push(scope.memberId)
    scopeSql = ` AND t.${ident(scope.column)}::text = $${params.length}\n`
  }

  const sql =
    `SELECT ${select.join(', ')}\n` +
    `  FROM ${ident(table)} t\n` +
    (joins.length ? `  ${joins.join('\n  ')}\n` : '') +
    ` WHERE ${timeRef} >= $1 AND ${timeRef} ${cmp} $2\n` +
    scopeSql +
    ` ORDER BY ${timeRef} ASC`

  return { sql, params, columns }
}
