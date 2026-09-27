// Wiring Chain Watch's push socket into deploy/docker-compose.override.yml.
//
// ⚠️ The file this edits holds every tenant's DATABASE_URL. A rewriter that
// mangles it takes the whole fleet down on the next `docker compose up` — so
// the preservation cases below matter at least as much as the ones that change
// something, and "is it still valid YAML" is checked, not assumed.
import { describe, expect, it } from 'vitest'
import {
  setOverrideChainNotify, NOTIFY_VAR, CONTAINER_DIR, HOST_DIR_VAR,
} from '../chainNotifyFile.mjs'

const OVERRIDE = `# Per-faction API processes — managed by db/new-faction.mjs (slice #75).
services:

  api-forge:
    build:
      context: ..
      dockerfile: deploy/server.Dockerfile
    environment:
      FACTION_SLUG: forge
      DATABASE_URL: postgres://app_forge:\${DB_PASSWORD_FORGE}@postgres:5432/faction_forge
      FLEET_METRICS_TOKEN: ${'0'.repeat(64)}
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "true"]
      interval: 15s

  api-tnl:
    environment:
      FACTION_SLUG: tnl
    restart: unless-stopped
`

/** The lines of one service, so an assertion cannot accidentally read another's. */
function service(text, slug) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.trim() === `api-${slug}:`)
  let end = start + 1
  while (end < lines.length && !/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[end])) end += 1
  return lines.slice(start, end)
}

describe('setOverrideChainNotify', () => {
  it('adds the env var and the mount to the named service only', () => {
    const r = setOverrideChainNotify(OVERRIDE, ['forge'])
    expect(r.wired).toEqual(['forge'])
    expect(r.missing).toEqual([])

    const forge = service(r.text, 'forge').join('\n')
    // ⚠️ ONE knob. The socket path is DERIVED from the host directory with
    // compose's `:+`, so it cannot be set without something being mounted at
    // it — a socket path pointing at nothing fails on every sign-up, silently,
    // inside a fire-and-forget POST that swallows its own errors.
    expect(forge).toContain(`${NOTIFY_VAR}: \${${HOST_DIR_VAR}:+${CONTAINER_DIR}/notify.sock}`)
    expect(forge).toContain(`\${${HOST_DIR_VAR}:-/tmp/chain-notify-unused}:${CONTAINER_DIR}`)

    // ⚠️ The other four tenants have nothing to do with Chain Watch. Mounting
    // a host directory into them would be a change nobody asked for.
    expect(service(r.text, 'tnl').join('\n')).not.toContain(NOTIFY_VAR)
  })

  it('puts the env key inside environment: and the mount at service level', () => {
    // ⚠️ The bug this test exists for: both insertions land at the SAME line
    // when a service has no volumes: block, and splicing them in sequence puts
    // the second above the first — dropping `CHAIN_NOTIFY_SOCKET: ...` inside
    // the volumes LIST, which is not valid YAML and fails at `up`.
    const lines = service(setOverrideChainNotify(OVERRIDE, ['forge']).text, 'forge')
    const env = lines.findIndex((l) => l === '    environment:')
    const key = lines.findIndex((l) => l.includes(`${NOTIFY_VAR}:`) && !l.trim().startsWith('#'))
    const volumes = lines.findIndex((l) => l === '    volumes:')
    const mount = lines.findIndex((l) => l.includes(CONTAINER_DIR) && l.trim().startsWith('-'))
    expect(env).toBeGreaterThan(-1)
    expect(env).toBeLessThan(key)
    expect(key).toBeLessThan(volumes)
    expect(volumes).toBeLessThan(mount)
    expect(lines[key]).toMatch(/^ {6}\S/)      // 6 spaces: inside environment
    expect(lines[mount]).toMatch(/^ {6}- /)    // a list entry under volumes
  })

  it('does not land the mount inside healthcheck:', () => {
    // ⚠️ `healthcheck:` is the LAST key and its own children are indented
    // deeper, so "append at the end of the service" silently nests the mount
    // inside it — where compose ignores it and the push never works.
    const lines = service(setOverrideChainNotify(OVERRIDE, ['forge']).text, 'forge')
    const volumes = lines.findIndex((l) => l === '    volumes:')
    const health = lines.findIndex((l) => l === '    healthcheck:')
    expect(health).toBeGreaterThan(-1)
    expect(volumes).toBeLessThan(health)
  })

  it('appends to a volumes: block that already exists rather than making a second one', () => {
    const withVolumes = OVERRIDE.replace(
      '    depends_on:\n      postgres:',
      '    volumes:\n      - ./uploads:/data/uploads\n    depends_on:\n      postgres:')
    const lines = service(setOverrideChainNotify(withVolumes, ['forge']).text, 'forge')
    expect(lines.filter((l) => l === '    volumes:')).toHaveLength(1)
    expect(lines.join('\n')).toContain('- ./uploads:/data/uploads')
    expect(lines.join('\n')).toContain(CONTAINER_DIR)
  })

  it('is idempotent — running it twice changes nothing the second time', () => {
    // ⚠️ It will be run again after adding a faction, and a second mount or a
    // duplicated key is a compose file that refuses to start.
    const once = setOverrideChainNotify(OVERRIDE, ['forge'])
    const twice = setOverrideChainNotify(once.text, ['forge'])
    expect(twice.text).toBe(once.text)
    expect(twice.wired).toEqual([])
    expect(twice.already).toEqual(['forge'])
  })

  it('changes NOTHING when a slug has no service', () => {
    // ⚠️ Not a warning to scroll past. A partial write leaves one tenant on the
    // five-minute poll while the others push instantly, and nothing says so.
    const r = setOverrideChainNotify(OVERRIDE, ['forge', 'nope'])
    expect(r.missing).toEqual(['nope'])
    expect(r.text).toBe(OVERRIDE)
    expect(r.wired).toEqual([])
  })

  it('leaves every other line byte-for-byte identical', () => {
    const r = setOverrideChainNotify(OVERRIDE, ['forge'])
    const before = OVERRIDE.split('\n')
    const after = r.text.split('\n').filter(
      (l) => !l.includes(NOTIFY_VAR) && !l.includes(CONTAINER_DIR)
             && l !== '    volumes:' && !l.trim().startsWith('#'))
    expect(after).toEqual(before.filter((l) => !l.trim().startsWith('#')))
  })

  it('uses :+ so an unset directory leaves the socket empty', () => {
    // ⚠️ `:-` would give a DEFAULT path — a socket address pointing at nothing
    // mounted, failing on every sign-up inside a fire-and-forget POST that
    // swallows its own errors. `:+` yields the empty string instead, and an
    // empty CHAIN_NOTIFY_SOCKET is what switches the push off in the server.
    const line = setOverrideChainNotify(OVERRIDE, ['forge']).text.split('\n')
      .find((l) => l.includes(`${NOTIFY_VAR}:`) && !l.trim().startsWith('#'))
    expect(line.trim()).toBe(
      `${NOTIFY_VAR}: \${${HOST_DIR_VAR}:+${CONTAINER_DIR}/notify.sock}`)
    expect(line).not.toContain(`${HOST_DIR_VAR}:-`)
  })

  it('never makes the host directory required', () => {
    // ⚠️ `:?` here would stop a tenant that has nothing to do with Chain Watch
    // from starting at all. Optionality is the guarantee the whole design rests
    // on — the dev compose file says the same thing.
    const r = setOverrideChainNotify(OVERRIDE, ['forge'])
    expect(r.text).not.toContain(`${HOST_DIR_VAR}:?`)
    expect(r.text).not.toContain(`${NOTIFY_VAR}:?`)
  })
})
