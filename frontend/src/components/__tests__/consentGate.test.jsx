// @vitest-environment jsdom
//
// The API Key Usage re-approval prompt (#894).
//
// ⚠️ The theme is what this must NOT do. The rule is "force a re-approval",
// and the obvious reading — block the app, reload the tab, stop the key —
// would punish a member for our change. It overlays, it does not gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../utils/apiClient', () => ({ apiPost: vi.fn() }))
vi.mock('../../utils/factionIdentity', () => ({ getApiKeyTitle: () => 'Test-Dashboard' }))
vi.mock('../../config', () => ({ tornKeyGenUrl: () => 'https://www.torn.com/preferences.php' }))

const { apiPost } = await import('../../utils/apiClient')
const { default: ConsentGate } = await import('../ConsentGate')

beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const stale = { consentRequired: true, consentVersion: 'login-v1' }

describe('ConsentGate', () => {
  it('⚠️ renders nothing when consent is current', () => {
    const { container } = render(<ConsentGate user={{ consentRequired: false }} />)
    expect(container.firstChild).toBeNull()
  })

  it('⚠️ renders nothing for a session with no user at all', () => {
    const { container } = render(<ConsentGate user={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('prompts when the disclosure has moved on, and shows what it now says', () => {
    render(<ConsentGate user={stale} />)
    expect(screen.getByText(/how your api key is used has changed/i)).toBeTruthy()
    // The real disclosure, not a summary of it.
    expect(screen.getByText(/Limited Access/)).toBeTruthy()
  })

  it('⚠️ says plainly that nothing stops working in the meantime', () => {
    // A member who reads "re-approve or else" will assume their key was cut
    // off. It was not, and the whole design exists so it is not.
    render(<ConsentGate user={stale} />)
    expect(screen.getByText(/nothing stops working/i)).toBeTruthy()
  })

  it('records acceptance without sending a version', async () => {
    // ⚠️ A stale tab must not be able to accept wording that has since been
    // replaced, so the server decides what "current" means.
    apiPost.mockResolvedValue({ consent_required: false })
    render(<ConsentGate user={stale} />)
    fireEvent.click(screen.getByRole('button', { name: /i accept/i }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/auth/consent', {}))
  })

  it('⚠️ hides itself on accept rather than waiting for the next bootstrap', async () => {
    // Bootstrap is fetched once at login; leaving the modal up would read as
    // the button not having worked.
    apiPost.mockResolvedValue({ consent_required: false })
    const { container } = render(<ConsentGate user={stale} />)
    fireEvent.click(screen.getByRole('button', { name: /i accept/i }))
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('⚠️ stays up and explains when recording the acceptance fails', async () => {
    // Silently closing would leave the member believing they had accepted.
    apiPost.mockRejectedValue(new Error('database on fire'))
    render(<ConsentGate user={stale} />)
    fireEvent.click(screen.getByRole('button', { name: /i accept/i }))
    expect(await screen.findByText('database on fire')).toBeTruthy()
    expect(screen.getByRole('button', { name: /i accept/i })).toBeTruthy()
  })

  it('can be deferred, because it does not gate the app', async () => {
    const { container } = render(<ConsentGate user={stale} />)
    fireEvent.click(screen.getByRole('button', { name: /remind me later/i }))
    expect(container.firstChild).toBeNull()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('⚠️ never reloads the tab', () => {
    // useVersionGate reloads on the War Room because stale CODE there is
    // dangerous. Here we want an acknowledgement, and a reload would discard
    // whatever somebody was half-way through typing.
    const reload = vi.fn()
    const original = window.location
    delete window.location
    window.location = { ...original, reload }
    try {
      apiPost.mockResolvedValue({})
      render(<ConsentGate user={stale} />)
      fireEvent.click(screen.getByRole('button', { name: /i accept/i }))
      expect(reload).not.toHaveBeenCalled()
    } finally {
      window.location = original
    }
  })
})
