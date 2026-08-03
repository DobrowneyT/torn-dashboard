-- #264: store the last-4 characters of a member's API key so the dashboard can
-- show the signed-in user which key is on file (masked ••••<hint>) without ever
-- exposing the full/decrypted key. Populated at login enrolment. Idempotent.
ALTER TABLE public.member_secrets
  ADD COLUMN IF NOT EXISTS key_hint text;
