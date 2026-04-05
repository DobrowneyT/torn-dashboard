-- ============================================================
-- War Pay Management Tables
-- ============================================================
-- Run this in Supabase Studio SQL editor or via supabase db push
--
-- RLS policy pattern (matches all existing tables):
--   1. "Allow anon read <table>"      → SELECT for anon role
--   2. "allow_authenticated_all <t>"  → ALL for authenticated role


-- ============================================================
-- ranked_wars: war list from the /v2/faction/{id}/rankedwars API
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ranked_wars (
    id                INTEGER PRIMARY KEY,  -- Torn war ID
    start_at          BIGINT NOT NULL,      -- Unix timestamp
    end_at            BIGINT,              -- Unix timestamp; 0 or null = ongoing
    opponent_id       INTEGER,
    opponent_name     TEXT,
    our_score         INTEGER DEFAULT 0,
    opponent_score    INTEGER DEFAULT 0,
    target            INTEGER,             -- score target to win
    winner_faction_id INTEGER,             -- null if ongoing or forfeit
    forfeit           BOOLEAN DEFAULT FALSE,
    is_termed         BOOLEAN DEFAULT FALSE, -- manual leadership flag
    rewards_items     JSONB,               -- [{id, name, quantity}] from war report API
    rank_before       TEXT,
    rank_after        TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ranked_wars_start_at ON public.ranked_wars (start_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranked_wars_end_at   ON public.ranked_wars (end_at DESC NULLS LAST);

ALTER TABLE public.ranked_wars ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read ranked_wars"
    ON public.ranked_wars FOR SELECT TO anon USING (true);

CREATE POLICY "allow_authenticated_all ranked_wars"
    ON public.ranked_wars FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================
-- war_member_contributions: per-member stats from war report API
-- /v2/faction/{war_id}/rankedwarreport
-- ============================================================
CREATE TABLE IF NOT EXISTS public.war_member_contributions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    war_id      INTEGER NOT NULL REFERENCES public.ranked_wars(id) ON DELETE CASCADE,
    member_id   INTEGER NOT NULL,
    member_name TEXT,
    level       INTEGER,
    attacks     INTEGER DEFAULT 0,
    score       NUMERIC(10,2) DEFAULT 0,
    faction_id  INTEGER,  -- to distinguish our faction vs opponent
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (war_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_wmc_war_id    ON public.war_member_contributions (war_id);
CREATE INDEX IF NOT EXISTS idx_wmc_member_id ON public.war_member_contributions (member_id);

ALTER TABLE public.war_member_contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read war_member_contributions"
    ON public.war_member_contributions FOR SELECT TO anon USING (true);

CREATE POLICY "allow_authenticated_all war_member_contributions"
    ON public.war_member_contributions FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================
-- faction_attacks: ALL faction attacks scraped daily
--
-- No war_id FK — wars are identified dynamically by timestamp window:
--   started >= ranked_wars.start_at AND started <= ranked_wars.end_at
--
-- This captures regular attacks, assists, and incoming attacks so
-- leadership can pay for assists at a reduced contribution rate.
-- is_incoming = true when defender_faction_id = our faction (10739).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.faction_attacks (
    attack_id           BIGINT PRIMARY KEY,     -- Torn attack ID
    started             BIGINT,                 -- Unix timestamp (indexed for window queries)
    ended               BIGINT,
    attacker_id         INTEGER,
    attacker_name       TEXT,
    attacker_faction_id INTEGER,
    defender_id         INTEGER,
    defender_name       TEXT,
    defender_faction_id INTEGER,
    result              TEXT,                   -- 'Attacked', 'Mugged', 'Hospitalized', 'Lost',
                                                -- 'Assist', 'Stalemate', 'Arrested', 'Looted', etc.
    respect_gain        NUMERIC(10,4) DEFAULT 0,
    chain               INTEGER DEFAULT 0,
    is_ranked_war       BOOLEAN DEFAULT FALSE,
    fair_fight          NUMERIC(10,4) DEFAULT 1,
    war_modifier        NUMERIC(10,4) DEFAULT 1,
    chain_modifier      NUMERIC(10,4) DEFAULT 1,
    warlord_modifier    NUMERIC(10,4) DEFAULT 1,
    is_incoming         BOOLEAN DEFAULT FALSE,  -- true when defender_faction_id = 10739
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Primary index for war window queries (start_at <= started <= end_at)
CREATE INDEX IF NOT EXISTS idx_faction_attacks_started       ON public.faction_attacks (started DESC);
-- Secondary indexes for payout calculations
CREATE INDEX IF NOT EXISTS idx_faction_attacks_attacker_id   ON public.faction_attacks (attacker_id);
CREATE INDEX IF NOT EXISTS idx_faction_attacks_is_ranked_war ON public.faction_attacks (is_ranked_war) WHERE is_ranked_war = TRUE;

ALTER TABLE public.faction_attacks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read faction_attacks"
    ON public.faction_attacks FOR SELECT TO anon USING (true);

CREATE POLICY "allow_authenticated_all faction_attacks"
    ON public.faction_attacks FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================
-- war_payouts: saved payout configurations per war
-- ============================================================
CREATE TABLE IF NOT EXISTS public.war_payouts (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    war_id                  INTEGER NOT NULL REFERENCES public.ranked_wars(id) ON DELETE CASCADE,
    war_type                TEXT NOT NULL CHECK (war_type IN ('termed', 'real')),
    faction_cut_percent     NUMERIC(5,2) DEFAULT 20,

    -- Cache prices (entered manually per cache type)
    price_melee_cache       BIGINT DEFAULT 0,
    price_armor_cache       BIGINT DEFAULT 0,
    price_small_arms_cache  BIGINT DEFAULT 0,
    price_medium_arms_cache BIGINT DEFAULT 0,
    price_heavy_arms_cache  BIGINT DEFAULT 0,

    -- Termed war settings
    min_score_threshold     NUMERIC(10,2) DEFAULT 0,
    flat_payout_amount      BIGINT DEFAULT 0,

    -- Real war weighted formula settings
    score_multiplier        NUMERIC(8,4) DEFAULT 1.0,
    attacks_weight          NUMERIC(5,4) DEFAULT 0.5,
    effort_weight           NUMERIC(5,4) DEFAULT 0.5,
    assist_multiplier       NUMERIC(5,4) DEFAULT 0.25, -- assists count at this fraction of a full attack
    min_payout_threshold    BIGINT DEFAULT 0,

    notes                   TEXT,
    created_by              TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_war_payouts_war_id ON public.war_payouts (war_id);

ALTER TABLE public.war_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read war_payouts"
    ON public.war_payouts FOR SELECT TO anon USING (true);

CREATE POLICY "allow_authenticated_all war_payouts"
    ON public.war_payouts FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================
-- war_payout_members: per-member results for a saved payout
-- ============================================================
CREATE TABLE IF NOT EXISTS public.war_payout_members (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payout_id     BIGINT NOT NULL REFERENCES public.war_payouts(id) ON DELETE CASCADE,
    member_id     INTEGER NOT NULL,
    member_name   TEXT,
    score         NUMERIC(10,2) DEFAULT 0,
    attacks       INTEGER DEFAULT 0,
    assist_attacks INTEGER DEFAULT 0,
    payout_amount BIGINT DEFAULT 0,
    is_eligible   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wpm_payout_id ON public.war_payout_members (payout_id);
CREATE INDEX IF NOT EXISTS idx_wpm_member_id ON public.war_payout_members (member_id);

ALTER TABLE public.war_payout_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read war_payout_members"
    ON public.war_payout_members FOR SELECT TO anon USING (true);

CREATE POLICY "allow_authenticated_all war_payout_members"
    ON public.war_payout_members FOR ALL TO authenticated USING (true) WITH CHECK (true);
