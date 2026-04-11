#!/usr/bin/env python3
"""
Split faction_attacks_database_full.json into ~25 MB chunk files and
simultaneously upsert each batch into Supabase.

Chunk files are written to:
  data/faction_attacks_database_1.json
  data/faction_attacks_database_2.json
  ...

No git operations are performed — commit and push manually when done.

Usage:
  python scripts/split_and_sync_attacks.py [--no-supabase]

  --no-supabase   Write chunk files only; skip Supabase upserts.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SOURCE_FILE    = Path("data/faction_attacks_database_full.json")
OUTPUT_DIR     = Path("data")
OUTPUT_STEM    = "faction_attacks_database"   # produces _1.json, _2.json, …
CHUNK_LIMIT_MB = 25                           # target max size per chunk file
BATCH_SIZE     = 200                          # attacks processed per iteration
UPSERT_SIZE    = 200                          # records per Supabase upsert call

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Environment / Supabase setup
# ---------------------------------------------------------------------------

def load_env():
    """Load .env if present (without requiring python-dotenv)."""
    env_path = Path(".env")
    if not env_path.exists():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())


def make_supabase_client():
    load_env()
    url = os.environ.get("VITE_SUPABASE_URL", "")
    key = os.environ.get("VITE_SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise EnvironmentError(
            "VITE_SUPABASE_URL and VITE_SUPABASE_SERVICE_ROLE_KEY must be set "
            "(check your .env file)."
        )
    from supabase import create_client
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def to_supabase_record(attack: dict) -> dict:
    """Map a stored attack dict to the Supabase faction_attacks row shape."""
    return {
        "attack_id":          attack["attack_id"],
        "started":            attack.get("started"),
        "ended":              attack.get("ended"),
        "attacker_id":        attack.get("attacker_id"),
        "attacker_name":      attack.get("attacker_name"),
        "attacker_faction_id":attack.get("attacker_faction_id"),
        "defender_id":        attack.get("defender_id"),
        "defender_name":      attack.get("defender_name"),
        "defender_faction_id":attack.get("defender_faction_id"),
        "result":             attack.get("result"),
        "respect_gain":       attack.get("respect_gain", 0),
        "chain":              attack.get("chain", 0),
        "is_ranked_war":      attack.get("is_ranked_war", False),
        "fair_fight":         attack.get("fair_fight", 1),
        "war_modifier":       attack.get("war_modifier", 1),
        "chain_modifier":     attack.get("chain_modifier", 1),
        "warlord_modifier":   attack.get("warlord_modifier", 1),
        "is_incoming":        attack.get("is_incoming", False),
    }


def write_chunk(chunk_num: int, chunk_attacks: dict, source_metadata: dict):
    """Serialise and write one chunk file."""
    newest = max(
        (a.get("started", 0) for a in chunk_attacks.values()),
        default=0,
    )
    data = {
        "attacks": chunk_attacks,
        "metadata": {
            "last_updated":   datetime.utcnow().isoformat(),
            "newest_started": newest,
            "total_attacks":  len(chunk_attacks),
            "chunk":          chunk_num,
        },
    }
    path = OUTPUT_DIR / f"{OUTPUT_STEM}_{chunk_num}.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    size_mb = path.stat().st_size / 1_048_576
    log.info(
        f"  → Wrote chunk {chunk_num}: {len(chunk_attacks):,} attacks "
        f"({size_mb:.1f} MB) → {path.name}"
    )
    return path


def upsert_batch(client, records: list, retries: int = 3):
    """Upsert a slice of records into faction_attacks with simple retry."""
    for attempt in range(1, retries + 1):
        try:
            client.table("faction_attacks").upsert(
                records, on_conflict="attack_id"
            ).execute()
            return
        except Exception as exc:
            if attempt == retries:
                raise
            log.warning(f"  Upsert attempt {attempt} failed ({exc}), retrying…")
            time.sleep(2 ** attempt)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    no_supabase = "--no-supabase" in sys.argv

    # ---- load source -------------------------------------------------------
    log.info(f"Loading {SOURCE_FILE} …")
    with open(SOURCE_FILE, encoding="utf-8") as fh:
        source = json.load(fh)

    attacks_dict  = source["attacks"]          # {attack_id: {...}, …}
    source_meta   = source.get("metadata", {})
    all_ids       = list(attacks_dict.keys())
    total_attacks = len(all_ids)
    log.info(f"Loaded {total_attacks:,} attacks.")

    # ---- supabase client ---------------------------------------------------
    client = None
    if not no_supabase:
        log.info("Connecting to Supabase…")
        client = make_supabase_client()
        log.info("Connected.")

    # ---- iterate in batches ------------------------------------------------
    chunk_limit_bytes = CHUNK_LIMIT_MB * 1_048_576
    chunk_num         = 1
    chunk_attacks     = {}          # {attack_id: attack, …} for current chunk
    chunk_byte_est    = 0           # running byte estimate for current chunk

    total_supabase    = 0
    total_chunks      = 0
    batch_count       = 0
    t0                = time.time()

    for batch_start in range(0, total_attacks, BATCH_SIZE):
        batch_ids     = all_ids[batch_start : batch_start + BATCH_SIZE]
        batch_attacks = {aid: attacks_dict[aid] for aid in batch_ids}
        batch_count  += 1

        # -- 1. Upsert this batch to Supabase --------------------------------
        if client is not None:
            records = [to_supabase_record(a) for a in batch_attacks.values()]
            # Split into UPSERT_SIZE chunks if BATCH_SIZE != UPSERT_SIZE
            for i in range(0, len(records), UPSERT_SIZE):
                upsert_batch(client, records[i : i + UPSERT_SIZE])
            total_supabase += len(records)

        # -- 2. Add to current file chunk ------------------------------------
        chunk_attacks.update(batch_attacks)
        # Estimate serialised size contribution (compact JSON, ~10% smaller
        # than indent=2 but good enough for the threshold decision).
        chunk_byte_est += len(json.dumps(batch_attacks, separators=(",", ":")))

        # -- 3. Progress log every 10 batches --------------------------------
        processed = batch_start + len(batch_ids)
        if batch_count % 10 == 0 or processed == total_attacks:
            elapsed   = time.time() - t0
            rate      = processed / elapsed if elapsed > 0 else 0
            remaining = (total_attacks - processed) / rate if rate > 0 else 0
            log.info(
                f"  Batch {batch_count} | {processed:,}/{total_attacks:,} attacks "
                f"| chunk {chunk_num} ({chunk_byte_est/1_048_576:.1f} MB est.) "
                f"| ~{remaining:.0f}s left"
            )

        # -- 4. Flush chunk if it exceeds the size limit ---------------------
        if chunk_byte_est >= chunk_limit_bytes and processed < total_attacks:
            write_chunk(chunk_num, chunk_attacks, source_meta)
            total_chunks += 1
            chunk_num    += 1
            chunk_attacks = {}
            chunk_byte_est = 0

    # ---- write final (possibly only) chunk ---------------------------------
    if chunk_attacks:
        write_chunk(chunk_num, chunk_attacks, source_meta)
        total_chunks += 1

    elapsed = time.time() - t0
    log.info("=" * 60)
    log.info(f"Done in {elapsed:.1f}s.")
    log.info(f"  Chunk files written : {total_chunks}")
    log.info(f"  Attacks to Supabase : {total_supabase:,}")
    log.info("")
    log.info("Next step: git add data/faction_attacks_database_*.json && git commit && git push")


if __name__ == "__main__":
    main()
