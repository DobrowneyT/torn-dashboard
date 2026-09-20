// @vitest-environment jsdom
//
// #756 — the Scraper Jobs schedule cell, mounted.
//
// ⚠️ This file exists because the pure model and the editor component were both
// fully tested and neither would have caught a mistake in the wiring: a missing
// Fragment key, a drawer with the wrong colSpan, a strip dividing by zero. The
// v3.97.0 crash was exactly that shape — every helper green, nothing mounted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const apiGet = vi.fn()
const apiPut = vi.fn()
const apiPost = vi.fn()
vi.mock('../../utils/apiClient', () => ({
  apiGet: (...a) => apiGet(...a),
  apiPut: (...a) => apiPut(...a),
  apiPost: (...a) => apiPost(...a),
}))

const { default: GlobalAdminView } = await import('../GlobalAdminView')

// Three real jobs: one plain, one with a seconds offset, and one whose cadence
// the sentence cannot express.
const JOBS = [
  { job_name: 'crimes-sync', enabled: true, cron_schedule: null,
    effective_schedule: '0 */30 * * * *', schedule_source: 'default', rejected_schedule: null },
  { job_name: 'crime-occupancy', enabled: true, cron_schedule: null,
    effective_schedule: '30 * * * * *', schedule_source: 'default', rejected_schedule: null },
  { job_name: 'odd-job', enabled: true, cron_schedule: '0 0 3 1 * *',
    effective_schedule: '0 0 3 1 * *', schedule_source: 'tenant', rejected_schedule: null },
]

beforeEach(() => {
  apiGet.mockReset(); apiPut.mockReset(); apiPost.mockReset()
  apiGet.mockImplementation((url) => {
    if (url.includes('scraper/jobs')) return Promise.resolve({ jobs: JOBS })
    if (url.includes('scraper/runs')) return Promise.resolve({ runs: [] })
    if (url.includes('key-pool')) return Promise.resolve({ keys: [] })
    return Promise.resolve({ secrets: [] })
  })
  apiPut.mockResolvedValue({})
})
afterEach(cleanup)

const editButton = (job) =>
  screen.getByRole('button', { name: new RegExp(`(edit|close) schedule for ${job}`, 'i') })

describe('Global Admin — the schedule cell', () => {
  it('renders without throwing, which is the point of mounting it', async () => {
    render(<GlobalAdminView />)
    expect(await screen.findByText('crimes-sync')).toBeTruthy()
  })

  it('⚠️ shows plain English at rest, not raw cron', async () => {
    // The input that used to live here put six-field cron on screen, where
    // `*/5 * * * *` and `*/5 * * * * *` differ by one character and a factor
    // of sixty in API traffic.
    render(<GlobalAdminView />)
    expect(await screen.findByText('Every 30 minutes')).toBeTruthy()
    expect(screen.getByText('Every minute, at :30 seconds')).toBeTruthy()
    expect(screen.queryByDisplayValue('0 */30 * * * *')).toBeNull()
  })

  it('hands back the raw expression for a cadence it cannot say', async () => {
    render(<GlobalAdminView />)
    expect(await screen.findByText('0 0 3 1 * *')).toBeTruthy()
  })

  it('opens the editor inline and closes it again', async () => {
    render(<GlobalAdminView />)
    await screen.findByText('crimes-sync')
    fireEvent.click(editButton('crimes-sync'))
    expect(screen.getByLabelText(/how often/i)).toBeTruthy()
    fireEvent.click(editButton('crimes-sync'))
    expect(screen.queryByLabelText(/how often/i)).toBeNull()
  })

  it('⚠️ keeps only one editor open at a time', async () => {
    // Two drawers would push the second off screen — and the offsets this
    // editor exists to set are chosen by comparing against the rows still
    // visible, so losing the table defeats the layout choice.
    render(<GlobalAdminView />)
    await screen.findByText('crimes-sync')
    fireEvent.click(editButton('crimes-sync'))
    fireEvent.click(editButton('crime-occupancy'))
    expect(screen.getAllByLabelText(/how often/i)).toHaveLength(1)
  })

  it('saves the cadence the editor produced', async () => {
    render(<GlobalAdminView />)
    await screen.findByText('crimes-sync')
    fireEvent.click(editButton('crimes-sync'))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(apiPut).toHaveBeenCalled())
    expect(apiPut).toHaveBeenCalledWith(
      '/api/admin/scraper/jobs/crimes-sync',
      { cron_schedule: '0 */30 * * * *' },
    )
  })

  it('⚠️ offers the revert only where there is an override to revert', async () => {
    // odd-job has cron_schedule set; crimes-sync follows the default. A revert
    // on the latter would write null over null and read as a no-op that did
    // something.
    render(<GlobalAdminView />)
    await screen.findByText('crimes-sync')
    fireEvent.click(editButton('crimes-sync'))
    expect(screen.queryByRole('button', { name: /use default/i })).toBeNull()
    fireEvent.click(editButton('crimes-sync'))
    fireEvent.click(editButton('odd-job'))
    expect(screen.getByRole('button', { name: /use default/i })).toBeTruthy()
  })
})

describe('Global Admin — the minute-occupancy strip', () => {
  it('names the busiest minute, which is what an offset is chosen against', async () => {
    render(<GlobalAdminView />)
    const note = await screen.findByText(/busiest minute is/i)
    expect(note.textContent).toMatch(/:00/)
  })

  it('⚠️ counts every-minute jobs separately rather than flattening the chart', async () => {
    // crime-occupancy occupies all sixty minutes; folded into the counts it
    // would hide the quiet minutes the strip exists to reveal.
    render(<GlobalAdminView />)
    const note = await screen.findByText(/busiest minute is/i)
    expect(note.textContent).toMatch(/1 job runs every minute/i)
  })

  it('does not render when there is nothing to chart', async () => {
    apiGet.mockImplementation((url) =>
      Promise.resolve(url.includes('scraper/jobs') ? { jobs: [] } : { runs: [], keys: [], secrets: [] }))
    render(<GlobalAdminView />)
    await screen.findByText(/Scrapers are not configured/i)
    expect(screen.queryByText(/busiest minute is/i)).toBeNull()
  })
})
