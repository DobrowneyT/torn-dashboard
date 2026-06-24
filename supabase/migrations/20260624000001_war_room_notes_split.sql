-- War notes refinement: two termed scores (ours/theirs) + public/private split.
--
-- Idempotent delta for DBs that already applied the original
-- 20260624000000 (which had a single `termed_score` and one `notes` column).
-- Safe to run whether the table is old-shape, already new-shape, or the private
-- table already exists.

-- 1. New public columns (no-op if already present).
ALTER TABLE public.war_room_notes_v2 ADD COLUMN IF NOT EXISTS termed_score_us   integer;
ALTER TABLE public.war_room_notes_v2 ADD COLUMN IF NOT EXISTS termed_score_them integer;
ALTER TABLE public.war_room_notes_v2 ADD COLUMN IF NOT EXISTS notes_public      text;

-- 2. Migrate data off the old columns, then drop them (only if they still exist).
--    The old single `termed_score` maps to "us"; old `notes` becomes the public note.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'war_room_notes_v2'
               AND column_name = 'termed_score') THEN
    UPDATE public.war_room_notes_v2
       SET termed_score_us = COALESCE(termed_score_us, termed_score)
     WHERE termed_score IS NOT NULL;
    ALTER TABLE public.war_room_notes_v2 DROP COLUMN termed_score;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'war_room_notes_v2'
               AND column_name = 'notes') THEN
    UPDATE public.war_room_notes_v2
       SET notes_public = COALESCE(notes_public, notes)
     WHERE notes IS NOT NULL;
    ALTER TABLE public.war_room_notes_v2 DROP COLUMN notes;
  END IF;
END $$;

-- 3. Private (War-Leader-only) notes — service-role-only, like member_secrets.
--    RLS on, NO select policy, REVOKE from client roles; read via the edge
--    function (get_war_notes_private_v2), never directly from the client.
CREATE TABLE IF NOT EXISTS public.war_room_notes_private_v2 (
  war_id          bigint PRIMARY KEY,
  notes           text,
  updated_by_id   bigint,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.war_room_notes_private_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.war_room_notes_private_v2 FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.war_room_notes_private_v2 TO service_role;

DROP TRIGGER IF EXISTS touch_updated_at_notes_private_v2 ON public.war_room_notes_private_v2;
CREATE TRIGGER touch_updated_at_notes_private_v2
  BEFORE INSERT OR UPDATE ON public.war_room_notes_private_v2
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_v2();
