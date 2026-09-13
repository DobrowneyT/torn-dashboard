// @vitest-environment jsdom
//
// #730 — selecting a whole category, and the mount test this modal never had.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import CrimePickerModal from '../CrimePickerModal'

afterEach(cleanup)

// Difficulty carries the category via the real resolver, so these names must be
// ones config.ocScenarios knows.
const SCENARIOS = [
  { name: 'Break the Bank', difficulty: 8, parameter_count: 6 },
  { name: 'Clinical Precision', difficulty: 8, parameter_count: 4 },
  { name: 'Window of Opportunity', difficulty: 7, parameter_count: 5 },
  { name: 'Snow Blind', difficulty: 4, parameter_count: 4 },
]

const open = (props = {}) => {
  const onApply = vi.fn()
  render(
    <CrimePickerModal
      scenarios={SCENARIOS} selected={[]} onApply={onApply} onClose={() => {}} {...props} />
  )
  return { onApply }
}

describe('CrimePickerModal', () => {
  it('renders without throwing', () => {
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('offers a select-all per category', () => {
    open()
    expect(screen.getByText('Select all Advanced')).toBeTruthy()
    expect(screen.getByText('Select all Simple')).toBeTruthy()
  })

  it('⚠️ selects every crime in the category, and only that category', () => {
    const { onApply } = open()
    fireEvent.click(screen.getByText('Select all Advanced'))
    fireEvent.click(screen.getByRole('button', { name: /apply|show|compare/i }))
    const picked = onApply.mock.calls[0][0]
    expect(picked).toContain('Break the Bank')
    expect(picked).toContain('Clinical Precision')
    expect(picked).toContain('Window of Opportunity')
    expect(picked).not.toContain('Snow Blind')
  })

  it('flips to a clear action once the category is full', () => {
    open()
    fireEvent.click(screen.getByText('Select all Advanced'))
    expect(screen.getByText('Clear Advanced')).toBeTruthy()
    fireEvent.click(screen.getByText('Clear Advanced'))
    expect(screen.getByText('Select all Advanced')).toBeTruthy()
  })

  it('⚠️ completing a partial selection keeps the picks already made', () => {
    const { onApply } = open({ selected: ['Snow Blind'] })
    fireEvent.click(screen.getByText('Select all Advanced'))
    fireEvent.click(screen.getByRole('button', { name: /apply|show|compare/i }))
    // Order is the page order — the existing pick stays first.
    expect(onApply.mock.calls[0][0][0]).toBe('Snow Blind')
  })
})
