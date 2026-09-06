/**
 * The fleet status page (#609 slice 3).
 *
 * ⚠️ One self-contained HTML string, no build step and no framework. The admin
 * container deliberately does not carry the frontend workspace: it would double
 * the image, add a Vite build to a service whose whole job is to still be
 * working when other things are not, and put a dependency tree on the box with
 * the largest blast radius in the stack. A status page is a table and a login
 * form — the simplest thing that can possibly work is also the most likely to
 * be working when you need it.
 *
 * ⚠️ Served unauthenticated on purpose, because it contains NO data. It is a
 * login form plus the script that calls `/api/admin/status` once a session
 * exists; everything worth protecting is behind that call.
 *
 * The session token lives in `sessionStorage`, not `localStorage`: it is
 * cleared when the tab closes, which is the right lifetime for an operator
 * console reached from whatever device happens to be to hand.
 */
export function statusPageHtml(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Fleet Status</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #fff; --ink: #14181f; --muted: #63707f;
    --line: #e3e7ec; --ok: #1a7f4b; --warn: #a86800; --bad: #c0342b; --accent: #2b5fd9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #10141a; --panel: #171d26; --ink: #e8edf4; --muted: #93a1b3;
      --line: #262f3c; --ok: #46c98a; --warn: #e0a33a; --bad: #f0736a; --accent: #7aa2ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1000px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { font-size: 19px; margin: 0; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input {
    width: 100%; padding: 9px 11px; margin-bottom: 12px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-size: 14px;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    padding: 9px 16px; border: 0; border-radius: 7px; background: var(--accent);
    color: #fff; font-weight: 600; font-size: 14px; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  .err { color: var(--bad); font-size: 13px; margin-top: 8px; min-height: 18px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .03em; }
  .pill.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .pill.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .pill.bad { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .stat .v { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .hide { display: none !important; }
  .scroll { overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Fleet Status</h1>
    <span class="meta">control plane v${version} · <span id="stamp">—</span></span>
  </header>

  <div class="card" id="loginCard">
    <h2>Sign in</h2>
    <form id="loginForm" autocomplete="on">
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required>
      <label for="c">Authenticator code</label>
      <input id="c" name="code" inputmode="numeric" autocomplete="one-time-code"
             pattern="[0-9]{6}" maxlength="6" placeholder="000000" required>
      <button type="submit" id="go">Sign in</button>
      <div class="err" id="loginErr"></div>
    </form>
  </div>

  <div id="dash" class="hide">
    <div class="card">
      <h2>Fleet</h2>
      <div class="grid" id="stats"></div>
    </div>
    <div class="card">
      <h2>Tenants</h2>
      <div class="scroll"><table>
        <thead><tr><th>Faction</th><th>State</th><th>DB</th><th>Scheduler</th><th>Ticker</th><th>Model</th><th class="num">Latency</th></tr></thead>
        <tbody id="tenants"></tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Backups &amp; disk</h2>
      <div class="grid" id="ops"></div>
      <div id="missing" class="err"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var KEY = 'tnl-admin-token';
  var $ = function (id) { return document.getElementById(id); };
  var token = null;
  try { token = sessionStorage.getItem(KEY); } catch (e) { token = null; }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pill(state) {
    var cls = state === 'ok' ? 'ok' : state === 'degraded' ? 'warn' : 'bad';
    return '<span class="pill ' + cls + '">' + esc(state) + '</span>';
  }
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }
  function bytes(n) {
    if (!n) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + ' ' + u[i];
  }

  function show(authed) {
    $('loginCard').classList.toggle('hide', authed);
    $('dash').classList.toggle('hide', !authed);
  }

  function signOut() {
    token = null;
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    show(false);
  }

  function render(s) {
    $('stamp').textContent = new Date(s.generatedAt).toLocaleTimeString();

    var up = s.tenants.filter(function (t) { return t.state === 'ok'; }).length;
    var g = s.global || {};
    $('stats').innerHTML =
      stat('Tenants up', up + ' / ' + s.tenants.length) +
      stat('Postgres', pill(s.postgres.state === 'ok' ? 'ok' : 'down')) +
      stat('Global schema', g.schemaVersion == null ? '—' : 'v' + g.schemaVersion) +
      stat('OC model', g.ocModelVersion ? esc(g.ocModelVersion) : 'not published');

    $('tenants').innerHTML = s.tenants.map(function (t) {
      var model = t.global && typeof t.global === 'object'
        ? (t.global.oc_model_version || 'v' + t.global.schema_version)
        : esc(String(t.global || '—'));
      return '<tr><td><strong>' + esc(t.slug) + '</strong>' +
        (t.error ? '<br><code>' + esc(t.error) + '</code>' : '') + '</td>' +
        '<td>' + pill(t.state) + '</td>' +
        '<td>' + esc(t.db || '—') + '</td>' +
        '<td>' + esc(t.scheduler || '—') + '</td>' +
        '<td>' + esc(t.ticker || '—') + '</td>' +
        '<td>' + model + '</td>' +
        '<td class="num">' + (t.latencyMs == null ? '—' : t.latencyMs + ' ms') + '</td></tr>';
    }).join('');

    var b = s.backups || {};
    // A backup that has been failing for weeks is worse than none, so age is
    // the headline rather than the count.
    var age = b.newestAgeHours == null
      ? '<span class="pill bad">none</span>'
      : b.newestAgeHours > 48
        ? '<span class="pill bad">' + b.newestAgeHours.toFixed(0) + 'h</span>'
        : b.newestAgeHours > 26
          ? '<span class="pill warn">' + b.newestAgeHours.toFixed(0) + 'h</span>'
          : b.newestAgeHours.toFixed(0) + 'h';
    var d = s.disk;
    var diskCell = !d ? '—'
      : (d.usedPercent > 90
          ? '<span class="pill bad">' + d.usedPercent.toFixed(0) + '%</span>'
          : d.usedPercent > 80
            ? '<span class="pill warn">' + d.usedPercent.toFixed(0) + '%</span>'
            : d.usedPercent.toFixed(0) + '%');
    $('ops').innerHTML =
      stat('Newest backup', age) +
      stat('Dumps on disk', b.count == null ? '—' : b.count) +
      stat('Disk used', diskCell) +
      stat('Free space', d ? bytes(d.freeBytes) : '—');
    $('missing').textContent = (b.missing && b.missing.length)
      ? 'No backup on record for: ' + b.missing.join(', ')
      : (b.error ? 'Backups unreadable: ' + b.error : '');
  }

  function load() {
    return fetch('/api/admin/status', { headers: { authorization: 'Bearer ' + token } })
      .then(function (r) {
        // An expired session must return to the login form rather than
        // silently showing stale numbers.
        if (r.status === 401) { signOut(); return null; }
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      })
      .then(function (s) { if (s) { show(true); render(s); } })
      .catch(function (e) { $('stamp').textContent = 'refresh failed: ' + e.message; });
  }

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('go').disabled = true;
    $('loginErr').textContent = '';
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('u').value, password: $('p').value, code: $('c').value })
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.b.error || 'Sign-in failed');
        token = res.b.token;
        try { sessionStorage.setItem(KEY, token); } catch (e) {}
        $('p').value = ''; $('c').value = '';
        return load();
      })
      .catch(function (e) { $('loginErr').textContent = e.message; })
      .finally(function () { $('go').disabled = false; });
  });

  if (token) load();
  setInterval(function () { if (token) load(); }, 30000);
})();
</script>
</body>
</html>`
}
