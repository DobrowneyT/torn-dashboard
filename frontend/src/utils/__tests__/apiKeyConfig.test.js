import { describe, it, expect } from 'vitest'
import { config, tornKeyGenUrl } from '../../config'

// 2.0 consolidated key: validate the opt-in key configuration + the one-click
// Limited-key generation link used by the login disclosure.

describe('consolidated API key config', () => {
  it('requires Limited Access (level 3)', () => {
    expect(config.apiKey.requiredLevel).toBe(3)
  })

  it('has a non-empty consent version (drives re-prompt)', () => {
    expect(typeof config.apiKey.consentVersion).toBe('string')
    expect(config.apiKey.consentVersion.length).toBeGreaterThan(0)
  })

  it('titles the key "Forge-Dashboard"', () => {
    expect(config.apiKey.title).toBe('Forge-Dashboard')
  })
})

describe('tornKeyGenUrl', () => {
  it('generates a Limited (type=3) key link with the encoded title', () => {
    const url = tornKeyGenUrl()
    expect(url).toContain('preferences.php')
    expect(url).toContain('step=addNewKey')
    expect(url).toContain('type=3')
    // 'Forge-Dashboard' URL-encoded (hyphen is safe, so it stays literal)
    expect(url).toContain('title=Forge-Dashboard')
  })

  it('uses an explicit title override when given (#131: per-tenant branding)', () => {
    const url = tornKeyGenUrl('Mayhem-Dashboard')
    expect(url).toContain('title=Mayhem-Dashboard')
    expect(url).not.toContain('Forge')
  })
})
