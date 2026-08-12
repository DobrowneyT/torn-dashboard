/**
 * The header version chip (#394).
 *
 * The version used to live only in the footer, which meant scrolling to the
 * bottom to read it — so nobody quoted it in a bug report, and #382 existed
 * because people were running stale builds without knowing.
 *
 * Pure on purpose: the component around it cannot be unit-tested (frontend
 * tests here run in node, with no jsdom), so all the decisions live here.
 *
 * @param {object}  opts
 * @param {string=} opts.running   the build this tab loaded (VITE_APP_VERSION)
 * @param {string=} opts.serving   the deployed build, from /api/health
 * @param {string=} opts.slug      tenant slug
 * @param {boolean=} opts.resolved has identity genuinely resolved? Defaults to
 *   true so a caller that already checked need not repeat itself.
 * @returns {{text: string, copyText: string, stale: boolean, title: string}|null}
 *   null when there is no running version — render nothing rather than a lie.
 */
export function versionLabel({ running, serving, slug, resolved = true } = {}) {
  if (!running) return null

  // Only trust a slug from a genuine bootstrap. The pre-bootstrap fallback is
  // Forge's identity, so an early read would label another tenant's report
  // "forge" — the exact silent-wrong-tenant failure of #249 and #393, and a
  // wrong tenant on a bug report is worse than no tenant at all.
  const tenant = resolved && slug ? slug : ''

  // A missing `serving` is no information (the /api/health probe failed or
  // hasn't run yet), not evidence of being current — and not evidence of being
  // stale either. An API outage must not turn every tab amber.
  const stale = Boolean(serving) && serving !== running

  const text = stale ? `v${running} → ${serving}` : `v${running}`

  // What actually gets pasted into a bug report.
  const copyText = [
    tenant ? `${running} / ${tenant}` : running,
    stale ? ` (server ${serving})` : '',
  ].join('')

  const title = stale
    ? `Running ${running}; ${serving} is deployed. Click to reload.`
    : `Version ${running}${tenant ? ` on ${tenant}` : ''}. Click to copy.`

  return { text, copyText, stale, title }
}
