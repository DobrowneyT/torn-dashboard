-- #974 — what the parser read out of each archived attack log.
--
-- Rebuilt from `event_attack_logs.raw` at any time: re-running the parser over
-- the whole archive is idempotent (one row per attack, effects replaced
-- wholesale). `parser_version` is how a changed parser finds what to redo.
CREATE TABLE IF NOT EXISTS public.event_attack_log_parsed (
  attack_id      bigint PRIMARY KEY REFERENCES public.event_attack_logs(attack_id) ON DELETE CASCADE,
  event_id       bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  parser_version integer NOT NULL,
  -- Our member in this attack: the attacker outgoing, the defender incoming.
  member_id      bigint,
  outgoing       boolean NOT NULL,
  mug_amount     bigint,
  respect        numeric(10,2),
  damage_dealt   integer,
  damage_taken   integer,
  hits           integer,
  misses         integer,
  hit_damages    integer[] NOT NULL DEFAULT '{}',
  biggest_hit    integer,
  started        bigint NOT NULL,
  parsed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_attack_log_parsed_event
  ON public.event_attack_log_parsed (event_id, member_id);

-- One row per effect line — a weapon proc such as Stricken or Plunder, or
-- another named effect. ⚠️ Named by the line's icon, never matched by wording.
CREATE TABLE IF NOT EXISTS public.event_attack_log_effects (
  attack_id bigint NOT NULL REFERENCES public.event_attack_logs(attack_id) ON DELETE CASCADE,
  seq       integer NOT NULL,
  event_id  bigint NOT NULL REFERENCES public.faction_events(id) ON DELETE CASCADE,
  actor_id  bigint,
  effect    text NOT NULL,
  text      text NOT NULL,
  started   bigint NOT NULL,
  PRIMARY KEY (attack_id, seq)
);
CREATE INDEX IF NOT EXISTS event_attack_log_effects_event
  ON public.event_attack_log_effects (event_id, actor_id);
