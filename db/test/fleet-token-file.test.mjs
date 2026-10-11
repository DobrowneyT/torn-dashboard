// #632 — rewriting FLEET_METRICS_TOKEN in deploy/docker-compose.override.yml.
//
// The file this edits holds every tenant's DATABASE_URL. A rewriter that
// mangled it takes the whole fleet down on the next `docker compose up`, so the
// preservation cases below matter as much as the ones that change something.
import { describe, expect, it } from 'vitest'
import { setOverrideTokens } from '../fleetTokenFile.mjs'
import { chainWatchScope } from '../chainWatchTokenLib.mjs'
import { warOverviewScope } from '../warOverviewTokenLib.mjs'
import { memberThreadsScope } from '../memberThreadsTokenLib.mjs'

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

// #782 — the same rewriter, now targeting CHAIN_WATCH_TOKEN for the Discord bot.
describe('setOverrideTokens with a second token variable', () => {
  it('adds CHAIN_WATCH_TOKEN alongside FLEET_METRICS_TOKEN, leaving it intact', () => {
    // ⚠️ The two must coexist. A rewriter that replaced the fleet token — same
    // block, similar name, one hex value per line — would silently 401 every
    // tenant's metrics the moment somebody provisioned the bot, and #645 proved
    // "not measured" reads as healthy to a human.
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A }, 'CHAIN_WATCH_TOKEN')
    expect(r.added).toEqual(['forge'])
    expect(r.missing).toEqual([])
    const forge = r.text.slice(r.text.indexOf('api-forge'), r.text.indexOf('api-tnl'))
    expect(forge).toContain(`CHAIN_WATCH_TOKEN: ${HEX_A}`)
    expect(forge).toContain(`FLEET_METRICS_TOKEN: ${'0'.repeat(64)}`)
  })

  it('replaces an existing CHAIN_WATCH_TOKEN in place', () => {
    const once = setOverrideTokens(OVERRIDE, { forge: HEX_A }, 'CHAIN_WATCH_TOKEN')
    const twice = setOverrideTokens(once.text, { forge: HEX_B }, 'CHAIN_WATCH_TOKEN')
    expect(twice.updated).toEqual(['forge'])
    expect(twice.added).toEqual([])
    expect(twice.text).toContain(`CHAIN_WATCH_TOKEN: ${HEX_B}`)
    expect(twice.text).not.toContain(HEX_A)
  })

  it('refuses a variable it does not have a comment for', () => {
    // ⚠️ Fails closed rather than writing an uncommented key into a file that
    // is hand-edited for years by somebody who will not know what it is.
    expect(() => setOverrideTokens(OVERRIDE, { forge: HEX_A }, 'SOME_OTHER_TOKEN')).toThrow(/unknown token/)
  })
})

describe('chainWatchScope', () => {
  it('⚠️ scopes the HMAC so the bot token is not the fleet-metrics token', () => {
    // The entire security argument for a second token is this prefix. If it
    // ever equalled the bare slug, every bot would silently hold fleet metrics.
    expect(chainWatchScope('forge')).toBe('chain-watch:forge')
    expect(chainWatchScope('forge')).not.toBe('forge')
  })
})

// #942 — the fourth variable, for the member-report outbox the bot drains.
describe('setOverrideTokens with MEMBER_THREADS_TOKEN', () => {
  it('coexists with all three of the others', () => {
    // ⚠️ Four hex values per service, one per line, similar names. Each pass
    // must touch only its own key — a rewriter that clobbered a neighbour would
    // 401 a feature nobody was deploying, which is the hardest kind to trace.
    let text = OVERRIDE
    for (const [name, value] of [
      ['CHAIN_WATCH_TOKEN', HEX_A],
      ['WAR_OVERVIEW_TOKEN', HEX_B],
      ['MEMBER_THREADS_TOKEN', 'c'.repeat(64)],
    ]) {
      const r = setOverrideTokens(text, { forge: value }, name)
      expect(r.missing).toEqual([])
      text = r.text
    }
    const forge = text.slice(text.indexOf('api-forge'), text.indexOf('api-tnl'))
    expect(forge).toContain(`FLEET_METRICS_TOKEN: ${'0'.repeat(64)}`)
    expect(forge).toContain(`CHAIN_WATCH_TOKEN: ${HEX_A}`)
    expect(forge).toContain(`WAR_OVERVIEW_TOKEN: ${HEX_B}`)
    expect(forge).toContain(`MEMBER_THREADS_TOKEN: ${'c'.repeat(64)}`)
  })

  it('replaces an existing MEMBER_THREADS_TOKEN in place', () => {
    const once = setOverrideTokens(OVERRIDE, { forge: HEX_A }, 'MEMBER_THREADS_TOKEN')
    const twice = setOverrideTokens(once.text, { forge: HEX_B }, 'MEMBER_THREADS_TOKEN')
    expect(twice.updated).toEqual(['forge'])
    expect(twice.added).toEqual([])
    expect(twice.text).toContain(`MEMBER_THREADS_TOKEN: ${HEX_B}`)
    expect(twice.text).not.toContain(HEX_A)
  })

  it('names the regenerating command in the comment it writes', () => {
    // ⚠️ The file is hand-edited for years. A bare hex value with no note is a
    // value nobody dares rotate.
    const r = setOverrideTokens(OVERRIDE, { forge: HEX_A }, 'MEMBER_THREADS_TOKEN')
    expect(r.text).toContain('node db/member-threads-token.mjs forge')
  })
})

describe('memberThreadsScope', () => {
  it('⚠️ is distinct from every other bot scope', () => {
    // This is the only one of the bot's credentials that WRITES. If it ever
    // equalled another scope, a read-only leak would confer write access to a
    // permanent per-member record.
    const scopes = new Set([
      chainWatchScope('forge'), warOverviewScope('forge'), memberThreadsScope('forge'), 'forge',
    ])
    expect(memberThreadsScope('forge')).toBe('member-threads:forge')
    expect(scopes.size).toBe(4)
  })
})
