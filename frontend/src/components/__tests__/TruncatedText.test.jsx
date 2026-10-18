// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import TruncatedText from '../TruncatedText'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const sizes = (scroll, client) => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client)
}

describe('TruncatedText', () => {
  it('⚠️ is plain text, with nothing to hover, when it fits', () => {
    sizes(50, 100)
    render(<TruncatedText text="Hacker" />)
    expect(screen.getByText('Hacker')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the full text when it is actually cut off', () => {
    sizes(300, 100)
    render(<TruncatedText text="A very long calendar event title indeed" />)
    expect(screen.getByRole('button')).toBeTruthy()
  })
})
