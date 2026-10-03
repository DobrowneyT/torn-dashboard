// @vitest-environment jsdom
//
// #867 — a member downloads their own stat history.
//
// ⚠️ The assertions that matter are about what is NOT sent and what is NOT
// saved: no member parameter on the request, and no file when the stream was
// cut short. A truncated CSV that saves cleanly is worse than a failed one,
// because it opens perfectly with most of its rows missing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../utils/apiClient', () => ({ apiFetch: vi.fn() }))
const { apiFetch } = await import('../../utils/apiClient')
const { default: MyStatsExport } = await import('../MyStatsExport')

const CSV = 'member_id,snapshot_date\n9101,2026-08-05\n9101,2026-08-06\n# 2 rows\n'

let clicked
beforeEach(() => {
  vi.clearAllMocks()
  clicked = []
  global.URL.createObjectURL = vi.fn(() => 'blob:fake')
  global.URL.revokeObjectURL = vi.fn()
  // Capture the download without letting jsdom navigate.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    clicked.push({ href: this.href, download: this.download })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const ok = (body) => ({ ok: true, status: 200, text: async () => body })

describe('MyStatsExport', () => {
  it('⚠️ sends NO member parameter — the server scopes by session', () => {
    // A member id that can be sent is a member id that can be changed. There
    // is deliberately nothing here to pass.
    apiFetch.mockResolvedValue(ok(CSV))
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText('Download CSV'))
    return waitFor(() => {
      const url = apiFetch.mock.calls[0][0]
      expect(url).toMatch(/^\/api\/export\/me\/stats\.csv\?/)
      expect(url).not.toMatch(/member/i)
      expect(url).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/)
    })
  })

  it('saves the rows with the completion marker stripped', async () => {
    apiFetch.mockResolvedValue(ok(CSV))
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText('Download CSV'))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1)
    // jsdom's Blob has no .text(); read it through FileReader instead.
    const blob = global.URL.createObjectURL.mock.calls[0][0]
    const saved = await new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = reject
      fr.readAsText(blob)
    })
    expect(saved).toContain('9101,2026-08-05')
    expect(saved).not.toContain('# 2 rows')
  })

  it('⚠️ saves NOTHING when the stream was cut short', async () => {
    // The status line went out with the headers, so a mid-stream failure still
    // arrives as a 200. The missing marker is the only way to tell.
    apiFetch.mockResolvedValue(ok('member_id,snapshot_date\n9101,2026-08-05\n'))
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText('Download CSV'))
    expect(await screen.findByText(/cut short/i)).toBeTruthy()
    expect(clicked).toHaveLength(0)
    expect(global.URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('surfaces the server’s own refusal, e.g. a visitor', async () => {
    apiFetch.mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: 'Visitors have no stat history to export' }),
    })
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText('Download CSV'))
    expect(await screen.findByText(/Visitors have no stat history/)).toBeTruthy()
    expect(clicked).toHaveLength(0)
  })

  it('falls back to a status code when the error is not JSON', async () => {
    apiFetch.mockResolvedValue({
      ok: false, status: 500,
      json: async () => { throw new Error('not json') },
    })
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText('Download CSV'))
    expect(await screen.findByText(/Export failed \(500\)/)).toBeTruthy()
  })

  it('honours the selected range', async () => {
    apiFetch.mockResolvedValue(ok(CSV))
    render(<MyStatsExport />)
    fireEvent.change(screen.getByLabelText(/how much history/i), { target: { value: '30' } })
    fireEvent.click(screen.getByText('Download CSV'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const url = apiFetch.mock.calls[0][0]
    const [, from, to] = url.match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/)
    const span = (new Date(to) - new Date(from)) / 86400_000
    expect(Math.round(span)).toBe(30)
  })

  it('⚠️ says gym columns start at join rather than leaving a mystery blank', async () => {
    // They come from a current-only endpoint and can never be backfilled
    // (#866). An unexplained empty column reads as a bug and gets reported.
    apiFetch.mockResolvedValue(ok(CSV))
    render(<MyStatsExport />)
    fireEvent.click(screen.getByText(/what's in it/))
    expect(await screen.findByText(/Gym columns start from the day you joined/)).toBeTruthy()
  })
})
