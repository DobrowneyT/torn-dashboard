# War Room push notifications — operator runbook (#207)

Background Web Push for the War Room: members opt in from a live war room and
receive notifications (incoming-push warnings #208, leader headlines #209) even
with the tab closed. This runbook is the one **operator step** — generating and
installing the VAPID keypair. Everything else is automatic.

Push stays **completely off** until VAPID is configured: the API endpoints exist
but deliver nothing, and the opt-in banner never appears. No key = no push, no
errors.

## 1. Generate a VAPID keypair (once per deployment)

VAPID identifies *this push server* to the browser push services — **one keypair
for the whole stack**, shared by every faction API process (it is not per-faction
secret data). Generate it once:

```bash
npx web-push generate-vapid-keys
```

Output:

```
Public Key:
BDuring...long-url-safe-base64...
Private Key:
xC...url-safe-base64...
```

## 2. Install it

Add all three to `deploy/.env` (see `deploy/.env.example`):

```dotenv
VAPID_PUBLIC_KEY=BDuring...   # the public key
VAPID_PRIVATE_KEY=xC...       # the private key — keep this secret
VAPID_SUBJECT=mailto:you@yourdomain.com   # a real contact, mailto: or https://
```

`docker compose up` passes these into every `api-*` service (wired by
`db/new-faction.mjs`, so factions added later inherit them). Restart the stack:

```bash
cd deploy && docker compose up -d
```

The API logs `Web Push armed (VAPID configured)` per faction on boot.

> **Rotating the keypair invalidates every existing subscription.** Browsers
> subscribed under the old public key silently stop receiving pushes until they
> re-opt-in. Rotate only when necessary; the stale rows self-prune on the next
> delivery (404/410).

## 3. Verify delivery end-to-end

1. Open the dashboard on a supported browser (Chrome/Edge/Android; **iOS
   requires the app be installed as a PWA first** — see #206 / the Install app
   menu item).
2. Enter a live war room. Accept the "Enable" push prompt (and the OS prompt).
3. As a war lead / leadership / admin, POST the test send:

   ```bash
   curl -X POST https://<host>/api/push/test \
     -H "authorization: Bearer <your session token>"
   ```

   A **"War Room test"** notification should appear even with the tab closed.
   The response is `{ "sent": N, "pruned": M, "failed": K }`.

## How it fits together

- **Subscriptions** live in the `push_subscriptions` table (one row per browser
  endpoint). Stale endpoints (HTTP 404/410 at delivery) are pruned automatically.
- **One service worker.** Push handling lives in `frontend/public/sw.js`
  alongside the PWA app-shell cache (#206) — there is never a second worker.
- **Reuse.** The delivery service (`server/src/push.ts`) exposes
  `sendToMembers(ids, payload)`, which the surge-alert (#208) and leader-headline
  (#209) slices call.
