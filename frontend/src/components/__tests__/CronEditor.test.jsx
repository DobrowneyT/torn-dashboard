// @vitest-environment jsdom
//
// #756 — the sentence editor. The model it binds to is covered by
// cronSentence.test.js; what these pin is the behaviour that only exists once
// a human is clicking:
//
//  - the editor never quietly rewrites the schedule it was opened on,
//  - a schedule the sentence cannot say falls back to text rather than being
//    rounded off,
//  - a cadence that multiplies Torn API calls says so before it is saved.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import CronEditor from '../CronEditor'

afterEach(cleanup)

const save = (name = /save/i) => screen.getByRole('button', { name })
const chip = (group, label) =>
  within(screen.getByRole('group', { name: group })).getByRole('button', { name: label })

describe('CronEditor', () => {
  it('opens on the schedule it was given, as a sentence', () => {
    render(<CronEditor value="0 30 5,17 * * *" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText(/how often/i).value).toBe('day')
    expect(chip('At hour(s)', '05').getAttribute('aria-pressed')).toBe('true')
    expect(chip('At hour(s)', '17').getAttribute('aria-pressed')).toBe('true')
    expect(chip('At minute(s)', '30').getAttribute('aria-pressed')).toBe('true')
  })

  it('⚠️ saves back exactly what it opened with when nothing was touched', () => {
    // An editor that "tidies" on open would rewrite 19 cadences the first time
    // somebody clicked through them to look.
    const onSave = vi.fn()
    render(<CronEditor value="0 5,35 * * * *" onSave={onSave} onCancel={() => {}} />)
    fireEvent.click(save())
    expect(onSave).toHaveBeenCalledWith('0 5,35 * * * *')
  })

  it('⚠️ keeps a seconds offset through an unrelated edit', () => {
    // crime-occupancy's :30 is the #389 decision the whole editor exists to
    // preserve — changing the period must not drop it.
    const onSave = vi.fn()
    render(<CronEditor value="30 * * * * *" onSave={onSave} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText(/how often/i), { target: { value: 'nminutes' } })
    fireEvent.click(save())
    expect(onSave).toHaveBeenCalledWith(expect.stringMatching(/^30 \*\/\d+ \* \* \* \*$/))
  })

  it('writes six fields even when it was handed five', () => {
    const onSave = vi.fn()
    render(<CronEditor value="*/15 * * * *" onSave={onSave} onCancel={() => {}} />)
    fireEvent.click(save())
    expect(onSave).toHaveBeenCalledWith('0 */15 * * * *')
  })

  it('shows the expression and the next fire times', () => {
    render(<CronEditor value="0 5,35 * * * *" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('0 5,35 * * * *')).toBeTruthy()
    expect(screen.getByText(/hourly at :05 and :35/i)).toBeTruthy()
    expect(screen.getAllByTestId('next-run').length).toBeGreaterThan(0)
  })

  it('updates the readout as the sentence changes', () => {
    render(<CronEditor value="0 0 * * * *" onSave={() => {}} onCancel={() => {}} />)
    fireEvent.click(chip('At minute(s)', '30'))
    expect(screen.getByText('0 0,30 * * * *')).toBeTruthy()
  })

  it('⚠️ will not let the last chip in a row be switched off', () => {
    // An empty minute list is not a schedule. Cron would reject it, the
    // scheduler would fall back to the code default, and the admin page would
    // show a cadence nobody asked for.
    render(<CronEditor value="0 30 * * * *" onSave={() => {}} onCancel={() => {}} />)
    fireEvent.click(chip('At minute(s)', '30'))
    expect(chip('At minute(s)', '30').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('CronEditor — the call-volume warning', () => {
  it('⚠️ counts the API calls when the cadence goes sub-minute', () => {
    // Two clicks doubles a job's Torn traffic across every tenant. The number
    // has to be on screen before Save, not discovered in the key pool later.
    render(<CronEditor value="30 * * * * *" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('volume-warning')).toBeNull()
    fireEvent.click(chip('At second(s)', '00'))
    const warn = screen.getByTestId('volume-warning')
    expect(warn.textContent).toMatch(/2,880/)
    expect(warn.textContent).toMatch(/twice a minute/i)
  })

  it('stays quiet for an ordinary cadence', () => {
    render(<CronEditor value="0 5 1 * * *" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('volume-warning')).toBeNull()
  })
})

describe('CronEditor — schedules the sentence cannot say', () => {
  const ODD = '0 0 3 1 * *' // 03:00 on the 1st of the month

  it('⚠️ falls back to raw text instead of rounding the schedule off', () => {
    render(<CronEditor value={ODD} onSave={() => {}} onCancel={() => {}} />)
    expect(screen.queryByLabelText(/how often/i)).toBeNull()
    expect(screen.getByLabelText(/cron expression/i).value).toBe(ODD)
    expect(screen.getByTestId('fallback-note').textContent).toMatch(/too specific/i)
  })

  it('saves the text exactly as typed', () => {
    const onSave = vi.fn()
    render(<CronEditor value={ODD} onSave={onSave} onCancel={() => {}} />)
    const box = screen.getByLabelText(/cron expression/i)
    fireEvent.change(box, { target: { value: '0 0 4 2 * *' } })
    fireEvent.click(save())
    expect(onSave).toHaveBeenCalledWith('0 0 4 2 * *')
  })

  it('lets the reader switch a simple schedule to raw cron on purpose', () => {
    render(<CronEditor value="0 0 * * * *" onSave={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /edit as cron/i }))
    expect(screen.getByLabelText(/cron expression/i).value).toBe('0 0 * * * *')
  })
})

describe('CronEditor — the other two buttons', () => {
  it('cancels without reporting a value', () => {
    const onSave = vi.fn(), onCancel = vi.fn()
    render(<CronEditor value="0 0 * * * *" onSave={onSave} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('⚠️ reverting to the default sends null, not the default text', () => {
    // Null is "follow the fleet default" — a live instruction. Writing the
    // current value back as an override would pin this faction to whatever the
    // default happened to be today (scheduleResolution.ts).
    const onSave = vi.fn()
    render(<CronEditor value="0 0 * * * *" defaultValue="0 */30 * * * *" onSave={onSave} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /use default/i }))
    expect(onSave).toHaveBeenCalledWith(null)
  })

  it('offers no revert when there is nothing to revert to', () => {
    render(<CronEditor value="0 0 * * * *" onSave={() => {}} onCancel={() => {}} />)
    expect(screen.queryByRole('button', { name: /use default/i })).toBeNull()
  })
})
