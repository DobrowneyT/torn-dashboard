import { describe, it, expect } from 'vitest'
import { WAR_ROOM_HELP_SECTIONS, helpSectionsFor } from '../warroom/warRoomHelp'

// The Help panel content (#153) is the durable reference. Pin the sections the
// issue requires — especially the Mobile App section, which is easy to forget
// and central to the "same controls on your phone" goal — and the leader-gating.

describe('War Room help content', () => {
  it('covers every required member-facing section, including Mobile App', () => {
    const ids = WAR_ROOM_HELP_SECTIONS.map((s) => s.id)
    for (const required of ['dibs', 'attack', 'chain', 'rollcall', 'alerts', 'mobile']) {
      expect(ids).toContain(required)
    }
  })

  it('every section has a title and at least one explained point', () => {
    for (const s of WAR_ROOM_HELP_SECTIONS) {
      expect(s.title).toBeTruthy()
      expect(s.points.length).toBeGreaterThan(0)
      for (const p of s.points) {
        expect(p.term).toBeTruthy()
        expect(p.desc).toBeTruthy()
      }
    }
  })

  it('hides the "For leaders" section from members and shows it to leaders', () => {
    const memberIds = helpSectionsFor({ isLeader: false }).map((s) => s.id)
    const leaderIds = helpSectionsFor({ isLeader: true }).map((s) => s.id)
    expect(memberIds).not.toContain('leaders')
    expect(leaderIds).toContain('leaders')
    // Members still see all the member content.
    expect(memberIds).toContain('mobile')
    expect(memberIds).toContain('dibs')
  })
})
