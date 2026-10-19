-- The action feed now DELETES a closed suggestion's message rather than
-- striking it through (MonChoon, 2026-10-19: "delete the messages automatically
-- once they've been cleared or expired"). Suggestions that closed before this
-- still have a struck-through message in the thread; bumping their version
-- hands them back to the bot once, which deletes them.
UPDATE public.oc_suggestions
   SET version = version + 1, updated_at = now()
 WHERE status IN ('done', 'resolved', 'expired') AND message_id IS NOT NULL;
