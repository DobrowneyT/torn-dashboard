// The app version, read once from the repo-root VERSION file (the single
// source of truth — see CHANGELOG.md "How to bump"). Resolved relative to this
// module so it works both from source (server/src → ../../VERSION) and inside
// the container image, where deploy/server.Dockerfile copies VERSION to
// /app/VERSION alongside /app/server. If the file is missing we degrade to
// 'unknown' rather than crash — /api/health must always answer (see
// boot-degrade.test.ts).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const rel of ['../../VERSION', '../VERSION']) {
    try {
      const v = readFileSync(resolve(here, rel), 'utf8').trim()
      if (v) return v
    } catch {
      // try the next candidate
    }
  }
  return 'unknown'
}

export const APP_VERSION = readVersion()
