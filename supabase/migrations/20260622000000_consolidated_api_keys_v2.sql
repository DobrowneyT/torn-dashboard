-- 2.0 — Consolidate to a single opt-in API key.
--
-- Background: members used to provide multiple keys (login key + a separate
-- CPR scraper key). We now capture ONE Limited-access key per member at login
-- via a mandatory opt-in. That single key:
--   * gates site access (handled client-side),
--   * is used by the CPR scraper (targeted, per-member, unchanged), and
--   * joins a rotating pool used by the War Room and the faction-wide scrapers.
--
-- IMPORTANT: public.member_secrets and the set_member_cpr_key /
-- get_member_cpr_key SECURITY DEFINER RPCs were created directly in the live
-- DB (not in repo migrations). This migration therefore:
--   1. Only ALTERs member_secrets (idempotent ADD COLUMN IF NOT EXISTS); it
--      never assumes it can CREATE the table fresh.
--   2. DELEGATES encryption/decryption to the existing CPR RPCs rather than
--      re-implementing pgp_sym_encrypt (whose schema/column types we can't see
--      from the repo). The new RPCs are thin wrappers that add metadata and
--      rotation on top.

-- ── 1. Generalize member_secrets: the encrypted key is now the consolidated
--       key, plus metadata for eligibility, consent, and health. ──────────────
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS key_level          smallint;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS has_faction_access boolean;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS member_rank        text;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS consent_at         timestamptz;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS consent_version    text;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS key_fingerprint    text;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS disabled           boolean NOT NULL DEFAULT false;
ALTER TABLE public.member_secrets ADD COLUMN IF NOT EXISTS last_error         text;

COMMENT ON COLUMN public.member_secrets.cpr_api_key IS
  'Encrypted consolidated Limited-access key (pgp_sym_encrypt). Historically the CPR key; as of 2.0 it is the member''s single key for CPR + War Room + scrapers.';
COMMENT ON COLUMN public.member_secrets.has_faction_access IS
  'Torn access.faction flag. false for Recruits (no faction API for 72h) — such keys are excluded from the faction-scoped rotation pool.';

-- ── 2. Rotation counter (atomic claim for parallel/matrix scraper runners) ────
CREATE SEQUENCE IF NOT EXISTS public.api_key_rotation_seq;

-- ── 3. New RPCs — all SECURITY DEFINER, all require p_secret. They delegate
--       encryption to the existing CPR RPCs. Accept APP_KEY_SECRET going
--       forward; callers may still pass the old CPR_KEY_SECRET value. ─────────

-- Upsert the member's consolidated key + eligibility/consent metadata.
-- Passing a null/empty raw key clears the row (delegated to set_member_cpr_key).
CREATE OR REPLACE FUNCTION public.set_member_api_key(
  p_member_id          text,
  p_raw_key            text,
  p_secret             text,
  p_key_level          smallint DEFAULT NULL,
  p_has_faction_access boolean  DEFAULT NULL,
  p_member_rank        text     DEFAULT NULL,
  p_consent_version    text     DEFAULT NULL
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $fn$
BEGIN
  -- Encryption + insert/delete is owned by the existing CPR RPC so we have a
  -- single source of truth for how keys are stored.
  PERFORM public.set_member_cpr_key(p_member_id, p_raw_key, p_secret);

  -- Layer metadata on top (only when a key was actually stored). Consent is
  -- stamped only when a consent_version is supplied (i.e. from the opt-in
  -- flow) so the metadata backfill doesn't overwrite real consent timestamps.
  IF p_raw_key IS NOT NULL AND btrim(p_raw_key) <> '' THEN
    UPDATE public.member_secrets
       SET key_level          = COALESCE(p_key_level, key_level),
           has_faction_access = COALESCE(p_has_faction_access, has_faction_access),
           member_rank        = COALESCE(p_member_rank, member_rank),
           consent_at         = CASE WHEN p_consent_version IS NOT NULL THEN now() ELSE consent_at END,
           consent_version    = COALESCE(p_consent_version, consent_version),
           key_fingerprint    = right(btrim(p_raw_key), 4),
           disabled           = false,
           last_error         = NULL
     WHERE member_id::text = p_member_id;
  END IF;
END;
$fn$;

-- Decrypt a single member's key (targeted — used by the CPR scraper).
CREATE OR REPLACE FUNCTION public.get_member_api_key(p_member_id text, p_secret text)
  RETURNS text
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $fn$
  SELECT public.get_member_cpr_key(p_member_id, p_secret);
$fn$;

-- Return the full eligible, decrypted key pool. p_faction_only excludes
-- Recruits (has_faction_access = false). Used by the War Room edge function
-- and bulk scraper loads. User keys only — no admin fallback.
CREATE OR REPLACE FUNCTION public.get_active_key_pool(
  p_secret      text,
  p_faction_only boolean DEFAULT true
)
  RETURNS TABLE(member_id text, api_key text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $fn$
  SELECT ms.member_id::text,
         public.get_member_cpr_key(ms.member_id::text, p_secret)
  FROM public.member_secrets ms
  WHERE COALESCE(ms.disabled, false) = false
    AND (NOT p_faction_only OR COALESCE(ms.has_faction_access, false) = true)
  ORDER BY ms.member_id;
$fn$;

-- Atomically claim the next key in the rotation (for parallel scraper jobs /
-- matrix runners). nextval is transaction-safe across concurrent runners.
CREATE OR REPLACE FUNCTION public.claim_next_api_key(
  p_secret      text,
  p_faction_only boolean DEFAULT true
)
  RETURNS TABLE(member_id text, api_key text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $fn$
DECLARE
  v_count int;
  v_idx   int;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.member_secrets ms
  WHERE COALESCE(ms.disabled, false) = false
    AND (NOT p_faction_only OR COALESCE(ms.has_faction_access, false) = true);

  IF v_count = 0 THEN
    RETURN;  -- empty pool — caller surfaces a clear error
  END IF;

  v_idx := (nextval('public.api_key_rotation_seq') % v_count);

  RETURN QUERY
  SELECT sub.member_id::text,
         public.get_member_cpr_key(sub.member_id::text, p_secret)
  FROM (
    SELECT ms.member_id
    FROM public.member_secrets ms
    WHERE COALESCE(ms.disabled, false) = false
      AND (NOT p_faction_only OR COALESCE(ms.has_faction_access, false) = true)
    ORDER BY ms.member_id
    OFFSET v_idx LIMIT 1
  ) sub;
END;
$fn$;

-- ── 4. Lock down: these all take the secret, but keep them off the public
--       PostgREST surface — only the service role (Edge Functions + scrapers)
--       calls them. We REVOKE the default PUBLIC grant (which anon/authenticated
--       inherit) and explicitly GRANT to service_role so its PostgREST RPC calls
--       still work. ──────────────────────────────────────────────────────────
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.set_member_api_key(text, text, text, smallint, boolean, text, text)',
    'public.get_member_api_key(text, text)',
    'public.get_active_key_pool(text, boolean)',
    'public.claim_next_api_key(text, boolean)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
