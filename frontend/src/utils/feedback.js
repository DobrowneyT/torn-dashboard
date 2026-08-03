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
 * Validate the form fields and assemble the POST payload.
 * @returns {{ ok: true, payload: {category,title,description} } | { ok: false, error: string }}
 */
export function buildFeedbackPayload({ category, title, description } = {}) {
  const cat = String(category || '').toLowerCase()
  if (cat !== 'bug' && cat !== 'suggestion') return { ok: false, error: 'Choose a category.' }

  const t = (title || '').trim()
  if (!t) return { ok: false, error: 'Add a short title.' }
  if (t.length > FEEDBACK_TITLE_MAX) return { ok: false, error: `Title is too long (max ${FEEDBACK_TITLE_MAX}).` }

  const d = (description || '').trim()
  if (d.length > FEEDBACK_DESC_MAX) return { ok: false, error: `Description is too long (max ${FEEDBACK_DESC_MAX}).` }

  return { ok: true, payload: { category: cat, title: t, description: d } }
}
