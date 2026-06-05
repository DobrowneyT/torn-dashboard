-- Phase 5b — decommission War Room v1.
--
-- Run this migration AFTER:
--   • The code cutover in Phase 5a is deployed (no client subscribes to the
--     legacy realtime topics, no client reads/writes the legacy tables).
--   • A 48 h watch period with leadership using the v2 UI in production,
--     including at least one full war cycle.
--
-- Rollback: if the user reports a regression in the watch window, do NOT
-- apply this migration. Re-deploy a build of the war-room-v2 branch with
-- the route swap reverted. The v1 tables and Realtime triggers are still
-- intact until this runs, so recovery is "redeploy + clear v2 state, v1
-- picks up where it left off."

-- ── 1. Drop v1 Realtime broadcast infrastructure ────────────────────────────
-- The triggers were named inconsistently across hand-applied SQL — some envs
-- have `*_broadcast`, others have `*_broadcast_trg`. DROP FUNCTION ... CASCADE
-- picks up every dependent trigger regardless of naming, so we don't have to
-- chase the variants.

DROP FUNCTION IF EXISTS public.war_room_broadcast() CASCADE;

-- ── 2. Drop scoped RLS policy on realtime.messages ──────────────────────────
-- Allowed `authenticated` to SELECT war_room:* topics; v2 doesn't subscribe.
-- The realtime.messages table itself stays (it's part of the Realtime
-- extension; not ours to drop).

DROP POLICY IF EXISTS "war_room: authenticated can read broadcasts"
  ON realtime.messages;

-- ── 3. Drop v1 tables ───────────────────────────────────────────────────────
-- CASCADE picks up any straggler dependent objects (FKs, indexes, triggers).
-- Data here was authoritative until Phase 5a; v2 has its own _v2 tables.

DROP TABLE IF EXISTS public.war_room_state  CASCADE;
DROP TABLE IF EXISTS public.war_room_dibs   CASCADE;
DROP TABLE IF EXISTS public.war_room_config CASCADE;

-- ── 4. Drop v1 auth-cache table if unused ──────────────────────────────────
-- war_room_auth_cache backs verifyTornUser() in the Edge Function. v2 still
-- calls verifyTornUser for non-poll actions (Save / Update Spies / claim
-- dibs), so this table is still in use. Intentionally NOT dropped here.

-- ── 5. Reminder: still-live v1 surface area ─────────────────────────────────
-- Things that still reference v1 after this migration:
--   • Edge Function `war-room-fetch`: the legacy v1 action handlers
--     (handleFetchMembers, handleClaimDibs, handleGetConfig, etc.) and the
--     mint_realtime_token action. They're now unreachable from the v2
--     client but still in the source.
--   • The `jwt_secret` Edge Function env var, used by mint_realtime_token /
--     mint_session_token. mint_session_token is still consumed by
--     sessionToken.js for the supabase-js accessToken hook.
--
-- These get cleaned up in Phase 6 once we're certain nothing relies on the
-- session JWT path (e.g., make the v2 RPCs anon-only and drop sessionToken).
