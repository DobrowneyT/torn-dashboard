-- Address Supabase security advisor warnings without breaking anything.
--
-- Bucket 1: Dead-code drops (v1 War Room artefacts).
--   * auto_release_dibs_on_status_change() and war_room_claim_dibs(...) both
--     reference the v1 war_room_dibs table which was dropped in Phase 5b.
--     They have no triggers attached and no policies/code paths reference
--     them, so they're unreachable. Dropping clears the `function_search_
--     path_mutable` warning on war_room_claim_dibs and the two
--     `*_security_definer_function_executable` warnings on auto_release_*.
--
-- Bucket 2: JWT-reading helpers (current_faction_id, is_admin, is_leadership).
--   * These exist solely to expose a single claim from auth.jwt() to RLS
--     policies. They don't access any privileged data — calling auth.jwt()
--     just reads the caller's own session JWT, which any role can do.
--     SECURITY DEFINER was unnecessary; switching to INVOKER removes them
--     from the advisor list without changing observable behaviour.
--   * RLS policies that call these (e.g. strict_*_faction_select) keep
--     working because anon/authenticated still have EXECUTE permission and
--     the function body's semantics are unchanged. Verified post-migration
--     by switching role to authenticated with faction_id=10739 and
--     SELECTing every v2 table — counts match service-role view.
--
-- Bucket 3: sync_member_has_cpr_key() stays SECURITY DEFINER (it legitimately
--   writes to public.members from a trigger on member_secrets, which the
--   triggering role may not own). The fix is to REVOKE EXECUTE from public/
--   anon/authenticated so it can no longer be invoked via /rest/v1/rpc/...
--   Trigger execution does NOT require EXECUTE permission on the trigger
--   function, so the trg_member_secrets_sync_has_cpr_key trigger keeps
--   firing for inserts/updates/deletes on member_secrets.

-- ── Bucket 1 ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.auto_release_dibs_on_status_change();
DROP FUNCTION IF EXISTS public.war_room_claim_dibs(integer, integer, text, integer);

-- ── Bucket 2 ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_faction_id()
  RETURNS text
  LANGUAGE sql
  STABLE SECURITY INVOKER
  SET search_path = public, auth
AS $fn$
  SELECT coalesce(auth.jwt() ->> 'faction_id', null);
$fn$;

CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY INVOKER
  SET search_path = public, auth
AS $fn$
  SELECT coalesce((auth.jwt() ->> 'is_admin')::boolean, false);
$fn$;

CREATE OR REPLACE FUNCTION public.is_leadership()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY INVOKER
  SET search_path = public, auth
AS $fn$
  SELECT coalesce((auth.jwt() ->> 'is_leadership')::boolean, false);
$fn$;

-- ── Bucket 3 ─────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.sync_member_has_cpr_key() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_member_has_cpr_key() FROM anon;
REVOKE EXECUTE ON FUNCTION public.sync_member_has_cpr_key() FROM authenticated;
