// #632 — rewriting FLEET_METRICS_TOKEN in deploy/docker-compose.override.yml.
//
// The file this edits holds every tenant's DATABASE_URL. A rewriter that
// mangled it takes the whole fleet down on the next `docker compose up`, so the
// preservation cases below matter as much as the ones that change something.
import { describe, expect, it } from 'vitest'
import { setOverrideTokens } from '../fleetTokenFile.mjs'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

const OVERRIDE = `# Per-faction API processes — managed by db/new-faction.mjs (slice #75).
services:

  api-forge:
    build:
      context: ..
      dockerfile: deploy/server.Dockerfile
    environment:
      FACTION_SLUG: forge
      DATABASE_URL: postgres://app_forge:\${DB_PASSWORD_FORGE}@postgres:5432/faction_forge
      # ⚠️ THIS faction's own fleet-metrics token (#632), not the fleet secret.
      FLEET_METRICS_TOKEN: ${'0'.repeat(64)}
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  api-tnl:
    environment:
      FACTION_SLUG: tnl
      FLEET_METRICS_TOKEN: ${'1'.repeat(64)}
    restart: unless-stopped
`

describe('setOverrideTokens', () => {
  it('replaces each tenant token in its own service block', () => {
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A, tnl: HEX_B })
    expect(r.updated.sort()).toEqual(['forge', 'tnl'])
    expect(r.added).toEqual([])
    expect(r.missing).toEqual([])
    const forge = r.text.slice(r.text.indexOf('api-forge'), r.text.indexOf('api-tnl'))
    expect(forge).toContain(`FLEET_METRICS_TOKEN: ${HEX_A}`)
    expect(forge).not.toContain(HEX_B)
    expect(r.text.slice(r.text.indexOf('api-tnl'))).toContain(`FLEET_METRICS_TOKEN: ${HEX_B}`)
  })

  it('⚠️ leaves every other line byte-for-byte, comments and passwords included', () => {
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A, tnl: HEX_B })
    const strip = (t) => t.split('\n').filter((l) => !l.includes('FLEET_METRICS_TOKEN:')).join('\n')
    expect(strip(r.text)).toBe(strip(OVERRIDE))
  })

  it('⚠️ touches only the tenants asked for', () => {
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A })
    expect(r.updated).toEqual(['forge'])
    expect(r.text).toContain(`FLEET_METRICS_TOKEN: ${'1'.repeat(64)}`)
  })

  it('adds the key to a tenant provisioned before the secret existed', () => {
    // The reason this exists: every live tenant predates FLEET_METRICS_SECRET.
    const before = `services:

  api-old:
    environment:
      FACTION_SLUG: old
    restart: unless-stopped
`
    const r = setOverrideTokens(before, { old: HEX_A })
    expect(r.added).toEqual(['old'])
    expect(r.updated).toEqual([])
    const lines = r.text.split('\n')
    const at = lines.findIndex((l) => l.includes('FLEET_METRICS_TOKEN:'))
    expect(lines[at]).toBe(`      FLEET_METRICS_TOKEN: ${HEX_A}`)
    // ⚠️ Inside the environment block, not after `restart:` — where compose
    // would read it as a sibling key and the service would fail to parse.
    expect(lines.findIndex((l) => l.startsWith('    restart:'))).toBeGreaterThan(at)
  })

  it('adds the key when the environment block runs to the end of the file', () => {
    const before = 'services:\n\n  api-last:\n    environment:\n      FACTION_SLUG: last\n\n'
    const r = setOverrideTokens(before, { last: HEX_A })
    expect(r.added).toEqual(['last'])
    expect(r.text).toContain(`      FLEET_METRICS_TOKEN: ${HEX_A}`)
    expect(r.text.trimEnd().endsWith(HEX_A)).toBe(true)
  })

  it('⚠️ reports a slug with no service rather than silently doing nothing', () => {
    // A typo'd slug that returned success would leave that tenant on a stale
    // token, reporting `metricsError` while the operator believed it was done.
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A, ghost: HEX_B })
    expect(r.missing).toEqual(['ghost'])
    expect(r.updated).toEqual(['forge'])
  })

  it('⚠️ refuses a token that is not a hex digest', () => {
    // Compose interpolates `${...}` inside the compose file itself, so a value
    // carrying a `$` is silently mangled into a token that never matches.
    expect(() => setOverrideTokens(OVERRIDE, { forge: 'not$a$digest' })).toThrow(/hex/)
    expect(() => setOverrideTokens(OVERRIDE, { forge: HEX_A.slice(0, 32) })).toThrow(/hex/)
  })

  it('does not confuse a non-tenant service for a faction', () => {
    const before = `services:
  postgres:
    environment:
      FLEET_METRICS_TOKEN: nope
  api-forge:
    environment:
      FLEET_METRICS_TOKEN: ${'0'.repeat(64)}
`
    const r = setOverrideTokens(before, { forge: HEX_A })
    expect(r.updated).toEqual(['forge'])
    expect(r.text).toContain('FLEET_METRICS_TOKEN: nope')
  })
})
