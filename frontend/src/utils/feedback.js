// Client-side helpers for the in-app feedback form (#253). The server is the
// source of truth for validation; these mirror it so the modal can give instant
// feedback and assemble a clean payload.

export const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: 'Bug' },
  { value: 'suggestion', label: 'Suggestion' },
]
export const FEEDBACK_TITLE_MAX = 200
export const FEEDBACK_DESC_MAX = 5000

// #254: attachments. Mirrors the server's allow-list and limits.
export const FEEDBACK_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const FEEDBACK_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
export const FEEDBACK_MAX_FILES = 5
export const FEEDBACK_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
/** `accept` attribute for the file input. */
export const FEEDBACK_ACCEPT = [...FEEDBACK_IMAGE_TYPES, ...FEEDBACK_VIDEO_TYPES].join(',')

export function isFeedbackImageType(type) {
  return FEEDBACK_IMAGE_TYPES.includes(type)
}
export function isFeedbackVideoType(type) {
  return FEEDBACK_VIDEO_TYPES.includes(type)
}

/**
 * Validate a chosen set of files (count / type / size). Accepts anything with
 * `{ type, size }` (a File or a plain object), so it's unit-testable.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateFeedbackFiles(files = []) {
  if (files.length > FEEDBACK_MAX_FILES) {
    return { ok: false, error: `Too many files (max ${FEEDBACK_MAX_FILES}).` }
  }
  for (const f of files) {
    if (!isFeedbackImageType(f.type) && !isFeedbackVideoType(f.type)) {
      return { ok: false, error: `Unsupported file type: ${f.type || 'unknown'}.` }
    }
    if (f.size > FEEDBACK_MAX_FILE_BYTES) {
      return { ok: false, error: `"${f.name || 'file'}" is over 10 MB.` }
    }
  }
  return { ok: true }
}

/**
 * What a version string may look like (#402). The server applies the same
 * pattern and is the real gate — this is only so the client never puts
 * something absurd on the wire.
 */
export const APP_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/

/**
 * Validate the form fields and assemble the POST payload.
 *
 * `appVersion` is passed in rather than read from `import.meta.env` here so
 * this stays a pure function — these tests run in node with no Vite env.
 *
 * @returns {{ ok: true, payload: {category,title,description,app_version?} } | { ok: false, error: string }}
 */
export function buildFeedbackPayload({ category, title, description, appVersion } = {}) {
  const cat = String(category || '').toLowerCase()
  if (cat !== 'bug' && cat !== 'suggestion') return { ok: false, error: 'Choose a category.' }

  const t = (title || '').trim()
  if (!t) return { ok: false, error: 'Add a short title.' }
  if (t.length > FEEDBACK_TITLE_MAX) return { ok: false, error: `Title is too long (max ${FEEDBACK_TITLE_MAX}).` }

  const d = (description || '').trim()
  if (d.length > FEEDBACK_DESC_MAX) return { ok: false, error: `Description is too long (max ${FEEDBACK_DESC_MAX}).` }

  const payload = { category: cat, title: t, description: d }
  // Omitted rather than sent empty when we don't have one: the field's absence
  // is meaningful (an old cached bundle), and the string "undefined" would be
  // stamped on a real issue as though it were a version. Note this never
  // affects `ok` — diagnostic metadata must not be able to block a report.
  if (typeof appVersion === 'string' && APP_VERSION_PATTERN.test(appVersion)) {
    payload.app_version = appVersion
  }
  return { ok: true, payload }
}
