// #646 — in-place credential rotation in deploy/.env.
//
// ⚠️ This file holds every faction's database password and the fleet-wide admin
// credential, and it is not in git. A rotation that mangles it is not
// recoverable from history — it is recoverable by re-provisioning every tenant
// credential by hand. That is why the editing is its own module with its own
// tests rather than inline in the generator.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setEnvValues, envValue, readEnv, writeEnv } from '../adminEnvFile.mjs'

const SAMPLE = `# Postgres
POSTGRES_USER=postgres
POSTGRES_PASSWORD=hunter2

# Admin control plane (#609)
ADMIN_USERNAME=oldname
ADMIN_PASSWORD_HASH=scrypt.1.2.3.old.old
ADMIN_TOTP_SECRET=OLDSECRET
ADMIN_SESSION_SECRET=oldsession

DB_PASSWORD_TNL=tenantsecret
`

describe('setEnvValues', () => {
  it('rewrites a key in place', () => {
    const out = setEnvValues(SAMPLE, { ADMIN_USERNAME: 'newname' })
    expect(envValue(out, 'ADMIN_USERNAME')).toBe('newname')
  })

  it('⚠️ never leaves two copies of the same key', () => {
    // dotenv and docker compose both take the LAST occurrence, so appending
    // would work by accident while leaving the old credential visible above it
    // — and an operator reading the file would see two ADMIN_PASSWORD_HASH
    // lines with no way to tell which is live.
    const out = setEnvValues(SAMPLE, { ADMIN_PASSWORD_HASH: 'scrypt.new' })
    expect(out.split('\n').filter((l) => l.startsWith('ADMIN_PASSWORD_HASH=')))
      .toHaveLength(1)
  })

  it('⚠️ preserves comments, blank lines and ordering', () => {
    // deploy/.env is hand-maintained and heavily commented. A rotation that
    // reformatted it would make every future diff unreadable.
    const out = setEnvValues(SAMPLE, { ADMIN_USERNAME: 'x' })
    expect(out).toContain('# Postgres')
    expect(out).toContain('# Admin control plane (#609)')
    expect(out.indexOf('POSTGRES_USER')).toBeLessThan(out.indexOf('ADMIN_USERNAME'))
  })

  it('⚠️ leaves every other faction credential untouched', () => {
    const out = setEnvValues(SAMPLE, {
      ADMIN_USERNAME: 'x', ADMIN_PASSWORD_HASH: 'y',
      ADMIN_TOTP_SECRET: 'z', ADMIN_SESSION_SECRET: 'w',
    })
    expect(envValue(out, 'DB_PASSWORD_TNL')).toBe('tenantsecret')
    expect(envValue(out, 'POSTGRES_PASSWORD')).toBe('hunter2')
  })

  it('appends a key the file does not have', () => {
    const out = setEnvValues(SAMPLE, { BRAND_NEW: 'value' })
    expect(envValue(out, 'BRAND_NEW')).toBe('value')
  })

  it('⚠️ does not glue onto a file with no trailing newline', () => {
    // The same trap db/new-faction.mjs and db/new-global.mjs already guard: a
    // hand-edited .env may end mid-line, and appending without a newline
    // corrupts BOTH the last key and the new one.
    const out = setEnvValues('A=1\nB=2', { C: '3' })
    expect(out.split('\n').filter(Boolean)).toEqual(['A=1', 'B=2', 'C=3'])
    expect(envValue(out, 'B')).toBe('2')
  })

  it('does not touch a key whose name merely starts the same', () => {
    const out = setEnvValues('ADMIN_USERNAME=a\nADMIN_USERNAME_OLD=b\n', { ADMIN_USERNAME: 'z' })
    expect(envValue(out, 'ADMIN_USERNAME')).toBe('z')
    expect(envValue(out, 'ADMIN_USERNAME_OLD')).toBe('b')
  })

  it('ignores commented-out assignments', () => {
    const out = setEnvValues('# ADMIN_USERNAME=commented\nADMIN_USERNAME=real\n', { ADMIN_USERNAME: 'z' })
    expect(out).toContain('# ADMIN_USERNAME=commented')
    expect(envValue(out, 'ADMIN_USERNAME')).toBe('z')
  })
})

describe('envValue', () => {
  it('takes the LAST occurrence, as dotenv does', () => {
    expect(envValue('K=first\nK=second\n', 'K')).toBe('second')
  })

  it('returns null for an absent key rather than an empty string', () => {
    // "absent" and "set to empty" are different states — --password-only has to
    // tell them apart to know whether there is a secret to keep.
    expect(envValue('K=\n', 'MISSING')).toBeNull()
    expect(envValue('K=\n', 'K')).toBe('')
  })
})

describe('writeEnv', () => {
  it('⚠️ writes atomically and locks the file down', () => {
    // A crash midway through a plain truncating write leaves deploy/.env
    // half-written, and it is not in git.
    const dir = mkdtempSync(join(tmpdir(), 'envfile-'))
    const path = join(dir, '.env')
    try {
      writeFileSync(path, 'OLD=1\n')
      writeEnv(path, 'NEW=2\n')
      expect(readFileSync(path, 'utf8')).toBe('NEW=2\n')
      expect(statSync(path).mode & 0o077).toBe(0)
      expect(readEnv(join(dir, 'nope'))).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
