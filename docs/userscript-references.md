# Userscript reference notes

Background for `frontend/userscripts/tnl-war-room-dibs.user.js`. The script itself
stays mostly code — this file holds the reasoning, the provenance, and the traps,
so none of it has to be re-derived.

Two reference scripts are cited throughout:

- **CAT Script v3** (`cat_script_v3.user.js`) — war-list enhancement, calls, rally.
- **Wall Battlestats Colored** (`Wall Battlestats Colored-6.3.3.4.user.js`) — stat
  colouring, status rewriting, flex-order sorting.

Neither is vendored. We copy specific solved problems, not code.

---

## Transport

**No CORS plugin on the API.** A plain `fetch()` from `torn.com` is blocked, and a
POST with `Authorization` + JSON triggers a preflight nothing answers. Everything
goes through `GM.xmlHttpRequest`, which the extension performs on our behalf and is
therefore exempt from both CORS and the page's CSP. Do not "fix" this by
allow-listing `torn.com` on the API.

**There is no WebSocket, and adding one back will not work.** Reads were originally
socket-only on the reasoning that sockets are CORS-exempt. True, but CORS was never
the binding constraint: a page's CSP `connect-src` governs WebSockets too, and
unlike `GM.xmlHttpRequest` a socket opened by page script gets no exemption. Torn's
policy is explicit and we are not on the list:

```
connect-src blob: 'self' wss://*.torn.com wss://*.torncity.com
            *.torncity.com *.torn.com api.torn.com …
```

Chrome refuses the connection before a packet leaves the browser — nginx logged zero
handshakes while the console showed an error on every load. Reads are polls of
`/api/war-room/delta`, the REST twin of the socket snapshot with the same `since`
watermark.

**Removing the socket also closed a credential leak.** Chrome's CSP violation message
prints the entire blocked URL, and the URL carried the session token as a query
parameter — so every page load wrote a live 30-day JWT into the console. Our own
logging redacts; Chrome's does not and cannot be asked to. If a socket is ever
reintroduced, its token must not travel in the URL.

**Content-type only when there is a body.** Sending `content-type: application/json`
on a bodyless request makes Fastify parse a zero-length body as JSON and answer
`400 FST_ERR_CTP_EMPTY_JSON_BODY` *before* the route is reached. This broke
release-from-Torn while release from the War Room kept working, because the SPA's
`apiDelete` sends no content-type. GET was unaffected — Fastify does not parse a body
it never expects — so the fault looked specific to DELETE and therefore looked like a
permissions problem.

**Only the session JWT is stored.** The API key is held in memory just long enough to
ask Torn which faction it belongs to, then dropped. Login is sent with
`require_enrolled`, so this script can never be a member's *first* key enrolment —
that must happen on the dashboard, which shows the shared-key-pool disclosure.

---

## Layout

**Torn's war table is a float layout with fixed per-column widths.** A cell that
grows with its content overflows the row, the last float wraps, and the enemy list
drops *below* our own faction's list instead of sitting beside it.

**Room is made by narrowing Torn's columns, never by widening ours.** Both reference
scripts do this. CAT's measured widths:

| Column | CAT |
|---|---|
| `level___` | min 22px / max 30px |
| `points___` (score) | 50px |
| `status___` | 60px |
| member name | 90–100px |
| `.call-column` | 50px |
| `.call-button` | auto, min 28px, **max 40px** |

The row clearfix (`clear: both`, `::after`) is lifted from Wall Battlestats, which
has kept it correct through years of Torn's churn. It is what stops a row collapsing
once it holds one more float than Torn designed it for.

**Selectors are structural, not class names.** Torn's classes are hashed per build
(`row___a1b2c`) and change without notice. Match on `profiles.php?XID=` anchors, on
"the ancestor that is a list item or table row", on `.attack` — these have been
stable for years.

⚠️ `[class*="row"]` is **not** safe: Torn wraps the name in
`<div class="userInfoBox___SpD9F rowSection___wdqaD">`, which that selector matches,
so `closest()` returns the *name cell* and every column we insert lands on top of the
player's name.

---

## Sorting — flexbox `order`, never DOM moves

Both reference scripts solve this the same way, and it is better than reordering:
set `display:flex; flex-direction:column` on the list and write a CSS `order` onto
each row. No node ever moves, so Torn's React never sees a mutation it did not make —
which is why their sort survives a re-render and a splice-based one would not.

Because nodes never move, **document order is permanently the original order**, so
the stable-sort tiebreak needs nothing stored.

Three traps:

1. `applySort()` runs every render. Writing `style.order` unconditionally touches
   every child of every list every three seconds — the #516 fault. Guard on a
   signature of the resulting id sequence.
2. **The signature alone is not enough.** When Torn re-renders, the rows are *new
   elements carrying no order* while the id sequence is unchanged — signature
   matches, we skip, and the sort silently vanishes. Also check that the first row
   still carries an order.
3. Torn's own sort handler is bound by React **at the root container**, not on the
   header cell, so a header click needs `stopPropagation` or every click sorts the
   table twice, once each way.

Unknown values sort **last in both directions**. Half a war roster has no battle
stats on record, and an ascending sort that opens with 200 `???` rows has buried the
answer rather than found it.

---

## Status cell takeover

Wall Battlestats rewrites Torn's Status column into a live countdown and abbreviates
travel. We do the same from data the delta poll already carries — the reference has
to call `/v2/faction/{id}/members` every 15s **per faction** to learn what already
arrives on our poll.

**Torn's own status is authoritative on any disagreement.** Our roster copy is up to
three seconds stale; the page Torn just rendered is not. Deferring costs one stale
cell, overriding costs a member queueing a hit on a countdown that already ran out.

The authority baseline **re-stashes itself**: when the text in the cell is not the
text we last wrote, it is fresh from Torn and becomes the new baseline. Stashing it
only once poisons the check the first time React repaints.

`getCountryCode()` was worth stealing from Wall Battlestats — the destination-string
→ `CN`/`SA`/`UAE` mapping is tedious and already correct. It matches on **stems**
(`argentin`, `canad`, `mexic`) so it catches both the country and the demonym Torn
uses in hospital descriptions. ⚠️ `canad` cannot be shortened to `can` — "Cayman"
would match it.

---

## Duplicated logic that must stay in step

A userscript is one file with no build step, so it cannot import from the dashboard.
These are copied and **must not drift** — if they do, a member with both screens open
sees two different numbers and believes the wrong one.

| In the script | Source of truth |
|---|---|
| `statScore` | `frontend/src/utils/fairFight.js` |
| `fairFight` | `frontend/src/utils/fairFight.js` |
| `formatStat` | `frontend/src/utils/statInput.js` |
| `parseDbTime` | `frontend/src/utils/time.js` |
| `fmtAgo` | `frontend/src/utils/time.js` |
| `reviveAudience` | `frontend/src/utils/warRoomFlags.js` |
| `FLIGHT_SECONDS`, `travelEta`, `PLANE_TYPE_METHOD` | `frontend/src/utils/warRoomTravel.js` |

Notes on the trickier ones:

- **`statScore` is the sum of square ROOTS**, not of the stats. With only a total (a
  BSP estimate gives one number, not four) an even split is assumed: `4 × √(total/4)
  = 2√total`. That flatters lopsided builds and overstates FF; the dashboard makes
  the same trade deliberately.
- **`travelEta` picks the method per member** from Torn's `plane_image_type`. This is
  where we beat CAT rather than copy it — CAT has four speed tiers but the tier is a
  *global user setting*, one assumption applied to every traveller, so its ETA is
  confidently wrong for anyone flying differently.
- **`airliner` resolves to `business`.** Torn draws three aircraft for four methods,
  so `airliner` covers both the fastest and the slowest. In a war the question is
  "how soon could they be back", so the earlier candidate is what to plan against.
- **`reviveAudience` treats an Unknown setting as `anyone`** (#342). Torn reports
  Unknown when it will not disclose the preference, which is the normal case for an
  enemy — i.e. most of the roster. Degrading to `friends` paints the whole enemy side
  muted and buries the real distinction, which is that we hire *outside* revivers.

---

## Performance rules (#516)

`render()` runs every poll over every row. The original version rewrote ~10 style
properties on ~200 rows every 3 seconds, each write landing after a DOM read and so
forcing a synchronous layout. Almost none of those rows had changed.

- **Every per-row paint is signature-guarded.** An unchanged row must cost one string
  compare.
- **Anything that does not vary per row lives in the stylesheet**, not in
  `style.cssText`. A class costs one write, once.
- **State is a class, not an inline style.**
- **`scan()` does not render.** Sorting a column re-adds every row at once, the
  observer batches those into ~200 touched nodes, and calling `scan()` per node meant
  *one sort ran `render()` two hundred times*, each pass walking all 200 rows. The
  observer now scans each node and renders once, at the end.
- **The observer skips our own insertions.** Every column and badge we add is itself a
  mutation; without the guard the observer answers its own work, and on a page still
  rendering that is a feedback loop.

Countdowns tick locally at 1 Hz rather than by polling. Moving the poll to 1 Hz to
get the same effect would triple the load on the tenant for a number we can compute.

---

## Traps that have actually bitten

- **Duplicate function declarations.** There were two `headerFor`/`attackHeaderCell`
  pairs in the same scope. Later declarations win by hoisting, so the wrong pair ran
  and the correct one was dead code — which is why war-table headers never appeared,
  and it looked like a CSS problem for weeks.
- **Backticks in CSS comments.** The stylesheet is a template literal. A backtick in
  a comment inside it terminates the string early and the rest is parsed as
  JavaScript — `ReferenceError: button is not defined`. `node --check` does **not**
  catch this: the result is still valid syntax. There is now a smoke test that runs
  `injectStyles()` against a stub document.
- **The `+00` bare offset (#140).** Postgres serialises `timestamptz` as
  `2026-08-01T12:00:00+00`, which `new Date()` rejects outright. Every tooltip said
  "spied Invalid Date"; the same bug shipped in the dashboard's own travel ETA and
  meant the feature never rendered a single estimate in production.
- **`GM.xmlHttpRequest` names its payload `data`, not `body`.** A test asserting on
  `call.body` can never fail.
- **Snapshot and delta frames disagree about shape.** A `delta` carries `rows` at the
  top level; a `snapshot` nests every channel as `{ state: { rows } }`. Passing the
  snapshot's `{ rows }` object into `indexDibs` threw "rows is not iterable" inside
  the message listener — and a throw there is silent: the socket stays open, the
  panel says live, and not one badge ever appears.
- **`Number(null)` is 0.** A dib row with a missing target is indexed as a claim on
  player 0 — invisible, permanent, impossible to release. Check `> 0`, not just
  finite.
- **Tombstones are not absences.** `deleted_at` rows arrive *with* the row, and
  `war_room_state_v2` / `war_room_dibs_v2` are never pruned. On forge, 2026-08-19,
  a cold snapshot was 2627 dib rows to describe 1 live claim and 672 roster rows to
  describe 194 live members.
- **`war_room_state_v2` holds more than the current war.** Forge was holding rosters
  for six factions, four of them from wars months gone. "Not ours" is not the same as
  "the enemy" — the opponent comes from the config channel, which names exactly one
  faction.

---

## Race handling

The script **does not resolve races**. The server already does, in three layers: a
row lock, a partial unique index (`war_room_dibs_v2_active_target_idx`), and a 23505
handler that turns a genuine collision into a 409 naming the owner (#385 proved it
with a seeded concurrency harness).

Anything decided locally could only be a stale mirror of state another member is
mutating, and the failure mode is the worst available: telling you a target is yours
while the server gave it to someone else. Paint optimistically, let the server's
answer always overwrite, show the owner a 409 names.

The session token is read for **UI only**. It is signed and we cannot verify it here,
so a member could edit their stored session and hand themselves `is_admin`. That buys
nothing — the server's DELETE handler filters to `claimed_by = you` for anyone it
does not consider an admin. Never promote it to an actual guard.
