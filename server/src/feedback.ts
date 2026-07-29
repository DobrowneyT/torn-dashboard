// In-app feedback (#253): an authenticated faction member submits a bug or
// suggestion, and the server files a triaged GitHub issue in the shared repo via
// a server-side PAT. The submitter's Torn identity is taken from the SESSION
// (never the request body) and stamped on the issue along with the tenant slug.
// Visitors are read-only. The feature is disabled (endpoint 501, nav entry
// hidden) when no PAT is configured.
import { randomUUID } from 'node:crypto'
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
  /** Public origin (e.g. https://forge.example.com) for embeddable attachment
   *  URLs. Falls back to the request's own scheme+host when unset. */
  publicBaseUrl?: string
}

const CATEGORIES = new Set(['bug', 'suggestion'])
const CATEGORY_LABEL: Record<string, string> = { bug: 'Bug', suggestion: 'Suggestion' }
const TITLE_MAX = 200
const DESC_MAX = 5000
// Simple abuse guard: a handful of submissions per rolling hour, per user.
const RATE_LIMIT = 5
const RATE_WINDOW_MS = 60 * 60 * 1000

// #254: attachments. Images render inline in the issue; video only as a link
// (GitHub inline-plays its own CDN uploads only).
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB each
const MAX_FILES = 5

export interface ParsedAttachment {
  id: string
  contentType: string
  bytes: Buffer
  isImage: boolean
  filename: string
}

function decodeBase64(input: string): Buffer {
  let b64 = input
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',')
    if (comma !== -1) b64 = b64.slice(comma + 1)
  }
  return Buffer.from(b64, 'base64')
}

/** Validate + decode the request's attachments. Returns parsed files or an error. */
export function parseAttachments(raw: unknown):
  | { ok: true; files: ParsedAttachment[] }
  | { ok: false; status: number; error: string } {
  if (raw === undefined || raw === null) return { ok: true, files: [] }
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'attachments must be an array' }
  if (raw.length > MAX_FILES) return { ok: false, status: 400, error: `too many files (max ${MAX_FILES})` }

  const files: ParsedAttachment[] = []
  for (const item of raw) {
    const a = (item ?? {}) as { content_type?: unknown; data_base64?: unknown; filename?: unknown }
    const contentType = String(a.content_type ?? '')
    const isImage = IMAGE_TYPES.has(contentType)
    const isVideo = VIDEO_TYPES.has(contentType)
    if (!isImage && !isVideo) {
      return { ok: false, status: 400, error: `unsupported file type: ${contentType || '(none)'}` }
    }
    if (typeof a.data_base64 !== 'string' || a.data_base64.trim() === '') {
      return { ok: false, status: 400, error: 'each attachment needs data_base64' }
    }
    const bytes = decodeBase64(a.data_base64)
    if (bytes.length === 0) return { ok: false, status: 400, error: 'decoded attachment is empty' }
    if (bytes.length > MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: `a file exceeds ${MAX_FILE_BYTES} bytes (10 MB)` }
    }
    const ext = contentType.split('/')[1] || 'bin'
    const filename = typeof a.filename === 'string' && a.filename.trim() ? a.filename.trim() : `${isImage ? 'image' : 'video'}.${ext}`
    files.push({ id: randomUUID(), contentType, bytes, isImage, filename })
  }
  return { ok: true, files }
}

/** Markdown that embeds attachments in the issue body (images inline, video as a link). */
export function buildAttachmentsSection(files: ParsedAttachment[], publicBase: string): string {
  if (files.length === 0) return ''
  const lines = ['', '---', '**Attachments:**', '']
  for (const f of files) {
    const url = `${publicBase}/api/feedback/attachments/${f.id}`
    lines.push(f.isImage ? `![${f.filename}](${url})` : `📎 [${f.filename}](${url})`)
  }
  return lines.join('\n')
}

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

/** Fetch a GitHub issue's state ('open' | 'closed'); throws on a non-2xx. */
export async function getGithubIssueState(
  baseUrl: string, token: string, repo: string, issueNumber: number
): Promise<string> {
  const res = await fetch(`${baseUrl}/repos/${repo}/issues/${issueNumber}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'torn-forge-dashboard',
    },
  })
  if (!res.ok) throw new Error(`GitHub issue fetch failed: ${res.status}`)
  return ((await res.json()) as { state?: string }).state ?? 'open'
}

export interface FeedbackPruneDeps {
  db: pg.Pool
  githubToken: string
  githubRepo: string
  githubBaseUrl?: string
  /** Hard cap: delete attachments older than this regardless of issue state. */
  ttlDays?: number
  /** Injectable clock for tests. */
  now?: () => Date
}

export interface FeedbackPruneResult {
  ttlDeleted: number
  closedIssuesPruned: number
  closedAttachmentsDeleted: number
  errors: number
}

/**
 * #255: delete stored feedback attachments once their linked issue is closed,
 * plus a hard TTL fallback for issues that never close. Resilient — a GitHub
 * error for one issue is counted and skipped, never aborting the run.
 */
export async function pruneFeedbackAttachments(deps: FeedbackPruneDeps): Promise<FeedbackPruneResult> {
  const baseUrl = deps.githubBaseUrl || 'https://api.github.com'
  const ttlDays = deps.ttlDays ?? 90
  const now = deps.now ? deps.now() : new Date()
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000)

  // 1. TTL sweep — anything past the cutoff goes regardless of issue state.
  const ttl = await deps.db.query(
    'DELETE FROM feedback_attachments WHERE created_at < $1', [cutoff.toISOString()]
  )
  const ttlDeleted = ttl.rowCount ?? 0

  // 2. Per-issue state check for what remains.
  const issues = await deps.db.query<{ issue_number: number }>(
    'SELECT DISTINCT issue_number FROM feedback_attachments'
  )
  let closedIssuesPruned = 0
  let closedAttachmentsDeleted = 0
  let errors = 0
  for (const { issue_number } of issues.rows) {
    try {
      const state = await getGithubIssueState(baseUrl, deps.githubToken, deps.githubRepo, issue_number)
      if (state === 'closed') {
        const del = await deps.db.query(
          'DELETE FROM feedback_attachments WHERE issue_number = $1', [issue_number]
        )
        closedAttachmentsDeleted += del.rowCount ?? 0
        closedIssuesPruned += 1
      }
    } catch {
      errors += 1 // one issue's failure must not abort the whole run
    }
  }
  return { ttlDeleted, closedIssuesPruned, closedAttachmentsDeleted, errors }
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: FeedbackDeps) {
  const enabled = feedbackConfigured(deps)
  const baseUrl = deps.githubBaseUrl || 'https://api.github.com'
  const label = deps.label || 'needs-triage'
  // Per-user submission timestamps for the rate limit. In-process is fine — the
  // API runs one process per tenant.
  const submissions = new Map<string, number[]>()

  // Base64 of up to 5×10 MB files (~67 MB) plus the text fields — generous ceiling.
  const POST_BODY_LIMIT = 75_000_000

  app.post('/api/feedback', { preHandler: requireNotVisitor(), bodyLimit: POST_BODY_LIMIT }, async (req, reply) => {
    if (!enabled) return reply.status(501).send({ error: 'Feedback is not configured' })

    const userId = String(req.session!.torn_user_id)
    const now = Date.now()
    const recent = (submissions.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
    if (recent.length >= RATE_LIMIT) {
      return reply.status(429).send({ error: 'Too many feedback submissions — please try again in a bit.' })
    }

    const body = (req.body ?? {}) as { category?: unknown; title?: unknown; description?: unknown; attachments?: unknown }
    const category = String(body.category ?? '').toLowerCase()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (!CATEGORIES.has(category)) return reply.status(400).send({ error: 'category must be "bug" or "suggestion"' })
    if (!title) return reply.status(400).send({ error: 'title is required' })
    if (title.length > TITLE_MAX) return reply.status(400).send({ error: `title too long (max ${TITLE_MAX} chars)` })
    if (description.length > DESC_MAX) return reply.status(400).send({ error: `description too long (max ${DESC_MAX} chars)` })

    const parsed = parseAttachments(body.attachments)
    if (!parsed.ok) return reply.status(parsed.status).send({ error: parsed.error })

    // Submitter identity is authoritative from the session — a spoofed id in the
    // request body is never trusted.
    const config = await factionIdentity(deps.db)
    const named = await deps.db.query('SELECT member_name FROM members WHERE member_id = $1', [userId])
    const submitterName = named.rows[0]?.member_name ?? `Member ${userId}`

    // Attachment URLs embed the app's public origin so GitHub can fetch them.
    const publicBase = (deps.publicBaseUrl || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '')
    const issueBody =
      buildFeedbackIssueBody({ category, description, submitterName, submitterId: userId, slug: config.slug }) +
      buildAttachmentsSection(parsed.files, publicBase)
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

    // Persist the files keyed to the issue (best-effort — the issue is already
    // filed; an orphaned embed 404s but the report stands).
    for (const f of parsed.files) {
      try {
        await deps.db.query(
          `INSERT INTO feedback_attachments (id, issue_number, content_type, bytes)
           VALUES ($1, $2, $3, $4)`,
          [f.id, created.number, f.contentType, f.bytes]
        )
      } catch (err) {
        req.log.error({ err }, 'feedback: attachment store failed')
      }
    }

    recent.push(now)
    submissions.set(userId, recent)
    return { url: created.html_url, number: created.number }
  })

  // Serve a stored attachment. PUBLIC + unguessable (uuid) — GitHub fetches it
  // to render the embed, so it can't require a session.
  app.get('/api/feedback/attachments/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'not found' })
    const res = await deps.db.query(
      'SELECT content_type, bytes FROM feedback_attachments WHERE id = $1', [id]
    )
    if (res.rows.length === 0) return reply.status(404).send({ error: 'not found' })
    reply.header('Content-Type', res.rows[0].content_type)
    reply.header('Cache-Control', 'public, max-age=86400')
    return reply.send(res.rows[0].bytes)
  })
}
