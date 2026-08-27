-- member_cpr_data was the legacy CPR scrape table, superseded by
-- member_cpr_v2 (which every reader has used since the rewrite). Nothing in
-- server/ or frontend/ references it any more — dropping it rather than
-- leaving dead schema around.
DROP TABLE IF EXISTS public.member_cpr_data;
DROP SEQUENCE IF EXISTS public.member_cpr_data_id_seq;
