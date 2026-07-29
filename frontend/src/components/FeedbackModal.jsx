import { useState } from 'react'
import { X, MessageSquarePlus, ExternalLink } from 'lucide-react'
import { apiPost } from '../utils/apiClient'
import { buildFeedbackPayload, FEEDBACK_CATEGORIES, FEEDBACK_TITLE_MAX } from '../utils/feedback'

// In-app feedback form (#253): a member files a bug/suggestion that becomes a
// triaged GitHub issue server-side. Presentational — validation + payload
// assembly live in utils/feedback so they're unit-tested.
export default function FeedbackModal({ onClose }) {
  const [category, setCategory] = useState('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  const handleSubmit = async () => {
    const built = buildFeedbackPayload({ category, title, description })
    if (!built.ok) { setError(built.error); return }
    try {
      setSubmitting(true)
      setError(null)
      const res = await apiPost('/api/feedback', built.payload)
      setCreated(res)
    } catch (err) {
      setError(err?.message || 'Could not send feedback — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <MessageSquarePlus className="w-5 h-5" />
              Send feedback
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {created ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Thanks! Your feedback was sent to the team.
              </p>
              {created.url && (
                <a
                  href={created.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View your report <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-600"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Type</label>
                <div className="flex gap-2">
                  {FEEDBACK_CATEGORIES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setCategory(c.value)}
                      className={`px-3 py-1.5 text-sm rounded-lg border ${
                        category === c.value
                          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-500'
                          : 'border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">Title</label>
                <input
                  type="text"
                  value={title}
                  maxLength={FEEDBACK_TITLE_MAX}
                  onChange={(e) => setTitle(e.target.value)}
                  className="input w-full text-sm"
                  placeholder="Short summary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  Details <span className="font-normal text-gray-500 dark:text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  className="input w-full text-sm"
                  placeholder="What happened, or what you'd like to see"
                />
              </div>

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !title.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
