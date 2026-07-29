-- #254: feedback attachments. Images/video from the in-app feedback form are
-- stored as bytea (like faction_branding_assets — rides per-faction backups and
-- isolation, no shared volume), keyed to the GitHub issue they were embedded in
-- so the #255 prune can delete them once that issue closes. Idempotent.
CREATE TABLE IF NOT EXISTS public.feedback_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_number integer NOT NULL,
  content_type text NOT NULL,
  bytes        bytea NOT NULL,
  created_at   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_attachments_issue_idx
  ON public.feedback_attachments (issue_number);
