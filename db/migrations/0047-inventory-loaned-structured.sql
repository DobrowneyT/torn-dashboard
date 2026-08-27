-- Follow-on fix to #542: inventory_items.loaned_to was a flattened
-- comma-joined string of borrower NAMES, which threw away each borrower's
-- loaned amount and made the string unparseable back into member ids (the
-- frontend was matching member ids against a list of names and always
-- missing, showing "Unknown" and "1 item" for everyone). Store the v2 API's
-- per-borrower {member_id, member_name, amount} directly instead.
--
-- No backfill is possible: the old string has no id or amount, only names
-- joined with no separatorable structure. The column resets to NULL and the
-- next inventory sync (cron or manual) repopulates it correctly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'inventory_items'
      AND column_name = 'loaned_to' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.inventory_items ALTER COLUMN loaned_to TYPE jsonb USING NULL::jsonb;
  END IF;
END $$;
