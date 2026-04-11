# Deep-Dive: YATA War Reports Generation Flow

This document details the exact process and architecture flows by which **YATA (Yet Another Torn App)** generates and compiles "Wars" based attacks reports found within the `/faction/attacks/` page.

### Overview of Report Types
There are three main view components to understanding how YATA organizes and interacts with War Data:
1. **The Base "Attacks Report"**: The core dataset storing every processed attack within a specified timeframe (a war context).
2. **The "Members Breakdown"**: A localized subset generation of outgoing/incoming attack breakdowns based on the base attacks report.
3. **The "Ranked War Report"**: A highly-focused view built entirely on-the-fly dynamically querying Torn's special API endpoint, separate from the primary data cruncher.

---

## 1. Initializing the Report
When a user navigates to "Create reports based on wars" on the frontend `(/faction/attacks/)`, they see a live list of their faction's recent/live wars (populated from `views.attacksWars`).

* **The Trigger**:
  Clicking the "Create report" button triggers an AJAX `POST` request.
  - Bound via `yata/static/yata/js/faction/attacks.js` (line ~131), the event handler listens to the `.create-war-report` anchor class.
  - It collects `type`, `war_id`, `timestamp`, `faction_id`, etc., injected via `data-*` attributes.
  - This payload is sent via `.load("/faction/attacks/")`.

* **The Application Landing (`views.attacksReports`)**:
  `attacksReports` inside `faction/views.py` traps this `POST`.
  - Depending on the `war_type` (`ranked`, `territorial`, or `raid`), it behaves slightly differently to fetch start/end boundary dates.
    - **Ranked Wars**: Fetches from the Torn API directly via `rankedwarreport` substituting the `war_id`. It maps `api_report["war"]["start"]` and `end`.
    - **Territorial / Raid Wars**: Maps using `apiCall("faction", ..., "mainnews", ...)`, parsing recent primary news feeds with RegEx to precisely find the unix timestamp when an assault/raid was actually initiated.
  - Once dates are known, it records a raw JSON dictionary of the war parameters.
  - **Database instantiation**: It creates an instance of `AttacksReport` (`report = faction.attacksreport_set.create(...)`).
  - It assigns `computing = True` and calls `report.assignCrontab()`, which slots this newly created report into a cron-task execution queue bucket based on current CRON loads.

---

## 2. Background Data Grabbing (CRON Jobs)
Since attack datasets are vast, YATA spins off the actual calculation into an asynchronous pipeline executed by Django Management Commands.

* **The CRON Executable (`management/commands/attacks.py`)**:
  A background shell cron periodically executes `python manage.py attacks <cron_id>`.
  - It searches the db for: `AttacksReport.objects.filter(computing=True).filter(crontab=crontabId)`.
  - Upon finding our newly slotted report, it natively triggers: `report.getAttacks()` alongside `report.fillReport()`.

* **`AttacksReport.getAttacks()` (`faction/models.py`)**:
  - The algorithm calculates timestamps from the `self.start` and loops batches until `self.end` (or `tsnow()` if it's indefinitely live).
  - It cycles through the faction’s provided Master API keys (spreads load and skirts rate-limiting limits).
  - Calling Torn API: `apiCall("faction", faction.tId, "attacks,timestamp&from=...&to=...")`.
  - Maps `apiAttacks` dictionary to unique Torn Attack IDs (`tId`).
  - Iterates parsing new attacks into a formatted data map (`AttackReport` database object mapping) and executes a `bulk_operation.update_or_create()` across Postgres.
  - Effectively, the db gets 100% synced up mapping `attacker_id`, `defender_id`, `result`, `modifiers` within that war bracket.

---

## 3. Aggregating the Base Data (`AttacksReport.fillReport()`)
Whenever the DB chunk successfully grabs updates (`getAttacks()` executes successfully), the cron job continues down to crunch the numbers.

* **`fillReport()` execution (`faction/models.py`)**:
  - Uses `self.attackreport_set.all()` to gather every registered attack currently existing inside this specific `AttacksReport`.
  - Categorizes "Wins": Excludes ["Stalemate", "Assist", "Lost", "Timeout", "Escape"].
  - **Per-Faction Totals**: Maintains a local memory dict `f_set` mapping every involved `attacker_faction` and `defender_faction`. Counts mapping `hits`, `attacks`, `defends`, and `attacked`.
  - **Per-Player Totals**: Maintains a local memory dict `p_set` tracking similarly for individual `attacker_id` and `defender_id`.
  - Triggers massive batch table writes updates inside the models `AttacksFaction` and `AttacksPlayer`.
  - Determines UI "Show/Hide" states making sure default factions (`self.factions`) are actively flagged as `show=True`.

---

## 4. Serving specific the Views
After all of the data has been collected by the background workers and cached in native schema models, YATA exposes the parsed information using 3 separate display endpoints.

### A. The General Attacks Table (`views.attacksReport`)
`/faction/attacks/<reportId>`
- Extracts the standard paginated UI data directly from the generated models.
- Fetches ordered sets of `report.attacksfaction_set.order_by(...)` and `report.attacksplayer_set...`.
- Generates standard hit/defense matrixes you see on the primary attacks report page.

### B. The Members Breakdown (`views.attacksMembers`)
`/faction/attacks/members/<reportId>`
- Handles fetching localized performance metrics.
- Leverages the internal model method `AttacksReport.getMembersBreakdown(order)`.
- **How it Works**:
  - Evaluates both `outgoing` and `incoming` attacks.
  - Translates string results (`Mugged`, `Hospitalized`, `Attacked`) into numerical matrix arrays for both attacker and defender dimensions.
  - E.g: Matrix index logic mappings: `[0 leave, 1 mug, 2 hosp, 3 war, 4 retal, 5 win, 6 assist, 7 lost, 8 total]`.
  - Sorts against this mapped matrix and returns to Python for template rendering.

### C. The Ranked War Report View (`views.attacksWar`)
`/faction/attacks/war/` (Requires `war_id` payload target context from template frontend UI)
- This does **NOT** rely on the `AttacksReport` CRON job cache logic cruncher!
- Fetches the Live `rankedwarreport` direct from Torn:
  `apiCall("torn", war_id, "rankedwarreport")`
- Instead of computing stats individually, it consumes formatting natively supplied by Torn.
- Loops through the direct JSON response's `factions` dict.
- Re-orders the inner `members` arrays sorting explicitly by Score keys (`-x[1]["score"]`).
- Trims any map objects containing `0` zero `attacks`.
- Dispatches exactly to `faction/attacks/war-ranked-report.html`.