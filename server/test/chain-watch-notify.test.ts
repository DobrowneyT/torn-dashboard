// #785 follow-up — nudging the Discord bot when a sign-up changes.
//
// ⚠️ Every test here is about the nudge being HARMLESS. A member clicking
// "sign up" must never see an error, or wait, because a Discord bot is down or
// its socket is missing. The bot's own polling is the backstop, so the worst
// case is a board that is one poll stale.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'chain-notify-'))
const SOCKET = join(dir, 'notify.sock')

// The module reads the env at import time, so it must be set first.
process.env.CHAIN_NOTIFY_SOCKET = SOCKET
const { notifyBoardChanged, notifyEnabled } = await import('../src/chainWatchNotify.js')

let server: Server
const received: unknown[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body: JSON.parse(body || '{}') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(SOCKET, r))
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

describe('notifyBoardChanged', () => {
  it('posts the slug to the socket', async () => {
    received.length = 0
    await notifyBoardChanged('forge')
    expect(received).toEqual([
      { url: '/changed', method: 'POST', body: { slug: 'forge' } },
    ])
  })

  it('is enabled when the socket is configured', () => {
    expect(notifyEnabled()).toBe(true)
  })

  it('⚠️ resolves quietly when nothing is listening', async () => {
    // The normal state whenever the bot is restarting, or simply not run. This
    // must not reject — an unhandled rejection in a request hook is a 500 on
    // somebody claiming a slot.
    const gone = join(dir, 'no-such.sock')
    const prev = process.env.CHAIN_NOTIFY_SOCKET
    process.env.CHAIN_NOTIFY_SOCKET = gone
    try {
      const mod = await import('../src/chainWatchNotify.js?nolisten')
      await expect(mod.notifyBoardChanged('forge')).resolves.toBeUndefined()
    } finally {
      process.env.CHAIN_NOTIFY_SOCKET = prev
    }
  })

  it('⚠️ never rejects, whatever the slug is', async () => {
    await expect(notifyBoardChanged('')).resolves.toBeUndefined()
    await expect(notifyBoardChanged('a'.repeat(5000))).resolves.toBeUndefined()
  })
})
