// CSV serialisation for the table exporter (#517).
//
// Values arrive as strings (the query casts every column to text — see
// exportQuery.ts), so this module never parses or reformats data. Its only two
// jobs are quoting and the formula guard.

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA rather than
 * text, when the file is opened by double-clicking it.
 *
 * ⚠️ This is not hypothetical for us. Torn display names are user-controlled,
 * and an exported roster is precisely the kind of file someone double-clicks.
 * A member who renames themselves to `=HYPERLINK(...)` or `+cmd|...` gets that
 * evaluated in the leader's Excel, not shown.
 *
 * Tab and carriage return are included because Excel strips leading whitespace
 * before deciding, so `\t=1+1` is still a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/** Characters that force RFC 4180 quoting. */
const NEEDS_QUOTES = /[",\r\n]/

/**
 * Neutralise a formula lead by prefixing an apostrophe — the convention every
 * spreadsheet understands as "this is text".
 *
 * ⚠️ Applied ONLY when the value is not a plain number. Without that check,
 * every negative number in the file (`-1500`, a payout adjustment) would come
 * back as the text `'-1500` and stop summing, which is a data-corrupting
 * "fix" for the far more common case.
 */
export function guardFormula(value: string): string {
  if (!FORMULA_LEAD.test(value)) return value
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return value
  return `'${value}`
}

/** One CSV field: NULL becomes empty, everything else is guarded then quoted. */
export function csvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  const guarded = guardFormula(String(value))
  if (!NEEDS_QUOTES.test(guarded)) return guarded
  return `"${guarded.replace(/"/g, '""')}"`
}

/** One CSV line, CRLF-terminated per RFC 4180. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvValue).join(',') + '\r\n'
}

/**
 * The completion marker (#517).
 *
 * ⚠️ THE COST OF STREAMING, made visible. Once the first byte is on the wire
 * the status is already 200, so a database error at row 300,000 cannot become
 * an error response — the client gets a short file that opens perfectly and is
 * silently missing two thirds of the data. This trailer is the only thing that
 * distinguishes a finished export from a truncated one, so the client MUST
 * check for it and the UI must strip it before saving.
 */
export function completionMarker(rows: number): string {
  return `# complete: ${rows} rows\r\n`
}

export const COMPLETION_PREFIX = '# complete:'

/** Parse a trailer line back out; null when this is not a marker. */
export function parseCompletionMarker(line: string): number | null {
  const m = /^# complete: (\d+) rows$/.exec(line.trim())
  return m ? Number(m[1]) : null
}
