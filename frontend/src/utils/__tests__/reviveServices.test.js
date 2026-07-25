import { describe, it, expect } from 'vitest'
import { DEFAULT_REVIVE_SERVICES, effectiveReviveServices } from '../reviveServices'

describe('DEFAULT_REVIVE_SERVICES', () => {
  it('ships UHC, WTF and Nuke with the right payload shapes', () => {
    const byName = Object.fromEntries(DEFAULT_REVIVE_SERVICES.map((s) => [s.name, s]))
    expect(byName.UHC).toMatchObject({ preset: 'json', sourceKey: 'source', source: 'UHC Script' })
    expect(byName.WTF).toMatchObject({ preset: 'json', sourceKey: 'requestChannel', source: 'WTF Revive Button Script' })
    expect(byName.Nuke).toMatchObject({ preset: 'nuke', source: 'Nuke Revive Me Userscript v2.2' })
    for (const s of DEFAULT_REVIVE_SERVICES) expect(s.url).toMatch(/^https:\/\//)
  })
})

describe('effectiveReviveServices', () => {
  it('returns the defaults when a faction has never configured any', () => {
    expect(effectiveReviveServices({})).toBe(DEFAULT_REVIVE_SERVICES)
    expect(effectiveReviveServices({ revive_services: null })).toBe(DEFAULT_REVIVE_SERVICES)
    expect(effectiveReviveServices(undefined)).toBe(DEFAULT_REVIVE_SERVICES)
  })
  it('respects an explicit list, including an intentional empty clear', () => {
    const custom = [{ name: 'Ours', url: 'https://x.example', source: 'x', sourceKey: 'source', preset: 'json' }]
    expect(effectiveReviveServices({ revive_services: custom })).toBe(custom)
    expect(effectiveReviveServices({ revive_services: [] })).toEqual([])
  })
})
