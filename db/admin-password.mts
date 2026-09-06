// Generates admin control-plane credentials (#609 slice 2).
//
//   npx tsx db/admin-password.mts
//
// Prints the four lines to paste into deploy/.env, plus the otpauth:// URI to
// scan into an authenticator app.
//
// ⚠️ A .mts run under tsx, not a .mjs, so it imports the REAL hashing and TOTP
// code the server uses rather than a second copy. Two implementations of a
// password hash is how you end up with credentials that verify in one place and
// not the other.
//
// ⚠️ Nothing is written to disk and nothing is stored beyond the hash. The
// plaintext password is shown once, here, and cannot be recovered — re-run to
// set a new one.
import { createInterface } from 'node:readline/promises'
import { randomBytes } from 'node:crypto'
import { hashPassword } from '../server/src/adminPlane/password.js'
import { generateTotpSecret, totpUri } from '../server/src/adminPlane/totp.js'

/**
 * Read the two answers.
 *
 * ⚠️ Two paths on purpose. Interactively, readline gives real prompts. Piped,
 * readline's `question()` never SETTLES at EOF — it does not reject, it hangs —
 * and an unfinished top-level await exits Node with code 13, a stack trace, and
 * no output at all. On the step that mints the fleet's only credential that
 * reads as "the tool is broken", so the non-interactive path reads stdin
 * directly and says something useful when it is short.
 */
async function readAnswers(): Promise<{ username: string; password: string }> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const username = (await rl.question('Admin username: ')).trim()
      const password = (await rl.question('Admin password (input is visible — use a long one): ')).trim()
      return { username, password }
    } finally {
      rl.close()
    }
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  if (lines.length < 2) {
    console.error('Reading non-interactively: expected two lines on stdin (username, then password).')
    process.exit(2)
  }
  return { username: lines[0].trim(), password: lines[1].trim() }
}

const { username, password } = await readAnswers()

if (!username) {
  console.error('Username is required.')
  process.exit(2)
}
// ⚠️ 12 is a floor, not a recommendation. This credential fronts every tenant.
if (password.length < 12) {
  console.error('Password must be at least 12 characters — this is the fleet-wide credential.')
  process.exit(2)
}

const hash = await hashPassword(password)
const totpSecret = generateTotpSecret()
const sessionSecret = randomBytes(32).toString('hex')

console.log(`
Add these to deploy/.env:

ADMIN_USERNAME=${username}
ADMIN_PASSWORD_HASH=${hash}
ADMIN_TOTP_SECRET=${totpSecret}
ADMIN_SESSION_SECRET=${sessionSecret}

⚠️ ADMIN_SESSION_SECRET must NOT equal JWT_SECRET — the container refuses to
start if it does, because sharing it would make every tenant session token a
valid admin credential.

Scan this into your authenticator app (Aegis, 1Password, Google Authenticator):

  ${totpUri(totpSecret, username)}

Then check the app shows a code BEFORE you rely on it — a mistyped secret is
only discoverable at login, when you are already locked out.
`)
