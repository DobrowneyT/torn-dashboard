-- Migration: Add member daily stats table for personal stats snapshots + gym contributions
-- Stores one row per member per day. personalstats is the full API response (JSONB).
-- Gym stats come from the faction contributors endpoint (no historical lookback available).

CREATE TABLE IF NOT EXISTS member_daily_stats (
    member_id       TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL,
    personalstats   JSONB,          -- full personalstats API response blob
    api_version     TEXT,           -- 'v1' or 'v2' (format differs between backfill and daily)
    gym_strength    BIGINT,
    gym_speed       BIGINT,
    gym_dexterity   BIGINT,
    gym_defense     BIGINT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (member_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_member_daily_stats_date ON member_daily_stats (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_member_daily_stats_member ON member_daily_stats (member_id);

ALTER TABLE member_daily_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON member_daily_stats FOR SELECT USING (true);
