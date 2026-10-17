// The attack-log parser (#974). Fixtures use the EXACT line formats seen in 35
// real forge logs (2026-10-17), with the names changed.
import { describe, expect, it } from 'vitest'
import { parseAttackLog, actorOf, PARSER_VERSION } from '../src/events/attackLogParser.js'

const A = 100, D = 200
const atk = { attacker_id: A, defender_id: D, member_id: A, outgoing: true }
const line = (action: string, icon: string, text: string, attacker: number | null = A, defender: number | null = D) => ({
  text, timestamp: 1, action, icon: `attacking-events-${icon}`,
  attacker: attacker == null ? null : { id: attacker, name: `p${attacker}`, item: null },
  defender: defender == null ? null : { id: defender, name: `p${defender}` },
})
const body = (log: any[], summary: any[] = []) => ({ pages: [{ attacklog: { log, summary }, _metadata: { links: { next: null } } }] })

const MUG_FIGHT = body([
  line('startfight', 'attack-join', 'Ann initiated an attack against Bob'),
  line('hit', 'standart-damage', 'Ann fired 3 rounds of his Benelli M4 Super hitting Bob in the Right hand for 321'),
  line('hit', 'standart-damage', 'Bob fired 10 IN rounds of his Qsz-92 hitting Ann in the Right leg for 212', D, A),
  line('critical hit', 'powerful', 'Ann fired 2 rounds of her Enfield SA-80 critically hitting Bob in the Head for 2,286'),
  line('won', 'attack-win', 'Ann fired 1 round of his Benelli M4 Super hitting Bob in the Left leg for 593'),
  line('mug', 'mug', 'Ann mugged Bob for $1,791,890 (+2.90)'),
  line('mug', 'plunder', 'Plunder increased money mugged by 20.23%'),
], [
  { id: A, name: 'Ann', hits: 3, misses: 0, damage: 3200 },
  { id: D, name: 'Bob', hits: 1, misses: 2, damage: 212 },
])

describe('parseAttackLog', () => {
  it('reads the mug amount, respect and every hit', () => {
    const p = parseAttackLog(MUG_FIGHT, atk)
    expect(p.mug_amount).toBe(1_791_890)
    expect(p.respect).toBe(2.9)
    expect(p.hit_damages).toEqual([321, 2286, 593])
    expect(p.biggest_hit).toBe(2286)
  })

  it('takes damage dealt and taken from Torn\'s own summary', () => {
    const p = parseAttackLog(MUG_FIGHT, atk)
    expect([p.damage_dealt, p.damage_taken, p.hits, p.misses]).toEqual([3200, 212, 3, 0])
  })

  it('⚠️ finds procs by ICON — a proc line and a proc hit alike', () => {
    const p = parseAttackLog(MUG_FIGHT, atk)
    expect(p.effects.map((e) => [e.effect, e.actor_id])).toEqual([['powerful', A], ['plunder', A]])
  })

  it('⚠️ counts the start of a bleed, not every tick of it', () => {
    const p = parseAttackLog(body([
      line('hit', 'standart-damage', 'Ann hit Bob with his Kodachi in the Left hand for 400'),
      line('hit', 'bleeding', 'Bob began bleeding'),
      line('hit', 'bleeding', 'Bleeding damaged Bob for 106'),
      line('hit', 'bleeding', 'Bleeding damaged Bob for 94'),
    ]), atk)
    expect(p.effects.map((e) => e.effect)).toEqual(['bleeding'])
    expect(p.hit_damages).toEqual([400])
  })

  it('reads a proc that is its own line after the finishing hit', () => {
    const p = parseAttackLog(body([
      line('hosp', 'hospitalize', 'Ann hospitalized Bob (+1.59)'),
      line('hosp', 'stricken', "Stricken increased Bob's hospital time by 68.19%"),
    ]), atk)
    expect(p.effects).toEqual([{ seq: 1, actor_id: A, effect: 'stricken', text: "Stricken increased Bob's hospital time by 68.19%" }])
    expect(p.respect).toBe(1.59)
  })

  it('⚠️ an unseen proc is counted under its own icon — no guessed wording', () => {
    const p = parseAttackLog(body([line('hit', 'revitalize', 'something Torn writes')]), atk)
    expect(p.effects[0].effect).toBe('revitalize')
  })

  it('does not credit the defender\'s hits, procs or a mug they never made', () => {
    const p = parseAttackLog(body([
      line('hit', 'riot', 'Bob hit Ann with his Meat Hook in the Stomach for 424', D, A),
      line('lost', 'attack-win', 'Ann lost to Bob'),
    ]), atk)
    expect(p.hit_damages).toEqual([])
    expect(p.effects[0].actor_id).toBe(D)
    expect(p.mug_amount).toBeNull()
  })

  it('⚠️ attributes a stealthed attacker\'s lines by the stored attack, not "Someone"', () => {
    const p = parseAttackLog(body([
      line('hit', 'standart-damage', 'Someone fired 3 rounds of their Benelli M4 Super hitting Bob in the Right hand for 94', null, D),
      line('mug', 'mug', 'Someone mugged Bob for $28 (+2.61)', null, D),
    ], [{ id: null, name: null, hits: 1, misses: 0, damage: 94 }, { id: D, name: 'Bob', hits: 0, misses: 1, damage: 0 }]), atk)
    expect(p.hit_damages).toEqual([94])
    expect(p.mug_amount).toBe(28)
    expect(p.damage_dealt).toBe(94)
  })

  it('reads an incoming attack from our defender\'s side', () => {
    const inc = { attacker_id: D, defender_id: A, member_id: A, outgoing: false }
    const p = parseAttackLog(body([
      line('hit', 'standart-damage', 'Bob hit Ann with his Kodachi in the Chest for 805', D, A),
      line('hit', 'standart-damage', 'Ann hit Bob with his Kodachi in the Chest for 300', A, D),
      line('mug', 'mug', 'Bob mugged Ann for $5,000 (+2.00)', D, A),
    ], [{ id: D, hits: 1, misses: 0, damage: 805 }, { id: A, hits: 1, misses: 0, damage: 300 }]), inc)
    expect(p.hit_damages).toEqual([300])
    expect(p.damage_dealt).toBe(300)
    expect(p.damage_taken).toBe(805)
    // The mug is THEIRS, recorded as the attack's — the report decides whose.
    expect(p.mug_amount).toBe(5000)
  })

  it('copes with an empty or malformed log', () => {
    const p = parseAttackLog({}, atk)
    expect(p).toMatchObject({ mug_amount: null, biggest_hit: null, effects: [] })
  })

  it('has a version, so a changed parser re-runs over the archive', () => {
    expect(PARSER_VERSION).toBe(2)
  })
})

describe('v2 — from ~2,000 real forge logs', () => {
  it('⚠️ drops outcomes, loot, boosters, stances and recoil — none is an effect', () => {
    const p = parseAttackLog(body([
      line('lost', 'attack-lose', 'Ann lost to Bob', A, D),
      line('stalemate', 'stalemate', 'Ann stalemated with Bob', A, D),
      line('loot', 'loot', 'Ann looted 2x Concussion Grenade from Bob', A, D),
      line('hit', 'booster-use', 'Ann injected a syringe of Melatonin into her arm', A, D),
      line('onItemUseEff', 'smash-wait', 'Ann lifts  his Sledgehammer off the ground', A, D),
      line('onItemUseEff', 'windup', 'Ann wound up her Naval Cutlass lifting it above her head', A, D),
      line('hit', 'hazadous', "The Nock Gun's recoil damages Ann for 40", A, D),
    ]), atk)
    expect(p.effects).toEqual([])
  })

  it('⚠️ counts a burn once, not on every multi-word tick', () => {
    const p = parseAttackLog(body([
      line('hit', 'severe-burning', 'Bob is set ablaze', A, D),
      line('hit', 'severe-burning', 'Molotov Cocktail scorches Bob for 807', A, D),
      line('hit', 'severe-burning', 'Severe burning damaged Bob for 80', A, D),
    ]), atk)
    expect(p.effects.map((e) => e.effect)).toEqual(['severe-burning'])
  })

  it('⚠️ credits a parry and No Touching to the defender, as the text shows', () => {
    const p = parseAttackLog(body([
      line('hit', 'parry', 'Ann hit Bob with his Diamond Bladed Knife but it was parried', A, D),
      line('missed', 'notouching', 'Ann missed Bob with his Yasukuni Sword', A, D),
      line('hit', 'riot', 'Ann smashed Bob with his Sledgehammer in the Chest for 300', A, D),
    ]), atk)
    expect(p.effects.map((e) => [e.effect, e.actor_id])).toEqual([['parry', D], ['notouching', D], ['riot', A]])
  })
})

describe('actorOf', () => {
  it('uses the line\'s attacker when Torn names one', () => {
    expect(actorOf(line('hit', 'x', 't', 7, D), atk)).toBe(7)
  })
  it('falls back to the attack\'s attacker for a stealthed hit on its defender', () => {
    expect(actorOf(line('hit', 'x', 't', null, D), atk)).toBe(A)
    expect(actorOf(line('hit', 'x', 't', null, 999), atk)).toBeNull()
  })
})
