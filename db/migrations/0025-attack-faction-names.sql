-- Store each attack's faction names inline (like faction_revives already does
-- with reviver_faction_name / target_faction_name), so an attack row is
-- self-describing and the RW payout / war-overview name lookups don't depend
-- solely on the `factions` table. The v2 /faction/attacks payload carries
-- attacker.faction.{id,name} and defender.faction.{id,name}. Idempotent.

ALTER TABLE faction_attacks ADD COLUMN IF NOT EXISTS attacker_faction_name text;
ALTER TABLE faction_attacks ADD COLUMN IF NOT EXISTS defender_faction_name text;

-- Backfill existing rows in-place from the factions lookup (populated by
-- attacks-sync/factions-sync) — no re-pull needed, so no risk of losing
-- attacks beyond Torn's API retention window. Only fills NULLs, so re-running
-- never clobbers a name already captured from a fresh scrape.
UPDATE faction_attacks fa SET attacker_faction_name = f.name
  FROM factions f
  WHERE fa.attacker_faction_id = f.id AND fa.attacker_faction_name IS NULL;
UPDATE faction_attacks fa SET defender_faction_name = f.name
  FROM factions f
  WHERE fa.defender_faction_id = f.id AND fa.defender_faction_name IS NULL;
