import { describe, it, expect, vi } from 'vitest'
import { urlBase64ToUint8Array, pushSupported, shouldPrompt, ensurePushSubscription } from '../pushClient'

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 into the raw bytes', () => {
    // "hi" -> base64 "aGk=" -> URL-safe "aGk" (padding stripped).
    expect(Array.from(urlBase64ToUint8Array('aGk'))).toEqual([104, 105])
  })
  it('handles - and _ substitutions', () => {
    // bytes [251, 255] -> base64 "+/8=" -> URL-safe "-_8".
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })
})

describe('pushSupported', () => {
  it('is true when serviceWorker, PushManager and Notification all exist', () => {
    const win = { navigator: { serviceWorker: {} }, PushManager: function () {}, Notification: function () {} }
    expect(pushSupported(win)).toBe(true)
  })
  it('is false when PushManager is missing (e.g. iOS in a browser tab)', () => {
    const win = { navigator: { serviceWorker: {} }, Notification: function () {} }
    expect(pushSupported(win)).toBe(false)
  })
})

describe('shouldPrompt', () => {
  const base = { supported: true, permission: 'default', vapidPublicKey: 'k', alreadyAsked: false }
  it('prompts a supported, undecided user when push is configured', () => {
    expect(shouldPrompt(base)).toBe(true)
  })
  it('does not prompt if already granted or denied', () => {
    expect(shouldPrompt({ ...base, permission: 'granted' })).toBe(false)
    expect(shouldPrompt({ ...base, permission: 'denied' })).toBe(false)
  })
  it('does not prompt when the server has no VAPID key', () => {
    expect(shouldPrompt({ ...base, vapidPublicKey: null })).toBe(false)
  })
  it('does not re-ask within a session', () => {
    expect(shouldPrompt({ ...base, alreadyAsked: true })).toBe(false)
  })
})

describe('ensurePushSubscription', () => {
  it('bails without prompting when the server has no VAPID key', async () => {
    const requestPermission = vi.fn()
    const result = await ensurePushSubscription({ getPublicKey: async () => null, requestPermission })
    expect(result).toBeNull()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('does not subscribe when the user denies permission', async () => {
    const post = vi.fn()
    const registration = { pushManager: { getSubscription: async () => null, subscribe: vi.fn() } }
    const result = await ensurePushSubscription({
      getPublicKey: async () => 'aGk',
      getRegistration: async () => registration,
      requestPermission: async () => 'denied',
      post,
    })
    expect(result).toBeNull()
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('subscribes and posts the subscription when permission is granted', async () => {
    const subJson = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({ toJSON: () => subJson }),
      },
    }
    const post = vi.fn(async () => ({ ok: true }))
    const result = await ensurePushSubscription({
      getPublicKey: async () => 'aGk',
      getRegistration: async () => registration,
      requestPermission: async () => 'granted',
      post,
    })
    expect(result).toEqual(subJson)
    expect(post).toHaveBeenCalledWith('/api/push/subscribe', subJson)
  })

  it('reuses an existing subscription without re-prompting', async () => {
    const subJson = { endpoint: 'https://push.example/existing', keys: { p256dh: 'p', auth: 'a' } }
    const requestPermission = vi.fn()
    const registration = { pushManager: { getSubscription: async () => ({ toJSON: () => subJson }) } }
    const post = vi.fn(async () => ({ ok: true }))
    const result = await ensurePushSubscription({
      getPublicKey: async () => 'aGk',
      getRegistration: async () => registration,
      requestPermission,
      post,
    })
    expect(result).toEqual(subJson)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith('/api/push/subscribe', subJson)
  })
})
