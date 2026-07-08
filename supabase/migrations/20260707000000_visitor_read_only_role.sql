-- Visitor (read-only demo) role — 2026-07-07
--
-- Visitors are leaders of allied TNL-family factions who get full VIEW access
-- to the dashboard but must never be able to write. Their session JWT (minted
-- by war-room-fetch for IDs in its VISITOR_IDS list) carries:
--   faction_id    = '10739'  (grants all existing faction-scoped SELECTs)
--   is_visitor    = true
--   is_leadership = false
--   is_admin      = false
--
-- Because every SELECT policy in the schema keys off faction_id, visitors can
-- already read everything a member can. The ONLY tables where authenticated
-- users hold write-capable policies are member_overview_views and
-- member_overview_thresholds (a single ALL policy gated on is_leadership()).
-- This migration splits those into:
--   SELECT  -> is_leadership() OR is_visitor()   (visitors can view saved views)
--   writes  -> is_leadership()                    (unchanged)
-- so a visitor token can never authorize a write through PostgREST.
--
-- Idempotent: safe to re-run.

-- Helper mirroring is_leadership() / is_admin().
create or replace function public.is_visitor()
returns boolean
language sql
stable
set search_path to 'public', 'auth'
as $$
  select coalesce((auth.jwt() ->> 'is_visitor')::boolean, false);
$$;

-- ── member_overview_views ───────────────────────────────────────────────────
drop policy if exists "strict_member_overview_views_leadership" on public.member_overview_views;
drop policy if exists "overview_views_select_leadership_or_visitor" on public.member_overview_views;
drop policy if exists "overview_views_insert_leadership" on public.member_overview_views;
drop policy if exists "overview_views_update_leadership" on public.member_overview_views;
drop policy if exists "overview_views_delete_leadership" on public.member_overview_views;

create policy "overview_views_select_leadership_or_visitor"
  on public.member_overview_views for select
  to authenticated
  using (is_leadership() or is_visitor());

create policy "overview_views_insert_leadership"
  on public.member_overview_views for insert
  to authenticated
  with check (is_leadership());

create policy "overview_views_update_leadership"
  on public.member_overview_views for update
  to authenticated
  using (is_leadership())
  with check (is_leadership());

create policy "overview_views_delete_leadership"
  on public.member_overview_views for delete
  to authenticated
  using (is_leadership());

-- ── member_overview_thresholds ──────────────────────────────────────────────
drop policy if exists "strict_member_overview_thresholds_leadership" on public.member_overview_thresholds;
drop policy if exists "overview_thresholds_select_leadership_or_visitor" on public.member_overview_thresholds;
drop policy if exists "overview_thresholds_insert_leadership" on public.member_overview_thresholds;
drop policy if exists "overview_thresholds_update_leadership" on public.member_overview_thresholds;
drop policy if exists "overview_thresholds_delete_leadership" on public.member_overview_thresholds;

create policy "overview_thresholds_select_leadership_or_visitor"
  on public.member_overview_thresholds for select
  to authenticated
  using (is_leadership() or is_visitor());

create policy "overview_thresholds_insert_leadership"
  on public.member_overview_thresholds for insert
  to authenticated
  with check (is_leadership());

create policy "overview_thresholds_update_leadership"
  on public.member_overview_thresholds for update
  to authenticated
  using (is_leadership())
  with check (is_leadership());

create policy "overview_thresholds_delete_leadership"
  on public.member_overview_thresholds for delete
  to authenticated
  using (is_leadership());
