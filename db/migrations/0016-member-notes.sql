-- #199: per-member war notes. One note per member, global (persists across
-- wars) — war intel like armour / job / timezone / OD-prone. War leads +
-- leadership/admin edit; all members read.
CREATE TABLE IF NOT EXISTS public.member_notes (
  member_id  text PRIMARY KEY,
  note       text NOT NULL DEFAULT '',
  updated_by text,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
