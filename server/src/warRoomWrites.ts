// War-room write path (slice #72) — dibs, chain save, roll call, notes.
// Ports the war-room-fetch edge handlers onto the authenticated API: the
// session identifies the actor (the old dibs flow deliberately skipped user
// verification — that hole closes here for free), the DB's partial unique
// index serializes concurrent dib claims, and every mutation that rides a
// WS channel is broadcast to connected clients immediately.
//
// Visitor semantics (read-only demo role): dibs allowed, the leads-only
// private note readable; roll call, notes, chain-save rejected.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'
import { rolesFromClaims } from './auth.js'
import { DIBS_EXPIRY_SECONDS } from './warRoomDibsExpiry.js'
import { DIBS_RELEASE_REASONS } from './warDibsReasons.js'
import { ASSIST_EXPIRY_SECONDS } from './warRoomAssistsExpiry.js'
import {
  validateLoadoutPayload,
  LOADOUT_RATE_LIMIT,
  LOADOUT_RATE_WINDOW_MS,
} from './warRoomLoadout.js'
import {
  buildJsonPayload,
  buildNukeFields,
  checkReviveTarget,
  resolveCountryFromDescription,
} from './warRoomRevive.js'
import type { WarRoomHub } from './warRoom.js'

export interface WarRoomWriteDeps {
  db: pg.Pool
  hub: WarRoomHub
}

export function registerWarRoomWriteRoutes(app: FastifyInstance, { db, hub }: WarRoomWriteDeps) {
  async function actorName(tornUserId: string): Promise<string> {
    const res = await db.query('SELECT member_name FROM members WHERE member_id = $1', [tornUserId])
    return res.rows[0]?.member_name ?? `User ${tornUserId}`
  }

  async function serverNow(): Promise<string> {
    const res = await db.query('SELECT now() AS n')
    return res.rows[0].n
  }

  const isAdmin = (req: any) => rolesFromClaims(req.session!).includes('admin')

  /**
   * War leads and up (#617).
   *
   * ⚠️ Deliberately WIDER than isAdmin and narrower than "logged in": the war
   * room is run by war leads, so gating a war-room action on the `admin` role
   * alone would put it out of reach of the people whose job it is. Mirrors
   * canSeeLeadOnlyChannels in warRoom.ts.
   *
   * ⚠️ An ALLOW-LIST, which is why removing the `visitor` role (#922) needed no
   * replacement: the explicit reject above it only ever mattered for somebody
   * holding visitor AND a lead role at once, which the schema no longer permits.
   */
  const isLead = (req: any) => {
    const roles = rolesFromClaims(req.session!)
    return roles.some((r) => r === 'warlead' || r === 'leadership' || r === 'admin')
  }

  // ── Dibs ────────────────────────────────────────────────────────────────
  // ⚠️ Any authenticated member may claim. This used to be the single mutation
  // the read-only `visitor` role was allowed, which is why it takes
  // `requireAuth()` rather than a role check; #922 removed that role, and the
  // open-to-all-members behaviour is deliberate on its own merits — dibs is how
  // the whole faction coordinates targets.
  app.post('/api/war-room/dibs', { preHandler: requireAuth() }, async (req, reply) => {
    const body = req.body as {
      target_id?: unknown; war_id?: unknown; ff_shown?: unknown; ff_estimated?: unknown
    } | null
    const targetId = Number(body?.target_id)
    // #997 — what the holder's own page SHOWED. Optional: a claim from
    // somewhere that cannot compute FF stores null, never a guess. Bounded so
    // a bad client cannot store nonsense against a member's name.
    const ffRaw = Number(body?.ff_shown)
    const ffShown = body?.ff_shown != null && Number.isFinite(ffRaw) && ffRaw >= 1 && ffRaw < 1000
      ? Math.round(ffRaw * 100) / 100 : null
    const ffEstimated = ffShown == null ? null : body?.ff_estimated === true
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.status(400).send({ error: 'target_id required' })
    }
    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)

    const dbc = await db.connect()
    try {
      await dbc.query('BEGIN')
      const existing = await dbc.query(
        `SELECT claimed_by, claimed_name FROM war_room_dibs_v2
         WHERE target_id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [targetId]
      )
      if (existing.rows.length > 0 && Number(existing.rows[0].claimed_by) !== userId) {
        await dbc.query('ROLLBACK')
        return reply.status(409).send({
          error: `Already claimed by ${existing.rows[0].claimed_name}`,
          owner: { id: Number(existing.rows[0].claimed_by), name: existing.rows[0].claimed_name },
        })
      }
      // Single-dibs rule: tombstone the caller's other live claims (and a
      // re-claim of the same target) before inserting the fresh row.
      // ⚠️ #530 — `superseded`, not `manual`: the holder did not give this claim
      // back, they moved to another target and the single-dibs rule took it. Read
      // often enough against one member, that pattern is target-hopping, which is
      // a different thing from releasing a target you decided against.
      const tombstoned = await dbc.query(
        `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now(),
           release_reason = '${DIBS_RELEASE_REASONS.superseded}'
         WHERE claimed_by = $1 AND deleted_at IS NULL RETURNING *`,
        [userId]
      )
      // #159: if the target is already alive (Okay) at claim time, start the
      // auto-drop countdown — dibs_expiry_seconds out — so a claim the holder
      // never converts frees up. A target still in hospital gets no claim-time
      // deadline; the #106 hospital-exit window governs that case instead.
      // ⚠️ #935 — `last_action` comes along for the ride. The status read was
      // already here for `targetAlive`, so recording whether the target was AT
      // THE KEYBOARD costs nothing extra, and a claim taken on an already-green
      // target never reserved anything.
      const ctx = await dbc.query(
        `SELECT (SELECT dibs_expiry_seconds FROM war_room_config_v2 WHERE id = 1) AS secs,
                (SELECT state->'status'->>'state' FROM war_room_state_v2 WHERE member_id = $1) AS status,
                (SELECT state->'last_action'->>'status' FROM war_room_state_v2 WHERE member_id = $1) AS online`,
        [targetId]
      )
      const expirySecs = Number(ctx.rows[0]?.secs ?? DIBS_EXPIRY_SECONDS)
      const targetAlive = ctx.rows[0]?.status === 'Okay'
      const inserted = await dbc.query(
        // ⚠️ #935 — `claim_state` / `claim_online` are stored AS OBSERVED, never
        // as a verdict. `claimKind()` interprets them, so the rule can change
        // without a migration and without rewriting history.
        `INSERT INTO war_room_dibs_v2
           (target_id, claimed_by, claimed_name, war_id, auto_expire_at, claim_state, claim_online,
            ff_shown, ff_shown_estimated)
         VALUES ($1, $2, $3, $4,
                 CASE WHEN $5 THEN now() + make_interval(secs => $6) ELSE NULL END,
                 $7, $8, $9, $10)
         RETURNING *`,
        [targetId, userId, name, body?.war_id ?? null, targetAlive, expirySecs,
         ctx.rows[0]?.status ?? null, ctx.rows[0]?.online ?? null, ffShown, ffEstimated]
      )
      await dbc.query('COMMIT')
      hub.broadcast('dibs', [...tombstoned.rows, ...inserted.rows], await serverNow())
      return { ok: true }
    } catch (err: any) {
      await dbc.query('ROLLBACK')
      // The partial unique index is the last word under true races.
      if (err?.code === '23505') {
        const owner = await db.query(
          `SELECT claimed_by, claimed_name FROM war_room_dibs_v2
           WHERE target_id = $1 AND deleted_at IS NULL`,
          [targetId]
        )
        return reply.status(409).send({
          error: `Already claimed by ${owner.rows[0]?.claimed_name ?? 'someone else'}`,
          owner: owner.rows[0]
            ? { id: Number(owner.rows[0].claimed_by), name: owner.rows[0].claimed_name }
            : null,
        })
      }
      throw err
    } finally {
      dbc.release()
    }
  })

  app.delete('/api/war-room/dibs/:targetId', { preHandler: requireAuth() }, async (req) => {
    const { targetId } = req.params as { targetId: string }
    const userId = Number(req.session!.torn_user_id)
    // Non-admins release only their own claim (a filtered no-op otherwise).
    // ⚠️ #530 — a lead releasing their OWN claim is `manual`, not `admin`. The
    // admin branch is the only one that can touch somebody else's row, so the
    // reason is decided per row by who held it, not by which branch ran. Getting
    // this backwards would file every lead's own release under moderation.
    const res = isAdmin(req)
      ? await db.query(
          `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now(),
             release_reason = CASE WHEN claimed_by = $2
               THEN '${DIBS_RELEASE_REASONS.manual}'
               ELSE '${DIBS_RELEASE_REASONS.admin}' END
           WHERE target_id = $1 AND deleted_at IS NULL RETURNING *`,
          [targetId, userId]
        )
      : await db.query(
          `UPDATE war_room_dibs_v2 SET deleted_at = now(), updated_at = now(),
             release_reason = '${DIBS_RELEASE_REASONS.manual}'
           WHERE target_id = $1 AND deleted_at IS NULL AND claimed_by = $2 RETURNING *`,
          [targetId, userId]
        )
    if (res.rows.length > 0) hub.broadcast('dibs', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Assist requests (#523) ─────────────────────────────────────────────
  // Attacker-set, live "raise a hand" markers — smoke/tear/help against
  // (requester, target), from the attack page. Open to any authenticated
  // member, same reasoning as dibs: it is how the faction coordinates.
  const ASSIST_KINDS = new Set(['smoke', 'tear', 'help'])
  // What the fight log can report. `join` is the log's word for what a request
  // calls `help`; smoke and tear share their names with the request kinds.
  const OBSERVED_KINDS = new Set(['smoke', 'tear', 'join'])

  /**
   * ⚠️ #617: the count belongs to the TARGET, and every kind coexists.
   *
   * Pressing adds one to that kind's count for that target, whoever presses.
   * The old rule — one live request per requester, a fresh press replacing
   * whatever you last asked for — modelled the wrong thing: a request is a
   * property of the fight, not of the person who happened to type it. Two
   * people can independently know a target needs two more smokes, and the
   * second one saying so must not erase the first.
   *
   * The reinforcement case is the sharpest: whoever joined is now IN the fight
   * and is best placed to say more help is needed — and under the old rule
   * their request cancelled the one that brought them.
   */
  app.post('/api/war-room/assist', { preHandler: requireAuth() }, async (req, reply) => {
    const body = req.body as { target_id?: unknown; kind?: unknown; war_id?: unknown } | null
    const targetId = Number(body?.target_id)
    const kind = String(body?.kind ?? '')
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.status(400).send({ error: 'target_id required' })
    }
    if (!ASSIST_KINDS.has(kind)) {
      return reply.status(400).send({ error: `kind must be one of ${[...ASSIST_KINDS].join(', ')}` })
    }
    const userId = Number(req.session!.torn_user_id)

    // ⚠️ Column names are built from `kind`, so the ASSIST_KINDS check above is
    // load-bearing rather than merely a nicety — it is what keeps an attacker
    // out of this string.
    const wantedCol = `${kind}_wanted`
    const raisedCol = `${kind}_raised_at`

    const dbc = await db.connect()
    try {
      await dbc.query('BEGIN')
      // #591: the expiry window is a faction setting, returned to the caller
      // so the overlay can show how long a request has left.
      //
      // ⚠️ It no longer ARMS anything. Under #523 this value was written onto
      // the row as auto_expire_at, so reading it in the transaction mattered;
      // since #617 the row stores only when the kind was raised and the sweep
      // applies the window itself, which is what keeps a settings change from
      // meaning one thing to the raise and another to the sweep.
      const cfg = await dbc.query(
        'SELECT assist_expiry_seconds AS secs FROM war_room_config_v2 WHERE id = 1'
      )
      const rawSecs = Number(cfg.rows[0]?.secs)
      const expirySecs = Number.isFinite(rawSecs) ? rawSecs : ASSIST_EXPIRY_SECONDS

      // ⚠️ `help_raised_by` is appended to only for `help`, and never shown. It
      // exists so the #591 rule survives: whoever asked for help cannot answer
      // it by turning up themselves, and with the count shared there is no
      // requester_id left to check. A smoke you throw after asking for three is
      // genuinely one of the three, which is why grenades are not tracked.
      const row = await dbc.query(
        `INSERT INTO war_room_assist_counts_v2 (target_id, war_id, ${wantedCol}, ${raisedCol}, help_raised_by)
         VALUES ($1, $2, 1, now(), CASE WHEN $3::text = 'help' THEN ARRAY[$4::bigint] ELSE '{}'::bigint[] END)
         ON CONFLICT (target_id) DO UPDATE SET
           ${wantedCol} = war_room_assist_counts_v2.${wantedCol} + 1,
           ${raisedCol} = now(),
           war_id = COALESCE(EXCLUDED.war_id, war_room_assist_counts_v2.war_id),
           help_raised_by = CASE
             WHEN $3::text = 'help' AND NOT ($4::bigint = ANY(war_room_assist_counts_v2.help_raised_by))
               THEN war_room_assist_counts_v2.help_raised_by || $4::bigint
             ELSE war_room_assist_counts_v2.help_raised_by END,
           updated_at = now()
         RETURNING *`,
        [targetId, body?.war_id ?? null, kind, userId]
      )
      await dbc.query('COMMIT')
      hub.broadcast('assist', row.rows, await serverNow())
      // The overlay paints the count straight off this response (#603).
      return { ok: true, wanted: Number(row.rows[0][wantedCol]), expiry_seconds: expirySecs }
    } catch (err) {
      await dbc.query('ROLLBACK')
      throw err
    } finally {
      dbc.release()
    }
  })

  /**
   * Observed fight-log actions, which decrement the matching requests (#591).
   *
   * The userscript parses Torn's attack-page log and posts what it saw. This is
   * the honest signal an assist counter needs: a button press means "I intend
   * to", which is not the same as going.
   *
   * ⚠️ Everything that decides whether an event COUNTS lives here, not in the
   * script, for two reasons. The attack page has no roster, so the script
   * cannot tell one of ours from an enemy — and the names it sends are text
   * scraped from a page other players can influence, so the faction check has
   * to happen somewhere the caller cannot reach.
   *
   * Three gates, in order:
   *   1. the actor NAME must resolve to a member on the war roster
   *   2. that member must be in OUR faction — anyone can join a Torn fight, and
   *      an enemy join carries the identical event class to a member helping
   *   3. the event must not already have been counted (see the dedupe ledger)
   */
  app.post('/api/war-room/assist/observed', { preHandler: requireAuth() }, async (req, reply) => {
    const body = req.body as { target_id?: unknown; events?: unknown } | null
    const targetId = Number(body?.target_id)
    const events = Array.isArray(body?.events) ? body!.events as any[] : null
    if (!Number.isFinite(targetId) || targetId <= 0 || !events) {
      return reply.status(400).send({ error: 'target_id and events[] required' })
    }
    const reportedBy = Number(req.session!.torn_user_id)

    const cfg = await db.query('SELECT torn_faction_id::text AS id FROM faction_config LIMIT 1')
    const ourFaction = String(cfg.rows[0]?.id ?? '')

    let counted = 0
    for (const raw of events.slice(0, 50)) {
      const kind = String(raw?.kind ?? '')
      const actorName = String(raw?.actor_name ?? '').trim()
      const subjectName = String(raw?.subject_name ?? '').trim()
      const atMs = Number(raw?.at_ms)
      if (!OBSERVED_KINDS.has(kind) || !actorName || !Number.isFinite(atMs)) continue

      // Gate 0 (#618): the event must be about THIS target.
      //
      // The script used to decide this itself, by scraping the defender's name
      // off the attack page and comparing strings. That name came from
      // `a[href*="profiles.php?XID="]`, a link the page does not reliably
      // render — when it was missing the script reported NOTHING at all, and a
      // real smoke went uncounted with every other part working.
      //
      // Resolved here instead, on ids against the roster, for exactly the
      // reason the actor's faction already is: the attack page has no roster
      // and the names on it are attacker-controlled text, so the client cannot
      // answer this honestly. Absent subject_name means an older script that
      // still filters client-side; those reports are accepted as before rather
      // than being silently dropped by an upgrade they did not take.
      if (subjectName) {
        const subject = await db.query(
          `SELECT member_id FROM war_room_state_v2
           WHERE member_name = $1 AND deleted_at IS NULL LIMIT 1`,
          [subjectName]
        )
        if (Number(subject.rows[0]?.member_id) !== targetId) continue
      }
      // Second resolution on purpose: two observers' clocks will not agree to
      // the millisecond, and rounding is what makes their reports collide on
      // the unique index instead of both counting.
      const eventSecond = Math.floor(atMs / 1000)

      // Gates 1 and 2. war_room_state_v2 carries BOTH sides of the war, so the
      // faction comparison is the only thing separating a member from a foe.
      const actor = await db.query(
        `SELECT member_id, faction_id::text AS faction_id FROM war_room_state_v2
         WHERE member_name = $1 AND deleted_at IS NULL LIMIT 1`,
        [actorName]
      )
      const actorId = Number(actor.rows[0]?.member_id)
      if (!Number.isFinite(actorId)) continue
      if (String(actor.rows[0]?.faction_id) !== ourFaction) continue

      // Gate 3. The insert IS the dedupe: a conflict means someone already
      // reported this exact event, and no request should move.
      const claimed = await db.query(
        `INSERT INTO war_room_assist_observations_v2
           (target_id, actor_id, actor_name, kind, event_second, reported_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (target_id, actor_id, kind, event_second) DO NOTHING
         RETURNING id`,
        [targetId, actorId, actorName, kind, eventSecond, reportedBy]
      )
      if (claimed.rowCount === 0) continue

      // A `join` answers a `help` request: the log says "joined the fight",
      // the request says "help", and they are the same thing named twice.
      const wants = kind === 'join' ? 'help' : kind
      const col = `${wants}_wanted`

      // ⚠️ Someone who asked for help cannot answer it by turning up: they were
      // already in the fight, and their own join would otherwise cancel the
      // request the moment they made it. With the count shared (#617) there is
      // no requester_id, so this checks the contributor list the raise keeps.
      //
      // Grenades are NOT excluded this way: a smoke you throw yourself after
      // asking for three is genuinely one of the three.
      //
      // ⚠️ GREATEST(...,0) as well as the WHERE guard. The CHECK constraint
      // forbids a negative count, so an observation arriving against a count
      // already at zero would abort the whole request rather than being the
      // no-op it should be.
      const dropped = await db.query(
        `UPDATE war_room_assist_counts_v2
         SET ${col} = GREATEST(${col} - 1, 0), updated_at = now()
         WHERE target_id = $1 AND ${col} > 0
           AND NOT ($2::text = 'help' AND $3::bigint = ANY(help_raised_by))
         RETURNING *`,
        [targetId, wants, actorId]
      )
      if (dropped.rows.length === 0) continue
      counted++

      // ⚠️ At zero the kind simply is not being asked for any more. The ROW
      // stays while any kind is non-zero — and is broadcast either way, because
      // the client clears a badge by seeing the count reach zero, not by the
      // row disappearing.
      hub.broadcast('assist', dropped.rows, await serverNow())
    }

    return { ok: true, counted }
  })

  /**
   * Take ONE off a target's count (#600, reshaped by #617).
   *
   * The overlay's long-press. A short press raises a count; this is how you put
   * one back when three smokes were asked for and two turned up. At zero the
   * kind simply is not being asked for — "decrement to zero" and "cancel" are
   * the same act, so there is no separate rule for it.
   *
   * ⚠️ A POST, not a DELETE variant, and that is not a style choice: Torn PDA's
   * HTTP bridge exposes only PDA_httpGet/PDA_httpPost, so a DELETE cannot be
   * issued from a phone at all. This gesture lives on the attack page, which is
   * a phone surface as much as a desktop one.
   *
   * ⚠️ **Anyone in the war room may decrement, and the old "your own request
   * only" guard is gone rather than merely relaxed.** With the count shared
   * there is no "your own" left to scope to. Dibs-holder-only was considered
   * and rejected for a checkable reason: `dibs_expiry_seconds` defaults to 30,
   * so any fight lasting over half a minute — which is most of them — would
   * leave nobody able to correct the count. The tighter rule reads better and
   * fails worse.
   *
   * What still limits accidents is the gesture: a deliberate hold, costing one
   * unit that anyone can immediately re-raise. That is a much smaller
   * consequence than the old rule protected against, which was a whole request.
   */
  app.post('/api/war-room/assist/decrement', { preHandler: requireAuth() }, async (req, reply) => {
    const body = req.body as { target_id?: unknown; kind?: unknown } | null
    const targetId = Number(body?.target_id)
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.status(400).send({ error: 'target_id required' })
    }
    // ⚠️ `kind` is now required. Under the old model a requester had exactly one
    // live request, so "take one off mine" was unambiguous; a target with a
    // smoke AND a tear outstanding has no such default, and guessing would
    // silently answer the wrong call.
    const kind = String(body?.kind ?? '')
    if (!ASSIST_KINDS.has(kind)) {
      return reply.status(400).send({ error: `kind must be one of ${[...ASSIST_KINDS].join(', ')}` })
    }
    const col = `${kind}_wanted`

    const dropped = await db.query(
      `UPDATE war_room_assist_counts_v2
       SET ${col} = GREATEST(${col} - 1, 0), updated_at = now()
       WHERE target_id = $1 AND ${col} > 0
       RETURNING *`,
      [targetId]
    )
    // Nothing outstanding of that kind: the hold does nothing, which is the
    // honest answer rather than an error the overlay must render mid-fight.
    if (dropped.rows.length === 0) return { ok: true, wanted: 0, cleared: false }

    hub.broadcast('assist', dropped.rows, await serverNow())
    const wanted = Number(dropped.rows[0][col])
    return { ok: true, wanted, cleared: wanted === 0 }
  })

  /**
   * Clear every kind on a target.
   *
   * ⚠️ Leads only, where decrement is open to anyone. The two are different in
   * kind, not degree: a decrement removes one unit that anyone can re-raise,
   * while this wipes what several people independently asked for. With no
   * "your own request" left to scope it to (#617), an open blunt instrument is
   * not a reasonable default — the fine-grained action is the one that stays
   * open to everybody.
   */
  app.delete('/api/war-room/assist/:targetId', { preHandler: requireAuth() }, async (req, reply) => {
    const { targetId } = req.params as { targetId: string }
    if (!isLead(req)) {
      return reply.status(403).send({
        error: 'Clearing every request on a target is a lead action — press and hold to take one off instead.',
      })
    }
    const res = await db.query(
      `UPDATE war_room_assist_counts_v2
       SET help_wanted = 0, smoke_wanted = 0, tear_wanted = 0,
           help_raised_by = '{}', updated_at = now()
       WHERE target_id = $1 AND (help_wanted > 0 OR smoke_wanted > 0 OR tear_wanted > 0)
       RETURNING *`,
      [targetId]
    )
    if (res.rows.length > 0) hub.broadcast('assist', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Enemy loadout capture (#528 Part 2) ─────────────────────────────────
  // Written passively by the attack-page userscript once Torn reveals a
  // target's gear (mid-fight — see tnl-war-room-dibs.user.js). Append-only:
  // no dibs-style single-live-row rule here, every observation is kept and
  // the War Room reads only the latest per target (the 'loadout' channel).
  //
  // Untrusted input (#528's own warning): this is written by a client we do
  // not control, running on someone's browser against a page we do not
  // control either. validateLoadoutPayload bounds shape and size; this Map
  // bounds request RATE per member, in-process — matches feedback.ts's
  // submission-rate guard (one process per tenant, so this is enough).
  const loadoutRequests = new Map<string, number[]>()

  app.post('/api/war-room/loadout', { preHandler: requireAuth() }, async (req, reply) => {
    const userId = String(req.session!.torn_user_id)
    const now = Date.now()
    const recent = (loadoutRequests.get(userId) ?? []).filter((t) => now - t < LOADOUT_RATE_WINDOW_MS)
    if (recent.length >= LOADOUT_RATE_LIMIT) {
      return reply.status(429).send({ error: 'Too many loadout captures — please slow down.' })
    }

    const result = validateLoadoutPayload(req.body)
    if (!result.ok || !result.value) {
      return reply.status(400).send({ error: result.error ?? 'invalid loadout payload' })
    }

    const { targetId, warId, loadout } = result.value
    const name = await actorName(req.session!.torn_user_id)
    const inserted = await db.query(
      `INSERT INTO war_room_loadout_observations_v2
         (target_id, observed_by, observed_by_name, war_id, loadout)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *, observed_at AS updated_at`,
      [targetId, Number(req.session!.torn_user_id), name, warId, JSON.stringify(loadout)]
    )
    // Budget consumed only on a real write — matches feedback.ts's guard: a
    // request that fails validation (and never inserts) does not cost the
    // member anything toward their rate limit.
    recent.push(now)
    loadoutRequests.set(userId, recent)
    hub.broadcast('loadout', inserted.rows, await serverNow())
    return { ok: true }
  })

  // ── Chain save ──────────────────────────────────────────────────────────
  app.post('/api/war-room/chain-save', { preHandler: requireAuth() }, async (req, reply) => {
    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)
    const existing = await db.query(
      'SELECT save_claimed_by, save_claimed_name FROM war_room_chain_v2 WHERE id = 1'
    )
    const holder = existing.rows[0]?.save_claimed_by
    if (holder != null && Number(holder) !== userId) {
      return reply.status(409).send({
        error: `Already claimed by ${existing.rows[0].save_claimed_name}`,
        owner: { id: Number(holder), name: existing.rows[0].save_claimed_name },
      })
    }
    const res = await db.query(
      `UPDATE war_room_chain_v2 SET save_claimed_by = $1, save_claimed_name = $2,
              save_claimed_at = now(), updated_at = now()
       WHERE id = 1 RETURNING *`,
      [userId, name]
    )
    if (res.rows.length > 0) hub.broadcast('chain', res.rows, await serverNow())
    return { ok: true }
  })

  app.delete('/api/war-room/chain-save', { preHandler: requireAuth() }, async (req) => {
    const userId = Number(req.session!.torn_user_id)
    const res = isAdmin(req)
      ? await db.query(
          `UPDATE war_room_chain_v2 SET save_claimed_by = NULL, save_claimed_name = NULL,
                  save_claimed_at = NULL, updated_at = now()
           WHERE id = 1 AND save_claimed_by IS NOT NULL RETURNING *`
        )
      : await db.query(
          `UPDATE war_room_chain_v2 SET save_claimed_by = NULL, save_claimed_name = NULL,
                  save_claimed_at = NULL, updated_at = now()
           WHERE id = 1 AND save_claimed_by = $1 RETURNING *`,
          [userId]
        )
    if (res.rows.length > 0) hub.broadcast('chain', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Headline banner (#158) ───────────────────────────────────────────────
  // One active leader headline on the config singleton, broadcast live over the
  // 'config' channel. Warleads/leadership/admin set or clear it; everyone sees it.
  const HEADLINE_TONES = ['danger', 'warn', 'go', 'neutral']
  const HEADLINE_MAX = 200

  app.post('/api/war-room/headline', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async (req, reply) => {
    const body = req.body as { text?: unknown; tone?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return reply.status(400).send({ error: 'text required' })
    if (text.length > HEADLINE_MAX) return reply.status(400).send({ error: `text must be ≤ ${HEADLINE_MAX} chars` })
    const tone = typeof body?.tone === 'string' && HEADLINE_TONES.includes(body.tone) ? body.tone : 'neutral'
    const userId = Number(req.session!.torn_user_id)
    const res = await db.query(
      `INSERT INTO war_room_config_v2 (id, headline_text, headline_tone, headline_set_by, headline_set_at, updated_at)
       VALUES (1, $1, $2, $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET headline_text = EXCLUDED.headline_text,
         headline_tone = EXCLUDED.headline_tone, headline_set_by = EXCLUDED.headline_set_by,
         headline_set_at = now(), updated_at = now()
       RETURNING *`,
      [text, tone, userId]
    )
    if (res.rows.length > 0) hub.broadcast('config', res.rows, await serverNow())
    return { ok: true }
  })

  app.delete('/api/war-room/headline', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async () => {
    const res = await db.query(
      `UPDATE war_room_config_v2 SET headline_text = NULL, headline_tone = NULL,
              headline_set_by = NULL, headline_set_at = NULL, updated_at = now()
       WHERE id = 1 RETURNING *`
    )
    if (res.rows.length > 0) hub.broadcast('config', res.rows, await serverNow())
    return { ok: true }
  })

  // ── Roll call ───────────────────────────────────────────────────────────
  // Visitors excluded on submit: a roll-call row for a non-member would
  // pollute leadership's results table.
  app.post('/api/war-room/roll-call', { preHandler: requireAuth() }, async (req, reply) => {
    const d = req.body as Record<string, any> | null
    if (d?.war_id == null) return reply.status(400).send({ error: 'war_id required' })
    if (typeof d.on_at_start !== 'boolean') return reply.status(400).send({ error: 'on_at_start required' })

    const userId = Number(req.session!.torn_user_id)
    const name = await actorName(req.session!.torn_user_id)
    // Q2/Q3 only apply when not on at the start.
    const answers = {
      on_at_start: d.on_at_start,
      can_self_hospital: d.on_at_start ? null : (d.can_self_hospital ?? null),
      needs_merc: d.on_at_start ? null : (d.needs_merc ?? null),
      availability: d.on_at_start ? 'on_time' : (d.availability ?? null),
    }

    const existing = await db.query(
      `SELECT * FROM war_room_roll_call_v2 WHERE war_id = $1 AND member_id = $2`,
      [d.war_id, userId]
    )
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start,
           can_self_hospital, needs_merc, availability)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [d.war_id, userId, name, answers.on_at_start, answers.can_self_hospital,
         answers.needs_merc, answers.availability]
      )
      return { ok: true, created: true }
    }
    const prev = existing.rows[0]
    const changed =
      prev.on_at_start !== answers.on_at_start ||
      prev.can_self_hospital !== answers.can_self_hospital ||
      prev.needs_merc !== answers.needs_merc ||
      prev.availability !== answers.availability
    await db.query(
      `UPDATE war_room_roll_call_v2 SET member_name = $2, on_at_start = $3,
         can_self_hospital = $4, needs_merc = $5, availability = $6,
         revised = CASE WHEN $7 THEN true ELSE revised END, updated_at = now()
       WHERE id = $1`,
      [prev.id, name, answers.on_at_start, answers.can_self_hospital,
       answers.needs_merc, answers.availability, changed]
    )
    return { ok: true, updated: true, changed }
  })

  // Roll-call rows are member-visible (matches the legacy RLS surface): the
  // banner needs "have I answered?", the leads panel needs everyone's.
  app.get(
    '/api/war-room/roll-call',
    { preHandler: requireAuth() },
    async (req, reply) => {
      const warId = (req.query as { war_id?: string }).war_id
      if (!warId) return reply.status(400).send({ error: 'war_id required' })
      const res = await db.query(
        `SELECT * FROM war_room_roll_call_v2 WHERE war_id = $1 ORDER BY submitted_at ASC`,
        [warId]
      )
      return { responses: res.rows }
    }
  )

  // ── War notes ───────────────────────────────────────────────────────────
  // Public row is optimistically locked on updated_at; the private note
  // lives in its own table and is never on the member-readable surface.
  app.put(
    '/api/war-room/notes',
    { preHandler: [requireRole('warlead', 'leadership', 'admin')] },
    async (req, reply) => {
      const d = req.body as Record<string, any> | null
      if (d?.war_id == null) return reply.status(400).send({ error: 'war_id required' })
      const userId = Number(req.session!.torn_user_id)
      const name = await actorName(req.session!.torn_user_id)

      const publicCols = {
        opponent_faction_id: d.opponent_faction_id ?? null,
        war_type: d.war_type ?? null,
        termed_score_us: d.termed_score_us ?? null,
        termed_score_them: d.termed_score_them ?? null,
        race_target_score: d.race_target_score ?? null,
        notes_public: d.notes_public ?? null,
      }
      const expected = d.expected_updated_at ?? null

      if (expected) {
        const updated = await db.query(
          `UPDATE war_room_notes_v2 SET opponent_faction_id = $2, war_type = $3,
             termed_score_us = $4, termed_score_them = $5, race_target_score = $6,
             notes_public = $7, updated_by_id = $8, updated_by_name = $9, updated_at = now()
           WHERE war_id = $1 AND updated_at = $10 RETURNING updated_at`,
          [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
           publicCols.termed_score_us, publicCols.termed_score_them,
           publicCols.race_target_score, publicCols.notes_public, userId, name, expected]
        )
        if (updated.rows.length === 0) {
          const exists = await db.query('SELECT 1 FROM war_room_notes_v2 WHERE war_id = $1', [d.war_id])
          if (exists.rows.length > 0) {
            return reply.status(409).send({
              error: 'These notes were changed by someone else. Reload and try again.',
              conflict: true,
            })
          }
          await db.query(
            `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id, war_type, termed_score_us,
               termed_score_them, race_target_score, notes_public, updated_by_id, updated_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
             publicCols.termed_score_us, publicCols.termed_score_them,
             publicCols.race_target_score, publicCols.notes_public, userId, name]
          )
        }
      } else {
        await db.query(
          `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id, war_type, termed_score_us,
             termed_score_them, race_target_score, notes_public, updated_by_id, updated_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (war_id) DO UPDATE SET
             opponent_faction_id = EXCLUDED.opponent_faction_id, war_type = EXCLUDED.war_type,
             termed_score_us = EXCLUDED.termed_score_us, termed_score_them = EXCLUDED.termed_score_them,
             race_target_score = EXCLUDED.race_target_score, notes_public = EXCLUDED.notes_public,
             updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name,
             updated_at = now()`,
          [d.war_id, publicCols.opponent_faction_id, publicCols.war_type,
           publicCols.termed_score_us, publicCols.termed_score_them,
           publicCols.race_target_score, publicCols.notes_public, userId, name]
        )
      }

      // The private (leads-only) note rides every save; undefined leaves it alone.
      if (d.notes_private !== undefined) {
        await db.query(
          `INSERT INTO war_room_notes_private_v2 (war_id, notes, updated_by_id, updated_by_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (war_id) DO UPDATE SET notes = EXCLUDED.notes,
             updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name,
             updated_at = now()`,
          [d.war_id, d.notes_private ?? null, userId, name]
        )
      }

      const fresh = await db.query('SELECT updated_at FROM war_room_notes_v2 WHERE war_id = $1', [d.war_id])
      return { ok: true, updated_at: fresh.rows[0]?.updated_at ?? null }
    }
  )

  // Past-wars archive (#145): every war's notes joined to ranked_wars for the
  // opponent + start date, newest first. Leads only — never ordinary members.
  // The list carries only the public note; the private note stays behind the
  // per-war leads-gated endpoint below. (Static route — Fastify matches it
  // ahead of /notes/:warId.)
  app.get(
    '/api/war-room/notes/archive',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async () => {
      const res = await db.query(
        `SELECT n.war_id, n.opponent_faction_id, n.war_type, n.notes_public, n.updated_at,
                w.opponent_name, w.start_at, w.end_at
         FROM war_room_notes_v2 n
         LEFT JOIN ranked_wars w ON w.id = n.war_id
         ORDER BY COALESCE(w.start_at, 0) DESC, n.war_id DESC`
      )
      return { wars: res.rows }
    }
  )

  /**
   * History against ONE faction (#398).
   *
   * Distinct from the archive above, which lists every war we have ever noted.
   * MonChoon: "what I was really after was specifically the history with this
   * week's opponent... all of the past wars we had with that faction, namely the
   * war contribution, and then if we have any notes based on our own input on
   * the roll call."
   *
   * Three things per prior matchup, and the third is the one with no other home:
   * scores are public, contributions are Torn's, but what WE wrote about them
   * last time exists only here and is currently findable only by scrolling the
   * archive war by war.
   *
   * ⚠️ Excludes the war currently in progress. `end_at IS NULL` is a war still
   * running, and "previous matchups" that includes the one being fought would
   * read as history a lead has not lived through yet.
   *
   * Contributions are ours only. Their roster for that war is in the same table
   * and is what the roster diff uses, but it is a bigger payload and a separate
   * question — this endpoint answers "how did WE do against them".
   */
  app.get(
    '/api/war-room/history/:factionId',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async (req, reply) => {
      const { factionId } = req.params as { factionId: string }
      if (!/^\d+$/.test(factionId)) {
        return reply.status(400).send({ error: 'numeric faction id required' })
      }
      const cfg = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
      const us = Number(cfg.rows[0]?.torn_faction_id ?? 0)

      const wars = await db.query(
        `SELECT w.id AS war_id, w.start_at, w.end_at, w.our_score, w.opponent_score,
                w.opponent_name, w.winner_faction_id, w.forfeit, w.is_termed,
                n.notes_public, n.war_type, n.updated_at AS notes_updated_at,
                COALESCE((
                  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.score DESC)
                  FROM war_member_contributions c
                  WHERE c.war_id = w.id AND c.faction_id = $2
                ), '[]'::jsonb) AS our_contributions,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'member_id', r.member_id, 'member_name', r.member_name,
                           'on_at_start', r.on_at_start) ORDER BY r.member_name)
                  FROM war_room_roll_call_v2 r WHERE r.war_id = w.id
                ), '[]'::jsonb) AS roll_call
           FROM ranked_wars w
           LEFT JOIN war_room_notes_v2 n ON n.war_id = w.id
          WHERE w.opponent_id = $1 AND w.end_at IS NOT NULL
          ORDER BY w.start_at DESC`,
        [factionId, us]
      )

      // Their roster from the MOST RECENT previous war only (#398 section 2).
      //
      // Deliberately not every war in the list. "New since one of the last six
      // wars we fought" is not a fact anyone can act on, and the payload for a
      // faction we fight often would be several hundred rows to answer a
      // question about one of them.
      //
      // ⚠️ This is their war ROSTER as Torn reported it for that war, not their
      // membership at any given moment — `rows_held` runs 77–100 against a
      // 100-slot faction, so someone who joined mid-war or left before the
      // report was cut can be missing. The UI has to say "war roster".
      const lastWarId = wars.rows[0]?.war_id ?? null
      const theirRoster = lastWarId
        ? await db.query(
            `SELECT member_id, member_name, level, score, attacks
               FROM war_member_contributions
              WHERE war_id = $1 AND faction_id = $2
              ORDER BY score DESC`,
            [lastWarId, factionId]
          )
        : { rows: [] }

      return {
        wars: wars.rows,
        last_war_id: lastWarId,
        their_last_roster: theirRoster.rows,
      }
    }
  )

  app.get('/api/war-room/notes/:warId', { preHandler: requireAuth() }, async (req) => {
    const { warId } = req.params as { warId: string }
    const res = await db.query('SELECT * FROM war_room_notes_v2 WHERE war_id = $1', [warId])
    return { notes: res.rows[0] ?? null }
  })

  // ⚠️ Read-only, and lead-gated. It used to admit the `visitor` role as well
  // so an outsider could demo the full leads view (#922 removed that role).
  app.get(
    '/api/war-room/notes/:warId/private',
    { preHandler: requireRole('warlead', 'leadership', 'admin') },
    async (req) => {
      const { warId } = req.params as { warId: string }
      const res = await db.query(
        'SELECT notes, updated_at FROM war_room_notes_private_v2 WHERE war_id = $1',
        [warId]
      )
      return { ok: true, notes: res.rows[0]?.notes ?? '', updated_at: res.rows[0]?.updated_at ?? null }
    }
  )

  // ── Revive request proxy (#308) ─────────────────────────────────────────
  // Browsers cannot POST cross-origin to services like tornuhc.eu, so the
  // server forwards the call (server-to-server, no CORS). Replaces the retired
  // Supabase `war-room-fetch` `revive_request` action.
  //
  // NOTE (Nuke): Nuke appears to shadow-filter datacenter IPs — it answers 200
  // while the request never reaches the reviver pool. The VPS is a datacenter
  // IP, so the frontend still sends the Nuke preset DIRECT from the browser
  // (residential IP) and only routes JSON presets here. This endpoint
  // implements the Nuke shape anyway, so flipping the frontend over is a
  // one-line change once a real Nuke request through the VPS is confirmed to
  // land. See #308.
  app.post('/api/war-room/revive', { preHandler: requireAuth() }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>

    const target = checkReviveTarget(body.url)
    if (!target.ok) return reply.status(400).send({ error: target.error })
    const url = target.url!.toString()

    // Identity comes from the session, never the request body: a revive
    // request is always for yourself, and trusting a client-supplied id would
    // let anyone spam the reviver pool under someone else's name.
    const userID = Number(req.session!.torn_user_id)
    const identity = {
      userID,
      userName: await actorName(req.session!.torn_user_id),
      factionName: typeof body.factionName === 'string' ? body.factionName : '',
    }
    const source = typeof body.source === 'string' ? body.source : undefined
    const preset = String(body.preset ?? 'json').toLowerCase()

    let headers: Record<string, string>
    let outBody: string
    let sentPayload: Record<string, unknown>

    if (preset === 'nuke') {
      // The server owns war-room state, so it resolves the country itself
      // rather than trusting whatever the client believed. A tombstoned row is
      // "not in state" and falls back to Torn.
      const state = await db.query(
        `SELECT state->'status'->>'description' AS description
           FROM war_room_state_v2 WHERE member_id = $1 AND deleted_at IS NULL`,
        [userID]
      )
      const country = resolveCountryFromDescription(state.rows[0]?.description)
      sentPayload = buildNukeFields(identity, { source, country })
      headers = { 'content-type': 'application/x-www-form-urlencoded' }
      outBody = new URLSearchParams(sentPayload as Record<string, string>).toString()
    } else {
      sentPayload = buildJsonPayload(identity, {
        source,
        sourceKey: typeof body.sourceKey === 'string' ? body.sourceKey : undefined,
      })
      headers = { 'content-type': 'application/json' }
      outBody = JSON.stringify(sentPayload)
    }

    try {
      // The service is a third party that can hang; without a deadline a stuck
      // connection would pin a request handler until the client gives up.
      const resp = await fetch(url, {
        method: 'POST', headers, body: outBody,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await resp.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
      // A non-2xx from the SERVICE is a successful proxy of a refusal, not a
      // proxy failure — the UI renders ok:false and shows the reason.
      return { ok: resp.ok, status: resp.status, body: parsed, sentPayload, url }
    } catch (e) {
      req.log.error({ err: e, url, preset }, 'revive request failed')
      return reply.status(502).send({ error: `Revive request failed: ${(e as Error).message}` })
    }
  })
}
