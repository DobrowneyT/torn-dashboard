// @vitest-environment jsdom
//
// ⚠️ **The one thing this file exists to prove** (#927): a role change reaches
// the UI without a re-login. `/api/auth/refresh` always re-read roles into a new
// token, so the SERVER honoured a grant immediately — but every permission gate
// reads the cached `user` object, and `login()` was the only thing that ever
// wrote it. The symptom was a war lead who had the role on the API and no
// clipboard in the War Room until they logged out and back in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const apiBootstrap = vi.fn()
const apiRefresh = vi.fn()
const getApiSession = vi.fn(() => ({ token: 't', expires_at: 9e12 }))

vi.mock('../../utils/apiClient', () => ({
  apiLogin: vi.fn(),
  apiBootstrap: (...a) => apiBootstrap(...a),
  apiRefresh: (...a) => apiRefresh(...a),
  getApiSession: (...a) => getApiSession(...a),
  storeApiSession: vi.fn(),
  clearApiSession: vi.fn(),
}))
vi.mock('../../utils/factionIdentity', () => ({
  loadFactionIdentity: () => Promise.resolve({}),
  getFactionId: () => 10739,
}))

const { AuthProvider, useAuth } = await import('../AuthContext')

/** Prints the flags the War Room's clipboard and friends actually gate on. */
function Probe() {
  const { user, isWarLead, isLeadership } = useAuth()
  return (
    <div>
      <span data-testid="warlead">{String(isWarLead)}</span>
      <span data-testid="leadership">{String(isLeadership)}</span>
      <span data-testid="lastLogin">{String(user?.lastLogin)}</span>
    </div>
  )
}

const CACHED_LOGIN = '2026-01-01T00:00:00.000Z'

const cached = (over = {}) => JSON.stringify({
  id: 2250591, name: 'MonChoon', isLeadership: false, isAdmin: false,
  isWarLead: false, isOCManager: false, factionPosition: 'Member',
  feedbackEnabled: true, apiKeyHint: 'abcd', consentVersion: 'login-v1',
  consentRequired: false, apiMode: true, lastLogin: CACHED_LOGIN, ...over,
})

const bootWithRoles = (roles) => ({
  ok: true, feedback_enabled: true,
  user: {
    torn_user_id: '2250591', member_name: 'MonChoon', roles,
    api_key_hint: 'abcd', consent_version: 'login-v1', consent_required: false,
  },
})

beforeEach(() => {
  localStorage.clear()
  apiBootstrap.mockReset()
  apiRefresh.mockReset()
  apiRefresh.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('role changes without a re-login (#927)', () => {
  it('⚠️ picks up a newly granted role on load', async () => {
    localStorage.setItem('tornUser', cached())
    apiBootstrap.mockResolvedValue(bootWithRoles(['warlead']))

    render(<AuthProvider><Probe /></AuthProvider>)

    // Cached UI renders first (non-blocking revalidation), then the grant lands.
    await waitFor(() => expect(screen.getByTestId('warlead').textContent).toBe('true'))
    // ⚠️ And it is PERSISTED, or the next load would go stale again.
    expect(JSON.parse(localStorage.getItem('tornUser')).isWarLead).toBe(true)
  })

  /** ⚠️ The direction that matters more: controls must stop being offered. */
  it('picks up a revoked role on load', async () => {
    localStorage.setItem('tornUser', cached({
      isLeadership: true, isWarLead: true, factionPosition: 'Leadership',
    }))
    apiBootstrap.mockResolvedValue(bootWithRoles([]))

    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId('warlead').textContent).toBe('false'))
    expect(screen.getByTestId('leadership').textContent).toBe('false')
  })

  /**
   * ⚠️ The refresh runs on a timer, so restamping `lastLogin` would redate a
   * session nobody has actually logged into — and because it differs on every
   * rebuild, counting it would also make the change-detector fire forever.
   */
  it('does not redate the session when it adopts a change', async () => {
    localStorage.setItem('tornUser', cached())
    apiBootstrap.mockResolvedValue(bootWithRoles(['warlead']))

    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId('warlead').textContent).toBe('true'))
    expect(screen.getByTestId('lastLogin').textContent).toBe(CACHED_LOGIN)
  })

  it('leaves the cached session untouched when nothing changed', async () => {
    localStorage.setItem('tornUser', cached())
    apiBootstrap.mockResolvedValue(bootWithRoles([]))
    const before = localStorage.getItem('tornUser')

    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(apiBootstrap).toHaveBeenCalled())
    expect(localStorage.getItem('tornUser')).toBe(before)
  })

  /**
   * ⚠️ Best-effort. Whether the session is still VALID is the refresh's
   * question and it already answered yes; a bootstrap hiccup afterwards is only
   * about what the UI knows, so it must never log anybody out.
   */
  it('keeps the session when the bootstrap fails', async () => {
    localStorage.setItem('tornUser', cached())
    apiBootstrap.mockResolvedValue({ ok: false, status: 500 })

    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(apiBootstrap).toHaveBeenCalled())
    expect(localStorage.getItem('tornUser')).toBeTruthy()
    expect(screen.getByTestId('warlead').textContent).toBe('false')
  })

  it('does not sync at all when the refresh says the session is dead', async () => {
    localStorage.setItem('tornUser', cached())
    apiRefresh.mockResolvedValue({ ok: false, status: 403, error: 'Your faction access was removed.' })

    render(<AuthProvider><Probe /></AuthProvider>)
    // ⚠️ Torn down, not refreshed into a new shape.
    await waitFor(() => expect(localStorage.getItem('tornUser')).toBeNull())
    expect(apiBootstrap).not.toHaveBeenCalled()
  })

  it('does nothing when there is no saved session', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId('warlead').textContent).toBe('false'))
    expect(apiBootstrap).not.toHaveBeenCalled()
  })
})
