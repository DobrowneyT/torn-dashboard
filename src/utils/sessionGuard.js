// Gate for saved sessions restored from localStorage on app load.
//
// Sessions minted before the 2.0 consolidated-key rollout never passed
// through the API-key disclosure, so their keys never joined the rotation
// pool that powers CPR, the War Room, and the nightly scrapers. Those
// sessions carry no consentVersion (or an older one) — send them back
// through the login exactly once. config.apiKey.consentVersion is the
// lever: bumping it retires every existing session and re-prompts the
// disclosure site-wide.

export const RELOGIN_REASON =
  'One-time re-login needed: the dashboard now runs on a single Limited ' +
  'API key that also powers the faction’s shared data pool. Please log ' +
  'in again with your Limited key — you won’t be asked again.'

export function checkStoredSession(userData, currentConsentVersion) {
  if (!userData || typeof userData !== 'object') {
    return { ok: false, reason: RELOGIN_REASON }
  }
  if (userData.consentVersion !== currentConsentVersion) {
    return { ok: false, reason: RELOGIN_REASON }
  }
  return { ok: true }
}
