# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**How to bump:** Before committing a release, add a new `## [X.Y.Z] - YYYY-MM-DD` block
at the top (below `[Unreleased]`). The deploy pipeline reads the first versioned block
and stamps the footer automatically.

---

## [Unreleased]

## [1.0.1] - 2026-06-01

### Fixed

- **Page navigation no longer loops infinitely.** Switching between sub-tabs (e.g.
  OC → OC History, RW → War Room) previously caused the URL to grow endlessly
  (`/oc/payouts/payouts/payouts/…`) and the page to freeze. The routing has been
  corrected to use absolute paths so every tab click lands exactly where it should.

- **Page width is now stable.** On certain pages (particularly War Overview and the
  War Room) the navigation bar would shrink or grow to match the content width,
  making the layout feel jumpy when switching tabs. The outer shell is now clamped
  so the nav bar and page container maintain a consistent width regardless of what
  is displayed.

### Changed

- **Sub-page URLs now use the full tab name**, hyphen-delimited — easier to share
  or bookmark a specific page:
  - `/oc/history` → `#/oc/oc-history`
  - `/oc/tiers` → `#/oc/tier-requirements`
  - `/rw/history` → `#/rw/rw-history`
  - `/leadership/members` → `#/leadership/member-overview`

### Added

- **Site footer** with version number at the bottom of every page. Version is
  stamped automatically from this changelog on each deploy so it always reflects
  what is live. "MonChoon" links to the Torn profile.

## [1.0.0] - 2026-06-01

### Added
- Full client-side routing via React Router v6 HashRouter — every page now has a
  stable URL that survives a browser refresh (`#/`, `#/members`, `#/oc/*`, `#/rw/*`,
  `#/leadership/*`)
- War Overview: three-panel Plotly chart (Outgoing / Incoming / Revives) with
  per-subplot legend groups labelled "Outgoing", "Incoming", "Revives"
- War Overview: Histogram / Scatter display toggle; manual bin-size control
  (Auto · 1m · 5m · 1h · 6h · 1d); TCT (UTC) time axis
- War Overview: faction names resolved from the `factions` DB table instead of
  showing raw IDs
- Mobile War Room overlay (md:hidden launcher, full-viewport phone-frame)
- Revive data pipeline: `fetch_revives_for_war.py` scrapes Torn v2
  `/faction/revives` and upserts into `faction_revives` Supabase table
- `faction_revives` migration with RLS, indexes on `(rw_id, timestamp)`,
  `(target_id, timestamp)`, `(reviver_faction_id, timestamp)`
- Tier 0 "Needs Manual Review" sentinel replacing legacy −1 across all
  scrapers, payout calculations, and UI badge/filter components
- Info modals on RW Payouts and OC Payouts pages explaining payout formulas
- Payout explanation updated: new members start at Tier 0 until a leader
  assigns a tier
- TornStats spy integration and max-age configuration in War Room
- Stats breakdown fields on mobile War Room member cards
- Leadership controls collapse toggle in War Room
- Activity filter and farm-sort toggle in War Room two-tier filters
- Revive scraper `--debug` flag with pre-flight Supabase connectivity check,
  payload inspection, and post-run DB row count verification

### Fixed
- `reviver_skill` column widened from `integer` to `numeric(6,2)` to accept
  Torn API decimal values (e.g. 36.21)
- `target_last_action` correctly extracts the Unix timestamp integer from the
  Torn v2 `{status, timestamp}` object (was inserting the whole dict into a
  `bigint` column, silently failing)
- War Overview legend no longer shows duplicate faction entries across subplots
- War Overview x-axis displays TCT instead of local browser timezone
- `sys.path` ordering in Python scraper scripts no longer shadows the installed
  `supabase` package with the local `supabase/` directory
- `maybeSingle()` renamed to `maybe_single()` for supabase-py v2 compatibility
- `|| 6` tier fallbacks replaced with `?? 6` throughout payout calculations and
  display code so Tier 0 members are not coerced to Tier 6
