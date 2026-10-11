// One member's post-war report, end to end against real Postgres (#943).
//
// ⚠️ **The rules worth testing here are the ABSENCE rules**, and they only
// prove out against real table states: a war that was never dibs-summarised
// against one that was and holds no row for this member; a member who never
// answered roll call against one who answered "no". The pure scoring rules are
// held level with the payout sheet by `war-member-score-parity.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const TOKEN = 'member-threads-report-token'
const US = Number(TEST_FACTION.tornFactionId)
const OPP = 20747
const WAR = 777
const ME = 101
const QUIET = 202          // on the roster, no hits, nothing measured
// ⚠️ Touched by NOTHING. The absence tests need a member no other test can
// give a row to — sharing QUIET made "never answered" depend on test order.
const ABSENT = 303
const START = 1_790_000_000
const END = START + 7200

const get = (qs: string, token: string | null = TOKEN) =>
  fetch(`${stack.baseUrl}/api/internal/member-threads/report${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })

const report = async (qs: string) => (await get(qs)).json() as any

async function attack(over: Record<string, unknown>) {
  const row = {
    attack_id: Math.floor(Math.random() * 1e12),
    started: START + 100, result: 'Attacked', chain: 3, respect_gain: 12.5,
    is_ranked_war: true,
    attacker_id: ME, attacker_name: 'Me', attacker_faction_id: US,
    defender_id: 900, defender_name: 'Them', defender_faction_id: OPP,
    ...over,
  }
  const cols = Object.keys(row)
  await stack.db.query(
    `INSERT INTO faction_attacks (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => (row as any)[c]),
  )
}

beforeAll(async () => {
  stack = await startTestStack(undefined, {}, { memberThreadsToken: TOKEN })

  await stack.db.query(
    `INSERT INTO ranked_wars (id, opponent_id, opponent_name, start_at, end_at,
                              our_score, opponent_score, is_termed)
     VALUES ($1, $2, 'Them', $3, $4, 5412, 4877, false)
     ON CONFLICT (id) DO NOTHING`,
    [WAR, OPP, START, END],
  )
  for (const [id, name] of [[ME, 'Me'], [QUIET, 'Quiet']] as Array<[number, string]>) {
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ($1, $2, true)
       ON CONFLICT (member_id) DO NOTHING`,
      [String(id), name],
    )
  }
  // Two scoring hits, one of them a cappable bonus hit.
  await attack({ respect_gain: 20.5, chain: 7 })
  await attack({ respect_gain: 85.25, chain: 100 })
  // A loss, which must not score.
  await attack({ result: 'Lost', respect_gain: 0, chain: 8 })
  // Somebody else's hit, which must not reach ME's score.
  await attack({ attacker_id: QUIET, attacker_name: 'Quiet', respect_gain: 30, chain: 4 })
}, 30000)

afterAll(async () => { await stack?.close() })

describe('the token', () => {
  it('is required, and one message for missing or wrong', async () => {
    expect((await get(`?war=${WAR}&member=${ME}`, null)).status).toBe(401)
    expect((await get(`?war=${WAR}&member=${ME}`, 'nope')).status).toBe(401)
    expect((await get(`?war=${WAR}&member=${ME}`)).status).toBe(200)
  })
})

describe('refusing rather than reporting half a war', () => {
  it('400s on a war that does not exist', async () => {
    const res = await get(`?war=999999&member=${ME}`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/no such war/)
  })

  it('⚠️ 400s on a war that has not ended', async () => {
    // A live war's scores are not final. Serving it is how a scoreless report
    // gets posted into a permanent record.
    await stack.db.query(
      `INSERT INTO ranked_wars (id, opponent_id, opponent_name, start_at, end_at)
       VALUES (888, $1, 'Live', $2, NULL) ON CONFLICT (id) DO NOTHING`,
      [OPP, START],
    )
    const res = await get(`?war=888&member=${ME}`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toMatch(/has not ended/)
  })

  it('400s without both parameters', async () => {
    expect((await get(`?war=${WAR}`)).status).toBe(400)
    expect((await get(`?member=${ME}`)).status).toBe(400)
  })
})

describe('the war and the member', () => {
  it('carries the war with timestamps in epoch MS', async () => {
    const b = await report(`?war=${WAR}&member=${ME}`)
    // ⚠️ start_at/end_at are epoch SECONDS in the column. A report placing the
    // war in 1970 is the symptom of reading them as ms.
    expect(b.war.start_ms).toBe(START * 1000)
    expect(b.war.end_ms).toBe(END * 1000)
    expect(b.war.our_score).toBe(5412)
    expect(b.war.is_termed).toBe(false)
  })

  it('names the member from the attack rows', async () => {
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.member).toEqual({ id: ME, name: 'Me' })
  })
})

describe('the score', () => {
  it('counts only this member\'s scoring hits, and caps the bonus one', async () => {
    const b = await report(`?war=${WAR}&member=${ME}`)
    // 20.5 + 85.25 raw; the chain-100 hit normalises to 10.
    expect(b.score.raw).toBe(105.75)
    expect(b.score.normalised).toBe(30.5)
    expect(b.score.bonus_reduction).toBe(75.25)
    expect(b.score.hits).toBe(2)
    expect(b.score.bonus_hits).toBe(1)
  })

  it('does not leak another member\'s hits', async () => {
    const b = await report(`?war=${WAR}&member=${QUIET}`)
    expect(b.score.raw).toBe(30)
    expect(b.score.hits).toBe(1)
  })
})

describe('⚠️ absence is never zero', () => {
  const setDibsJob = (enabled: boolean) =>
    stack.db.query(
      `INSERT INTO scraper_jobs (job_name, cron_schedule, enabled) VALUES ($1, NULL, $2)
       ON CONFLICT (job_name) DO UPDATE SET enabled = $2`,
      ['dibs-summary', enabled],
    )

  it('⚠️ dibs is "disabled" when this tenant does not run the job', async () => {
    // THE case that is live right now: `dibs-summary` is enabled on one of five
    // tenants. On the others no amount of waiting produces numbers, so the
    // report must ship saying tracking is off — not be held for a measurement
    // that is never coming, and not render "0 claims", which would be a false
    // claim about a named person.
    await setDibsJob(false)
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.dibs.state).toBe('disabled')
    expect(b.dibs.counts).toBeNull()
  })

  it('⚠️ "disabled" beats "pending" when there is no state row either', async () => {
    // A disabled tenant also has no state row. Testing the state row first
    // would call every such war `pending` for ever, and a wrap-up that fails
    // loudly on `pending` would then never complete on four of five tenants.
    await setDibsJob(false)
    await stack.db.query('DELETE FROM war_dibs_summary_state WHERE war_id = $1', [WAR])
    expect((await report(`?war=${WAR}&member=${ME}`)).dibs.state).toBe('disabled')
  })

  it('dibs is "pending" when the job is on but has not run for this war', async () => {
    // Distinct from disabled because the action differs: this wrap-up is NOT
    // finished, and posting now would be premature.
    await setDibsJob(true)
    await stack.db.query('DELETE FROM war_dibs_summary_state WHERE war_id = $1', [WAR])
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.dibs.state).toBe('pending')
    expect(b.dibs.counts).toBeNull()
  })

  it('dibs is a measured zero once the war HAS been summarised', async () => {
    await setDibsJob(true)
    await stack.db.query(
      `INSERT INTO war_dibs_summary_state (war_id, claims_seen, grace_seconds)
       VALUES ($1, 0, 120) ON CONFLICT (war_id) DO NOTHING`,
      [WAR],
    )
    const b = await report(`?war=${WAR}&member=${ME}`)
    // ⚠️ A genuine zero, and the only legitimate one: the job ran, saw their
    // claims, and there were none — "no dibs history found" rather than "not
    // counted". The grace window that produced it travels with the numbers.
    expect(b.dibs.state).toBe('measured')
    expect(b.dibs.counts.claims).toBe(0)
    expect(b.dibs.grace_seconds).toBe(120)
    expect(b.dibs.measured_ms).toBeGreaterThan(0)
  })

  it('dibs carries the real row when there is one', async () => {
    await setDibsJob(true)
    await stack.db.query(
      `INSERT INTO war_dibs_summary (war_id, member_id, member_name, claims, converted, taken_from)
       VALUES ($1, $2, 'Me', 7, 5, 2)
       ON CONFLICT DO NOTHING`,
      [WAR, ME],
    )
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.dibs.state).toBe('measured')
    expect(b.dibs.counts.claims).toBe(7)
    expect(b.dibs.counts.converted).toBe(5)
    expect(b.dibs.counts.taken_from).toBe(2)
  })

  it('roll call is null when they never answered', async () => {
    const b = await report(`?war=${WAR}&member=${ABSENT}`)
    expect(b.roll_call).toBeNull()
  })

  it('⚠️ roll call says responded:true — the field the FORMATTER reads', async () => {
    // THE bug this test exists for. The first version returned the raw
    // `war_room_roll_call_v2` row, and the bot's `roll_call_line` reads
    // `responded` — so a member who had answered, with on_at_start=true and
    // availability='on_time' sitting in the database, was rendered in their own
    // permanent thread as "no answer recorded". Shipping raw column names makes
    // the bot responsible for a schema it cannot see.
    await stack.db.query(
      `INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start, availability)
       VALUES ($1, $2, 'Quiet', true, 'on_time')`,
      [WAR, QUIET])
    const b = await report(`?war=${WAR}&member=${QUIET}`)
    expect(b.roll_call.responded).toBe(true)
    // ⚠️ And a first-action offset, which the formatter reads to say whether
    // they turned up. Null here is "no attack to measure", never "did not show".
    expect(b.roll_call).toHaveProperty('first_action_offset_sec')
    expect(b.roll_call.on_at_start).toBe(true)
    expect(b.roll_call.availability).toBe('on_time')
  })

  it('⚠️ roll call distinguishes "never answered" from "said no"', async () => {
    await stack.db.query(
      `INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start, availability)
       VALUES ($1, $2, 'Me', false, 'unavailable')`,
      [WAR, ME],
    )
    const said = await report(`?war=${WAR}&member=${ME}`)
    const never = await report(`?war=${WAR}&member=${ABSENT}`)
    // Said no: a row, with false in it. Never answered: no row at all.
    expect(said.roll_call.on_at_start).toBe(false)
    expect(said.roll_call.availability).toBe('unavailable')
    expect(never.roll_call).toBeNull()
  })

  it('⚠️ unreadable stacks send energy NULL, not 0', async () => {
    // The sibling of the roll-call bug, and the sharper one: the first version
    // sent `energy_current` — which the formatter does not read — so it printed
    // "0 energy" for a member whose real energy was 965. `has_reading` exists
    // precisely because a blank energy cell reads as zero in a spreadsheet, and
    // sending 0 here reproduces that error in a permanent per-member record.
    expect((await report(`?war=${WAR}&member=${ABSENT}`)).stacks).toBeNull()
    await stack.db.query(
      `INSERT INTO war_stacks_snapshot
         (war_id, member_id, member_name, energy_current, energy_maximum,
          has_reading, od_flagged_prewar, captured_at)
       VALUES ($1, $2, 'Me', 0, 1000, false, false, now())`,
      [WAR, ME],
    )
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.stacks.has_reading).toBe(false)
    expect(b.stacks.energy).toBeNull()
  })

  it('readable stacks send the real energy under the key the formatter reads', async () => {
    await stack.db.query(
      `INSERT INTO war_stacks_snapshot
         (war_id, member_id, member_name, energy_current, energy_maximum,
          has_reading, od_flagged_prewar, captured_at)
       VALUES ($1, $2, 'Quiet', 965, 150, true, true, now())`,
      [WAR, QUIET],
    )
    const b = await report(`?war=${WAR}&member=${QUIET}`)
    expect(b.stacks.energy).toBe(965)
    expect(b.stacks.has_reading).toBe(true)
    expect(b.stacks.overdosed).toBe(true)
  })
  it('⚠️ a member with no hits scored ZERO — the ledger is populated', async () => {
    // Not null. "Score · not recorded" reads as a broken scraper; this member
    // simply did not attack, which is keep-or-kick evidence rather than an
    // error. MonChoon: "if they had a 0, we should just show 0."
    const b = await report(`?war=${WAR}&member=999999`)
    expect(b.score).not.toBeNull()
    expect(b.score.raw).toBe(0)
    expect(b.score.hits).toBe(0)
    expect(b.war.id).toBe(WAR)
  })
})


// ⚠️ THE test that would have caught the field-name mismatch that shipped.
//
// The formatter in `torn-discord-bot` reads specific keys. Its own 23 tests all
// passed, because they exercise the MOCK's shape — nothing asserted that what
// this endpoint actually sends matches what the formatter actually reads. Two
// mismatches reached production: `responded` and `energy`.
describe('⚠️ the contract the bot formatter reads', () => {
  // Kept in step by hand with member_report_format.py. A literal list, because
  // the whole failure was a key that existed on one side and not the other.
  const ROLL_CALL_KEYS = [
    'responded', 'on_at_start', 'availability', 'can_self_hospital',
    'needs_merc', 'revised', 'first_action_offset_sec',
  ]
  const STACKS_KEYS = ['energy', 'has_reading', 'overdosed']

  it('roll_call carries every key the formatter reads', async () => {
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.roll_call).not.toBeNull()
    for (const k of ROLL_CALL_KEYS) expect(b.roll_call).toHaveProperty(k)
  })

  it('stacks carries every key the formatter reads', async () => {
    const b = await report(`?war=${WAR}&member=${QUIET}`)
    expect(b.stacks).not.toBeNull()
    for (const k of STACKS_KEYS) expect(b.stacks).toHaveProperty(k)
  })

  it('⚠️ does NOT leak raw column names the formatter would ignore', async () => {
    // `energy_current` reaching the bot is how "965 energy" became "0 energy":
    // the formatter looked for `energy`, found nothing, and printed a zero.
    const b = await report(`?war=${WAR}&member=${QUIET}`)
    expect(b.stacks).not.toHaveProperty('energy_current')
    expect(b.stacks).not.toHaveProperty('od_flagged_prewar')
  })

  it('carries a binned chart the bot can draw', async () => {
    const b = await report(`?war=${WAR}&member=${ME}`)
    expect(b.summary).not.toBeNull()
    expect(b.chart).not.toBeNull()
    expect(b.chart.bin_seconds).toBeGreaterThan(0)
    expect(Array.isArray(b.chart.x_ms)).toBe(true)
    expect(Array.isArray(b.chart.panels)).toBe(true)
    // ⚠️ Member-scoped: the point is one member's attacks over time, not the
    // faction's. A faction-wide chart in a personal thread is the wrong picture
    // beside the right numbers.
    expect(b.chart.panels.length).toBeGreaterThan(0)
  })
})
