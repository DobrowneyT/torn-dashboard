-- #480: pre-war stacks snapshot + widening the War Room auto-enable window.
ALTER TABLE public.war_room_config_v2 ADD COLUMN IF NOT EXISTS matched_detected_at timestamp with time zone;
ALTER TABLE public.war_room_config_v2 ADD COLUMN IF NOT EXISTS auto_enabled_at timestamp with time zone;

CREATE TABLE IF NOT EXISTS public.war_stacks_snapshot (
  war_id bigint NOT NULL,
  member_id bigint NOT NULL,
  member_name text,
  energy_current integer,
  energy_maximum integer,
  has_reading boolean NOT NULL,
  od_flagged_prewar boolean NOT NULL,
  captured_at timestamp with time zone NOT NULL,
  PRIMARY KEY (war_id, member_id)
);
