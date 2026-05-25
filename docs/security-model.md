# Security Model

How auth and row-level security work in this project, and how to add a new table without introducing a hole.

## TL;DR

- **Auth** is custom (Torn API key), not Supabase Auth. The frontend mints its own JWT via an Edge Function and hands it to the supabase-js client via the `accessToken` async option.
- **RLS** keys off claims in that JWT. Three predicates cover almost everything: `is_leadership()`, `current_faction_id() = '10739'`, `current_faction_id() IS NOT NULL`.
- **Writes** never go directly from the frontend to public tables. They route through the `admin-db` or `war-room-fetch` Edge Functions, which use the service role (bypasses RLS) plus their own Torn-key + leadership checks.
- **Secrets** (`members.cpr_api_key`-equivalent fields) live in `member_secrets` and `war_room_auth_cache` — RLS-enabled, zero policies, `REVOKE ALL FROM anon, authenticated`. Only service role can touch them; SECURITY DEFINER RPCs (`get_member_cpr_key`, `set_member_cpr_key`) gate the encryption.

## Roles

| Role | What it is | How a request becomes this role |
|---|---|---|
| `anon` | No auth | Frontend before sessionToken mints, or any unauthenticated visitor |
| `authenticated` | A faction member with a valid JWT | sessionToken hands a JWT to the supabase-js `accessToken` hook |
| `service_role` | Bypasses RLS entirely | Edge Functions and Python scripts (via service role key) |

## The JWT

Minted by `supabase/functions/war-room-fetch/index.ts` (`mint_session_token` action). Issued only after `verifyTornUser()` confirms the API key is real and the user is in our faction (or in `LEADERSHIP_IDS`). Claims:

```json
{
  "aud":           "authenticated",
  "role":          "authenticated",
  "sub":           "torn-<userId>",
  "torn_user_id":  "<userId>",
  "faction_id":    "10739",
  "is_leadership": true | false,
  "is_admin":      true | false,
  "iat": ..., "exp": ...
}
```

TTL: 4h. Refreshes happen via [src/utils/sessionToken.js](../src/utils/sessionToken.js) 30 min before expiry, on tab focus, or on demand.

## RLS predicate helpers

Defined in `20260527_rls_helpers.sql`:

- `public.current_faction_id() → text` — returns the JWT's `faction_id` claim or NULL
- `public.is_leadership() → boolean` — returns the JWT's `is_leadership` claim or false
- `public.is_admin() → boolean` — returns the JWT's `is_admin` claim or false

All three are `STABLE SECURITY DEFINER` with `COALESCE` for null safety. Granted to anon + authenticated.

## Table classification cheat sheet

When you add a new table, decide which bucket it belongs to and copy the matching policy template.

### Faction-private (most tables)

The default. Per-faction data nobody outside the faction should see: members, payouts, CPRs, crime history, inventory. The JWT's `faction_id` claim must match ours.

```sql
alter table public.your_table enable row level security;
alter table public.your_table force row level security;

create policy "strict_your_table_faction_select"
  on public.your_table
  for select
  to authenticated
  using (public.current_faction_id() = '10739');
```

Writes: route through `admin-db` (a new action, or one of the generic upsert/insert/update/delete actions). Service role bypasses RLS so no write policy is needed.

### Cross-faction (war histories, opponents)

Data that intrinsically references multiple factions (war records, attack logs, opponent member states). Any faction member can read; the JWT itself is the gate.

```sql
create policy "strict_your_table_faction_member_select"
  on public.your_table
  for select
  to authenticated
  using (public.current_faction_id() is not null);
```

### Leadership-only (sensitive operational config)

Tables only leadership should see/touch: saved views, threshold sets, future audit logs.

```sql
create policy "strict_your_table_leadership"
  on public.your_table
  for all
  to authenticated
  using       (public.is_leadership())
  with check  (public.is_leadership());
```

Writes from the frontend should still go through `admin-db` with a server-side `LEADERSHIP_IDS.includes(userId)` check — defense in depth.

### Secret (service role only)

Tables holding API keys, encryption seeds, anything that should never reach a client even with a valid JWT. The pattern is RLS on + force RLS + revoke all client privileges + NO policies. Access only through SECURITY DEFINER RPCs.

```sql
create table public.your_secrets ( ... );
alter table public.your_secrets enable row level security;
alter table public.your_secrets force row level security;
revoke all on public.your_secrets from anon, authenticated, public;
-- DO NOT create any policy. With RLS enabled + no policy + revoked grants,
-- everything except service_role is denied by default.
```

Wrap access in a SECURITY DEFINER function with `GRANT EXECUTE TO service_role` only.

## Adding a new admin-db action

1. Add a handler function in `supabase/functions/admin-db/index.ts`:
   ```ts
   async function handleYourAction(supabase, body, userId) {
     // For leadership-only actions:
     if (!LEADERSHIP_IDS.includes(userId)) throw new Error('Leadership only')

     // ... your logic, using the service-role supabase client.
     // RLS does not apply — be careful with the data you accept.

     return { success: true, data: ... }
   }
   ```

2. Add a case to the action switch:
   ```ts
   case 'your_action':
     result = await handleYourAction(supabase, body, authResult.userId!)
     break
   ```

3. Add a wrapper in `src/utils/adminApi.js`:
   ```js
   export async function yourAction(payload, tornApiKey) {
     return callAdminApi('your_action', { data: payload }, tornApiKey)
   }
   ```

4. Deploy the function (`config.toml` pins `verify_jwt = false`):
   ```
   npx supabase functions deploy admin-db
   ```

## Adding a new realtime channel

Realtime broadcasts are governed by policies on `realtime.messages` (separate schema). The existing policy allows authenticated users to subscribe to topics matching `war_room:%`. If you add a new channel namespace (e.g. `leadership:%`), add a parallel policy with the appropriate gate (probably `is_leadership()`).

## Anti-patterns

- **`from('members').select('*')`** — never do this. Always enumerate columns explicitly so future secret columns don't leak by default.
- **Adding `using (true)` policies** — never. Use the helpers above.
- **Calling the supabase client `.insert/.upsert/.update/.delete` from the frontend on a public table** — never. Route through admin-db.
- **Putting secrets in a public-readable table** — never. Use the secret-table pattern (RLS on, no policies, revoke grants).
- **Trusting the client's user ID in a write** — never. Always read it from `verifyTornUser()`'s return inside the Edge Function.

## Verification queries

Run these periodically (e.g. in a monthly cleanup) to confirm the model hasn't drifted:

```sql
-- 1. Any USING(true) policies that aren't service_role-scoped?
--    Should be zero rows. The two `service_role_all_*` policies on
--    war_payouts / war_payout_members are intentionally retained as
--    redundant-but-explicit signals of intent (service_role bypasses
--    RLS anyway, so they grant nothing extra) — exclude them here.
select tablename, policyname, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and (qual = 'true' or with_check = 'true')
   and policyname not like 'service_role_all_%';

-- 2. Any public tables with RLS off?
select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relrowsecurity = false;

-- 3. Any public tables with RLS on but no policies AND not in the
--    intentional secrets list?
select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relrowsecurity = true
   and c.relname not in ('member_secrets', 'war_room_auth_cache')
   and not exists (
     select 1 from pg_policies p
      where p.schemaname='public' and p.tablename=c.relname
   );

-- 4. Any new columns matching the secret pattern that we didn't notice?
select table_name, column_name
  from information_schema.columns
 where table_schema='public'
   and (column_name ilike '%api_key%' or column_name ilike '%secret%'
        or column_name ilike '%token%' or column_name ilike '%password%');

-- 5. Frontend grep: any direct writes?
--    (run in the repo, not SQL)
-- grep -rEn "supabase\..*\.(insert|upsert|update|delete)\(" src/ \
--   | grep -v "adminApi\.js\|warRoomApi\.js\|leadershipViews\.js\|test\.js"
```
