-- #207: Web Push subscriptions for War Room notifications. One row per browser
-- push endpoint (a member can have several devices). Keys are the standard Web
-- Push p256dh/auth pair used to encrypt payloads. Rows are pruned on delivery
-- when the push service reports the endpoint gone (HTTP 404/410).
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  endpoint   text PRIMARY KEY,
  member_id  text NOT NULL,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_member_id_idx
  ON public.push_subscriptions (member_id);
