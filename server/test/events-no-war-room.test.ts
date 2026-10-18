// ⚠️ The event report shares nothing with the War Room (#972, #967): not its
// push hub, not its ticker, not its tables. Chain Watch drew the same line, and
// the reasons are in scraper/jobs/chainSample.ts. A static check, because the
// failure — a convenient import — would otherwise pass every behavioural test.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = join(__dirname, '..', 'src', 'events')

describe('events code and the War Room', () => {
  it('imports no War Room module and touches no War Room table', () => {
    const offenders: string[] = []
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(DIR, f), 'utf8')
      if (/from\s+['"][^'"]*warRoom/i.test(src)) offenders.push(`${f}: imports a warRoom module`)
      if (/\bwar_room_\w+/.test(src)) offenders.push(`${f}: names a war_room_ table`)
      if (/warRoomHub|\.broadcast\(/.test(src)) offenders.push(`${f}: uses the War Room hub`)
    }
    expect(offenders).toEqual([])
  })
})
