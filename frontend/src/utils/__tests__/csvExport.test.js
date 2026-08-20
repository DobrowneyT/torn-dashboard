// Client half of the table export (#517). The theme is truncation: a streamed
// export cannot fail with a status code, so everything here is about noticing
// when the file is short.
import { describe, it, expect } from 'vitest'
import {
  csvFilename,
  fetchTableCsv,
  inspectTrailer,
  tctBound,
  trimBytes,
} from '../csvExport'

const bytes = (s) => new TextEncoder().encode(s)

describe('inspectTrailer', () => {
  it('reads the row count off a finished export', () => {
    const t = inspectTrailer('1,2\r\n# complete: 444684 rows\r\n')
    expect(t.complete).toBe(true)
    expect(t.rows).toBe(444684)
  })

  it('reports a truncated body as incomplete', () => {
    // The exact shape of a mid-stream database failure: valid CSV, no marker.
    expect(inspectTrailer('1,2\r\n3,4\r\n').complete).toBe(false)
  })

  it('is not fooled by a marker that is not at the end', () => {
    expect(inspectTrailer('# complete: 5 rows\r\n6,7\r\n').complete).toBe(false)
  })

  it('is not fooled by a data row that merely looks like one', () => {
    expect(inspectTrailer('a,b\r\n"# complete: 3 rows",x\r\n').complete).toBe(false)
  })

  it('counts only the marker line, leaving the last row terminated', () => {
    const { markerBytes } = inspectTrailer('1,2\r\n# complete: 7 rows\r\n')
    expect(markerBytes).toBe('# complete: 7 rows\r\n'.length)
  })

  it('accepts a zero-row export as complete', () => {
    expect(inspectTrailer('a,b\r\n# complete: 0 rows\r\n')).toMatchObject({ complete: true, rows: 0 })
  })
})

describe('trimBytes', () => {
  it('trims within the final chunk', () => {
    const out = trimBytes([bytes('abc'), bytes('defgh')], 2)
    expect(new TextDecoder().decode(out[1])).toBe('def')
  })

  it('drops whole chunks when the marker spans more than one', () => {
    const out = trimBytes([bytes('abc'), bytes('de'), bytes('fg')], 4)
    expect(out).toHaveLength(1)
    expect(new TextDecoder().decode(out[0])).toBe('abc')
  })

  it('leaves the chunks alone when there is nothing to trim', () => {
    const chunks = [bytes('abc')]
    expect(trimBytes(chunks, 0)).toBe(chunks)
  })
})

describe('csvFilename', () => {
  it('names the file after the table and the range', () => {
    expect(csvFilename('faction_attacks', '2026-08-01', '2026-08-19'))
      .toBe('faction_attacks_2026-08-01_2026-08-19.csv')
  })

  it('flattens punctuation a filesystem dislikes', () => {
    expect(csvFilename('crimes', '2026-08-01T00:00', '2026-08-19T12:30'))
      .toBe('crimes_2026-08-01T00_00_2026-08-19T12_30.csv')
  })
})

describe('tctBound', () => {
  it('sends a bare day when no time was picked', () => {
    expect(tctBound('2026-08-19', '')).toBe('2026-08-19')
  })

  it('joins day and time the way the API parses them', () => {
    expect(tctBound('2026-08-19', '14:30')).toBe('2026-08-19T14:30')
  })

  it('is null without a day, so the caller cannot send half a range', () => {
    expect(tctBound('', '14:30')).toBeNull()
  })
})

function fakeResponse(body, { ok = true, status = 200, error } = {}) {
  return {
    ok,
    status,
    json: async () => (error ? { error } : {}),
    arrayBuffer: async () => bytes(body).buffer,
  }
}

describe('fetchTableCsv', () => {
  it('requests the chosen table and range', async () => {
    let seen = null
    await fetchTableCsv(
      { table: 'faction_attacks', from: '2026-08-01', to: '2026-08-19T12:00' },
      async (path) => { seen = path; return fakeResponse('a\r\n# complete: 0 rows\r\n') }
    )
    expect(seen).toBe('/api/export/faction_attacks/csv?from=2026-08-01&to=2026-08-19T12%3A00')
  })

  it('strips the marker so it never lands in the saved file', async () => {
    const res = await fetchTableCsv(
      { table: 'crimes', from: '2026-08-01', to: '2026-08-19' },
      async () => fakeResponse('id\r\n1\r\n# complete: 1 rows\r\n')
    )
    expect(res.complete).toBe(true)
    expect(res.rows).toBe(1)
    expect(await res.blob.text()).toBe('id\r\n1\r\n')
  })

  it('still returns the partial data on a truncated stream, flagged incomplete', async () => {
    // Throwing the rows away would be worse: the caller may well want them,
    // as long as nothing pretends the export finished.
    const res = await fetchTableCsv(
      { table: 'crimes', from: '2026-08-01', to: '2026-08-19' },
      async () => fakeResponse('id\r\n1\r\n2\r\n')
    )
    expect(res.ok).toBe(true)
    expect(res.complete).toBe(false)
    expect(await res.blob.text()).toBe('id\r\n1\r\n2\r\n')
  })

  it('surfaces the server error on a refusal, which arrives before any streaming', async () => {
    const res = await fetchTableCsv(
      { table: 'members', from: '2026-08-01', to: '2026-08-19' },
      async () => fakeResponse('', { ok: false, status: 403, error: 'Forbidden' })
    )
    expect(res).toMatchObject({ ok: false, status: 403, error: 'Forbidden' })
  })

  it('reads a real stream chunk by chunk', async () => {
    const parts = ['id\r\n', '1\r\n2\r\n', '# complete: 2 rows\r\n'].map(bytes)
    let i = 0
    const res = await fetchTableCsv({ table: 'crimes', from: 'a', to: 'b' }, async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) },
    }))
    expect(res.rows).toBe(2)
    expect(await res.blob.text()).toBe('id\r\n1\r\n2\r\n')
  })

  it('finds a marker split across chunk boundaries', async () => {
    const parts = ['id\r\n1\r\n# comp', 'lete: 1 rows\r\n'].map(bytes)
    let i = 0
    const res = await fetchTableCsv({ table: 'crimes', from: 'a', to: 'b' }, async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) },
    }))
    expect(res.complete).toBe(true)
    expect(await res.blob.text()).toBe('id\r\n1\r\n')
  })
})
