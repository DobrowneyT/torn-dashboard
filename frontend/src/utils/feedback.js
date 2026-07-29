// Client-side helpers for the in-app feedback form (#253). The server is the
// source of truth for validation; these mirror it so the modal can give instant
// feedback and assemble a clean payload.

export const FEEDBACK_CATEGORIES = [
  { value: 'bug', label: 'Bug' },
  { value: 'suggestion', label: 'Suggestion' },
]
export const FEEDBACK_TITLE_MAX = 200
export const FEEDBACK_DESC_MAX = 5000

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
