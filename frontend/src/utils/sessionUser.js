// The cached session user: how it is built, and how to tell it has gone stale.
//
// ⚠️ **Every permission gate in the app reads this object, not the token.**
// `user.isWarLead`, `user.isAdmin` and the rest come from here, which is why it
// going stale is invisible in the worst way: `/api/auth/refresh` re-reads
// `role_assignments` and mints a token with fresh claims, so the SERVER starts
// honouring a new role immediately — while the UI keeps hiding the controls for
// it. #927: a war lead was granted the role and had to log out and back in,
// because `login()` was the only thing that ever wrote this object.
//
// ⚠️ Extracted here rather than left inline in `AuthContext` so that login and
// the background refresh build the object the SAME way. Two copies of this
// shape would drift, and the symptom of a drift is a permission that works on
// one path and not the other.

/**
 * Build the cached user from a `/api/bootstrap` payload.
 *
 * ⚠️ `lastLogin` is CARRIED, not regenerated. The refresh path rebuilds this
 * object every few hours, and stamping "now" each time would silently redate a
 * session that has not been logged into for a week.
 */
export function buildUserFromBootstrap(boot, { lastLogin } = {}) {
  const roles = boot?.user?.roles ?? []
  return {
    id: Number(boot.user.torn_user_id),
    // Roster name from bootstrap (login stubs it from Torn on first login);
    // the id-based fallback covers anybody not yet on the roster.
    name: boot.user.member_name || `Player ${boot.user.torn_user_id}`,
    factionId: null,
    factionPosition: roles.includes('leadership') ? 'Leadership'
      : roles.includes('admin') ? 'Admin'
      : 'Member',
    // Deliberately NO apiKey: in API mode the browser holds only the session
    // token — raw key material never reaches localStorage.
    accessLevel: 3,
    isLeadership: roles.includes('leadership'),
    isAdmin: roles.includes('admin'),
    isWarLead: roles.includes('warlead'),
    isOCManager: roles.includes('ocmanager'),
    // Whether the in-app feedback form is available (server has a PAT) — the
    // hamburger "Send feedback" entry is hidden when false (#253).
    feedbackEnabled: boot.feedback_enabled === true,
    // Last 4 chars of this user's own pooled key (#264) — shown masked in the
    // hamburger menu; null when no key is on file.
    apiKeyHint: boot.user.api_key_hint ?? null,
    // #894 — the API Key Usage disclosure this member last accepted, and
    // whether it is behind the current one. ⚠️ Both, not just the boolean:
    // without the version the client can show that somebody must re-accept but
    // never what changed.
    consentVersion: boot.user.consent_version ?? null,
    consentRequired: boot.user.consent_required === true,
    apiMode: true,
    lastLogin: lastLogin ?? new Date().toISOString(),
  }
}

/**
 * The fields a background refresh is allowed to notice has changed.
 *
 * ⚠️ `lastLogin` is deliberately ABSENT. It differs on every rebuild, so
 * including it would report "changed" every single refresh and re-render the
 * whole app on a timer for nothing.
 *
 * ⚠️ Wider than just the roles, on purpose. `consentRequired` has exactly the
 * same staleness bug: when the API Key Usage disclosure is bumped, a member with
 * a tab open would not be re-prompted until they happened to log in again —
 * which defeats the point of forcing a re-acceptance. Same mechanism, same fix,
 * so it would be strange to leave it broken.
 */
export const SESSION_SYNC_FIELDS = [
  'id', 'name', 'factionPosition',
  'isLeadership', 'isAdmin', 'isWarLead', 'isOCManager',
  'feedbackEnabled', 'apiKeyHint', 'consentVersion', 'consentRequired',
]

/**
 * Has anything the UI gates on actually changed?
 *
 * ⚠️ Compared field by field rather than by serialising both objects: key order
 * is not guaranteed across rebuilds, and `JSON.stringify` would report a
 * difference that is not one.
 */
export function sessionFieldsChanged(cached, fresh) {
  if (!cached || !fresh) return false
  return SESSION_SYNC_FIELDS.some((f) => cached[f] !== fresh[f])
}

/**
 * The roles that were gained and lost, for logging.
 *
 * ⚠️ Not used to decide anything — `sessionFieldsChanged` does that. This only
 * exists so the console line says WHAT changed, because "session updated" in a
 * bug report tells whoever reads it nothing.
 */
export function describeRoleDelta(cached, fresh) {
  const FLAGS = { isLeadership: 'leadership', isAdmin: 'admin', isWarLead: 'warlead', isOCManager: 'ocmanager' }
  const gained = []
  const lost = []
  for (const [flag, name] of Object.entries(FLAGS)) {
    if (!cached?.[flag] && fresh?.[flag]) gained.push(name)
    if (cached?.[flag] && !fresh?.[flag]) lost.push(name)
  }
  return { gained, lost }
}
