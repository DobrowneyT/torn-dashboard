-- 2.0 follow-up: the faction-scoped rotation pool must require Limited Access
-- (key_level >= 3), not just has_faction_access.
--
-- Why: faction endpoints (/v2/faction/crimes, members, chain, attacks,
-- rankedwars) require a Limited key. Pre-2.0 members submitted Minimal (level 2)
-- keys under the old CPR flow, and many report access.faction = true — but a
-- Minimal key still can't read faction data, so it must not enter the faction
-- pool. New logins enforce Limited, so the pool upgrades itself over time.
--
-- p_faction_only = true  -> Limited+ AND has_faction_access AND not disabled
-- p_faction_only = false -> any non-disabled key (public/user-scoped calls,
--                           e.g. the items catalog)
--
-- CPR is unaffected: it polls each member's OWN organizedcrimes (a user
-- selection that works on Minimal) via get_member_api_key, not this pool.

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
    AND (
      NOT p_faction_only
      OR (COALESCE(ms.has_faction_access, false) = true
          AND COALESCE(ms.key_level, 0) >= 3)
    )
  ORDER BY ms.member_id;
$fn$;

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
    AND (
      NOT p_faction_only
      OR (COALESCE(ms.has_faction_access, false) = true
          AND COALESCE(ms.key_level, 0) >= 3)
    );

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
      AND (
        NOT p_faction_only
        OR (COALESCE(ms.has_faction_access, false) = true
            AND COALESCE(ms.key_level, 0) >= 3)
      )
    ORDER BY ms.member_id
    OFFSET v_idx LIMIT 1
  ) sub;
END;
$fn$;

-- Re-assert the lockdown (CREATE OR REPLACE preserves grants, but be explicit).
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.get_active_key_pool(text, boolean)',
    'public.claim_next_api_key(text, boolean)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
