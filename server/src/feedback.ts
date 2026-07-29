// In-app feedback (#253): an authenticated faction member submits a bug or
// suggestion, and the server files a triaged GitHub issue in the shared repo via
// a server-side PAT. The submitter's Torn identity is taken from the SESSION
// (never the request body) and stamped on the issue along with the tenant slug.
// Visitors are read-only. The feature is disabled (endpoint 501, nav entry
// hidden) when no PAT is configured.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireNotVisitor } from './authz.js'
import { factionIdentity } from './auth.js'

export interface FeedbackDeps {
  db: pg.Pool
  /** Fine-grained PAT with issues:write on the target repo. Unset ⇒ disabled. */
  githubToken?: string
  /** Target repo "owner/name". */
  githubRepo?: string
  /** GitHub API base URL; defaults to the public API (test override). */
  githubBaseUrl?: string
  /** Triage label applied to every feedback issue. */
  label?: string
}

const CATEGORIES = new Set(['bug', 'suggestion'])
const CATEGORY_LABEL: Record<string, string> = { bug: 'Bug', suggestion: 'Suggestion' }
const TITLE_MAX = 200
const DESC_MAX = 5000
// Simple abuse guard: a handful of submissions per rolling hour, per user.
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60 * 60 * 1000

/** Whether feedback is wired up (a token + repo are configured). */
export function feedbackConfigured(deps: Pick<FeedbackDeps, 'githubToken' | 'githubRepo'>): boolean {
  return Boolean(deps.githubToken && deps.githubRepo)
}

/** The GitHub issue body — records category, submitter identity, tenant, text. */
export function buildFeedbackIssueBody(params: {
  category: string
  description: string
  submitterName: string
  submitterId: string
  slug: string
}): string {
  return [
    `**Category:** ${CATEGORY_LABEL[params.category] ?? params.category}`,
    `**Submitted by:** ${params.submitterName} [${params.submitterId}]`,
    `**Faction:** ${params.slug}`,
    '',
    params.description || '_(no description provided)_',
  ].join('\n')
}

/** Create a GitHub issue via the REST API; throws on a non-2xx response. */
export async function createGithubIssue(
  baseUrl: string,
  token: string,
  repo: string,
  payload: { title: string; body: string; labels: string[] }
): Promise<{ number: number; html_url: string }> {
  const res = await fetch(`${baseUrl}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'torn-forge-dashboard',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`GitHub issue create failed: ${res.status}`)
  return (await res.json()) as { number: number; html_url: string }
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackDeps) {
  const enabled = feedbackConfigured(deps)
  const baseUrl = deps.githubBaseUrl || 'https://api.github.com'
  const label = deps.label || 'needs-triage'
  // Per-user submission timestamps for the rate limit. In-process is fine — the
  // API runs one process per tenant.
  const submissions = new Map<string, number[]>()

  app.post('/api/feedback', { preHandler: requireNotVisitor() }, async (req, reply) => {
    if (!enabled) return reply.status(501).send({ error: 'Feedback is not configured' })

    const userId = String(req.session!.torn_user_id)
    const now = Date.now()
    const recent = (submissions.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
    if (recent.length >= RATE_LIMIT) {
      return reply.status(429).send({ error: 'Too many feedback submissions — please try again in a bit.' })
    }

    const body = (req.body ?? {}) as { category?: unknown; title?: unknown; description?: unknown }
    const category = String(body.category ?? '').toLowerCase()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (!CATEGORIES.has(category)) return reply.status(400).send({ error: 'category must be "bug" or "suggestion"' })
    if (!title) return reply.status(400).send({ error: 'title is required' })
    if (title.length > TITLE_MAX) return reply.status(400).send({ error: `title too long (max ${TITLE_MAX} chars)` })
    if (description.length > DESC_MAX) return reply.status(400).send({ error: `description too long (max ${DESC_MAX} chars)` })

    // Submitter identity is authoritative from the session — a spoofed id in the
    // request body is never trusted.
    const config = await factionIdentity(deps.db)
    const named = await deps.db.query('SELECT member_name FROM members WHERE member_id = $1', [userId])
    const submitterName = named.rows[0]?.member_name ?? `Member ${userId}`

    const issueBody = buildFeedbackIssueBody({
      category, description, submitterName, submitterId: userId, slug: config.slug,
    })
    const issueTitle = `[${CATEGORY_LABEL[category]}] ${title}`

    let created: { number: number; html_url: string }
    try {
      created = await createGithubIssue(baseUrl, deps.githubToken!, deps.githubRepo!, {
        title: issueTitle, body: issueBody, labels: [label],
      })
    } catch (err) {
      req.log.error({ err }, 'feedback: GitHub issue creation failed')
      return reply.status(502).send({ error: 'Could not file the feedback issue — please try again later.' })
    }

    recent.push(now)
    submissions.set(userId, recent)
    return { url: created.html_url, number: created.number }
  })
}
