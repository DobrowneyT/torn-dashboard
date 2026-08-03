-- #105: per-faction operator secrets (spy-provider API keys), AES-256-GCM
-- encrypted at rest with KEY_ENCRYPTION_KEY. `hint` holds the last 4 chars
-- for identification in the admin UI; the plaintext never leaves the server.
CREATE TABLE IF NOT EXISTS public.faction_secrets (
  name text NOT NULL,
  value_enc bytea NOT NULL,
  hint text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'faction_secrets_pkey'
  ) THEN
    ALTER TABLE public.faction_secrets ADD CONSTRAINT faction_secrets_pkey PRIMARY KEY (name);
  END IF;
END $$;
