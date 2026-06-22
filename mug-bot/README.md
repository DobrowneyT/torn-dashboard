# Mug Bot

Self-hosted Torn item-market monitor + Discord alerts. A single Python process runs a
FastAPI ingest server (receives data the userscript forwards from the **page you are
actively viewing**) and a discord.py bot that posts to three channels:

- **logs** — a mug-alert embed per qualifying sale (seller, mug range, TBS, attack link).
- **status-tracker** — 🟢/🔴 per actively-viewed page + cache counts.
- **items** — alerts when something is listed well under market value.

Storage is SQLite on the box. **This folder is fully self-contained** — no imports or config
dependencies on the rest of the repo; copy it to a standalone server and run it on its own. All
secrets/config live in `mug-bot/.env`.

## Compliance (read this)

Torn's updated scripting rules permit scraping/forwarding the WebSocket of a page **you are
actively viewing** (foreground + visible + interacting); they forbid it for pages you are
**not** actively viewing. The hardened `market-tracker` userscript therefore only connects
and forwards while `document.visibilityState === 'visible' && document.hasFocus()`, and
disconnects the instant the tab is hidden or loses focus. Do not run it on background tabs /
many pages. If ever unsure, ask Torn staff (the announcement invites it).

## Layout

```
main.py            entrypoint: uvicorn + discord.py on one asyncio loop
config.py          thresholds, windows, channel ids, Torn URLs
server/            FastAPI ingest (app.py), SQLite (db.py, schema.sql)
bot/               discord_bot.py (live), formatter.py (embeds), state.py, mock_data.py
scratch/           format_preview.py (mock embeds), dumps/ (raw payload captures)
systemd/           mug-bot.service
```

## Setup

```bash
cd mug-bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill token + channel ids + Torn/BSP keys (all live in this .env)
```

## Track A — iterate on the embeds with mock data (no server needed)

Set `MUG_BOT_DISCORD_TOKEN` + `MUG_PREVIEW_CHANNEL_ID` in `.env`, then:

```bash
python scratch/format_preview.py
```

First run posts one message per embed type; reruns edit them in place after each
`bot/formatter.py` tweak.

## Run the server (Phase 0 — discovery)

```bash
python main.py
# POSTs to /market, /status, /gear are dumped to scratch/dumps/*.jsonl AND raw_events,
# so we can inspect the real WebSocket schema before writing the Phase 1 parser.
curl -s localhost:3001/health | python3 -m json.tool
```

Point the hardened `market-tracker.user.js` at `http://<box-ip>:3001`, actively view an
item-market page, and watch `scratch/dumps/market-*.jsonl` fill in.

## Discord bot setup

1. https://discord.com/developers/applications → **New Application** (e.g. "Mug Bot").
2. **Bot** tab → **Reset Token** → copy into `MUG_BOT_DISCORD_TOKEN`. No privileged intents needed.
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions **Send Messages**,
   **Embed Links**, **Read Message History**. Open the URL and invite the bot to your server.
4. Discord → Settings → Advanced → enable **Developer Mode**. Then right-click each channel →
   **Copy Channel ID** and the server icon → **Copy Server ID**, and fill `.env`:
   `MUG_LOGS_CHANNEL_ID`, `MUG_STATUS_CHANNEL_ID`, `MUG_ITEMS_CHANNEL_ID`, `MUG_GUILD_ID`
   (+ `MUG_PREVIEW_CHANNEL_ID` for embed previews).
5. Start the bot. `/mugmin` registers automatically (instant when `MUG_GUILD_ID` is set):
   `/mugmin 30m` sets the alert threshold (measured on the **mug** value = 5% of accumulated
   sales, clothing-adjusted); `/mugmin` alone shows the current value.

Mug-alert border colour reflects a fresh status check at alert time: **🟢 online**, **🔴 in
hospital**, **🔵 offline/idle**.

### Slash commands

- `/mugmin [value]` — show/set the alert threshold (mug value, e.g. `5m`, `30m`).
- `/watch list|add|remove|enable|disable <item>` — manage which items the poller watches. `add`
  autocompletes from the full catalog (name or id); the rest autocomplete from your current list.
  Items are also auto-added (enabled) when the item-matcher first captures a seller for them.
- `/keys list|add|remove` — manage the Torn API key pool. `add` validates the key (confirms access
  + records the owner id/name/level); a key that errors at runtime is auto-disabled and a notice is
  posted to the status channel. Keys in `TORN_API_KEYS` are seeded into the pool on first start.

The `status-tracker` panel shows captured-seller counts + the watch list (✅ enabled / ⬜ disabled,
sellers captured, listings tracked, last poll).

## WebSocket token

The userscript connects to Torn's Centrifugo WebSocket with a JWT whose payload is
`{"sub":"<your Torn user id>"}` — it's **per account, not per page**, and is reused for every
channel subscription. The committed value belongs to the original author; set `wsToken` in
`market-tracker.user.js` to **your own** token. (Follow-up: pull it live from the page instead
of hardcoding — see the plan.)

## Deploy (Debian package)

The app ships as a `.deb` that installs to `/home/monchoon/torn/mug-bot` and runs as the
`mug-bot` systemd service (enabled + started by the package's `postinst`).

**One command (test → build → scp → install over SSH), from your dev machine:**

```bash
python packaging/release.py            # default: full deploy (prompts for your sudo password)
python packaging/release.py --env      # also push your local .env (first deploy / .env changed)
python packaging/release.py --no-install   # build + scp only; install it yourself
```

It runs the tests, builds the `.deb`, scps it to `/tmp` on the box, and `apt install --reinstall`s
it over `ssh -t` — which restarts the service via the postinst. The DB and `.env` are preserved;
new schema tables auto-create on restart.

(Lower-level scripts also exist: `packaging/build-deb.sh [ver]` and `packaging/deploy.sh [ver]`.)

### The `.env` on the server

Only the **server** needs `.env` (Discord token + channel ids + Torn/BSP keys). It lives at
`/home/monchoon/torn/mug-bot/.env` and is **never** packaged. Two ways to provision it:

- **Edit in place (simplest):** the first install seeds `.env` from `.env.example`; then
  `sudo nano /home/monchoon/torn/mug-bot/.env`, fill it in, `sudo systemctl restart mug-bot`.
- **Push from your machine:** fill `mug-bot/.env` locally, then `python packaging/release.py --env`
  copies it to the right path, fixes ownership, and restarts the service.

Notes:
- The server needs internet at install time (postinst `pip install`s into the venv).
- Open inbound TCP 3001 on the box: `sudo ufw allow 3001/tcp`.
- **Persistent data:** the SQLite DB lives at `/var/lib/mug-bot/mug_bot.db` (created by the postinst),
  **outside** the install dir, so reinstalls/upgrades never touch your watch list, keys, or captures.
  `.env` (in the install dir) and the DB are never packaged, so both survive too. `apt purge` keeps
  `/var/lib/mug-bot` as well — delete it by hand for a true clean slate.
- **Schema migrations:** additive changes are automatic (`CREATE TABLE IF NOT EXISTS` + an
  `ALTER TABLE … ADD COLUMN` pass in `db._ensure_columns`). A *breaking* change (renamed/retyped
  column, data reshaping) needs a one-off migration step added to `db.init_db` before release —
  note it in the changelog since the DB persists across versions.
