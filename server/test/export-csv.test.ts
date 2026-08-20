// CSV serialisation for the exporter (#517). The formula guard is the reason
// this file exists — the quoting rules are RFC 4180 and would be unremarkable
// on their own.
import { describe, expect, it } from 'vitest'
import {
  completionMarker,
  csvRow,
  csvValue,
  guardFormula,
  parseCompletionMarker,
} from '../src/exportCsv.js'

describe('csvValue', () => {
  it('passes ordinary text through untouched', () => {
    expect(csvValue('MonChoon')).toBe('MonChoon')
  })

  it('renders null and undefined as an empty field, not the word null', () => {
    expect(csvValue(null)).toBe('')
    expect(csvValue(undefined)).toBe('')
  })

  it('quotes and doubles embedded quotes', () => {
    expect(csvValue('He said "hi"')).toBe('"He said ""hi"""')
  })

  it('quotes fields containing a comma or a newline', () => {
    expect(csvValue('Smith, John')).toBe('"Smith, John"')
    expect(csvValue('line1\nline2')).toBe('"line1\nline2"')
  })

  it('keeps a jsonb blob intact inside quotes', () => {
    expect(csvValue('{"a": 1, "b": 2}')).toBe('"{""a"": 1, ""b"": 2}"')
  })
})

describe('guardFormula', () => {
  // The whole point: a Torn name is user-controlled and lands in a file people
  // open by double-clicking.
  it.each(['=cmd()', '+1+1', '@SUM(A1)', '=HYPERLINK("http://evil","x")'])(
    'neutralises %s so a spreadsheet shows it as text',
    (name) => {
      expect(guardFormula(name)).toBe(`'${name}`)
    }
  )

  it('neutralises a lead character hidden behind whitespace Excel strips', () => {
    expect(guardFormula('\t=1+1')).toBe("'\t=1+1")
  })

  it('leaves negative numbers alone so they still sum', () => {
    // The naive guard breaks every payout adjustment in the file.
    expect(guardFormula('-1500')).toBe('-1500')
    expect(guardFormula('-0.5')).toBe('-0.5')
  })

  it('guards a name that merely starts like a negative number', () => {
    expect(guardFormula('-1500 owed')).toBe("'-1500 owed")
  })

  it('survives the round trip through csvValue', () => {
    expect(csvValue('=cmd(),x')).toBe(`"'=cmd(),x"`)
  })
})

describe('csvRow', () => {
  it('joins fields and terminates with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n')
  })
})

describe('completion marker', () => {
  it('round-trips the row count', () => {
    expect(parseCompletionMarker(completionMarker(444684))).toBe(444684)
  })

  it('reports zero rows as a complete export, not a missing marker', () => {
    expect(parseCompletionMarker(completionMarker(0))).toBe(0)
  })

  it('does not mistake a data row for the marker', () => {
    expect(parseCompletionMarker('1786919295,2026-08-16 22:28:15')).toBeNull()
    expect(parseCompletionMarker('# complete: some rows')).toBeNull()
  })
})
