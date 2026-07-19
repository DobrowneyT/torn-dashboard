import { tornKeyGenUrl } from '../config'
import { getApiKeyTitle } from '../utils/factionIdentity'
import { KeyRound } from 'lucide-react'

// Single source of truth for the "how your API key is used" disclosure required
// by Torn's API ToS. As of 2.0 the dashboard uses ONE consolidated Limited key
// per member, so there's a single table (no more separate login/CPR sections).
// Reused by the login opt-in modal and the hamburger "API Key Usage" window so
// the wording can never drift between them.

const ROWS = [
  ['Storage', 'Encrypted with pgp_sym_encrypt and stored in a service-role-only Supabase table (member_secrets). The raw key never leaves the server in plaintext — clients, leadership, and the Supabase anon role cannot read it. It is decrypted only inside server-side functions (Edge Functions / scrapers) at the moment of use.'],
  ['Sharing', 'Your key is never shared with other members. Data fetched with it (CPR stats, war/attack history, live war-room state) is visible to faction members.'],
  ['Purpose', 'Identity & faction verification, CPR (organised-crime) scraping, live War Room polling, and the nightly faction data scrapers. To bypass Torn’s per-key cache, your key joins a rotating pool shared across these automated calls.'],
  ['Torn API Calls', 'GET /v2/key/info · GET /user (profile, personalstats, organizedcrimes) · GET /v2/faction (crimes, members, chain, attacks, rankedwars)'],
  ['Access Level', 'Limited Access'],
]

export default function ApiKeyDisclosure({ showGenerateButton = false }) {
  const keyTitle = getApiKeyTitle()
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        This dashboard uses your single Torn API key in accordance with{' '}
        <a
          href="https://www.torn.com/wiki.php#chapter=Terms-of-Service"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          Torn&apos;s API Terms of Service
        </a>
        . Here is exactly how your key is used and stored.
      </p>

      <div className="rounded-lg border border-gray-200 dark:border-slate-600 overflow-hidden">
        <table className="w-full text-xs">
          <tbody>
            {ROWS.map(([label, value]) => (
              <tr key={label} className="border-b border-gray-100 dark:border-slate-700 last:border-0">
                <td className="px-3 py-2 font-medium text-gray-700 dark:text-gray-300 w-1/3 bg-gray-50 dark:bg-slate-700/40 align-top">
                  {label}
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                  {label === 'Torn API Calls'
                    ? value.split(' · ').map((call, i) => (
                        <span key={i} className="block font-mono">{call}</span>
                      ))
                    : value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-500 italic">
        Your key is cleared from your browser when you log out. Revoke access at any
        time by generating a new key in Torn Preferences — the old one stops working immediately.
      </p>

      {showGenerateButton && (
        <a
          href={tornKeyGenUrl(keyTitle)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors"
        >
          <KeyRound className="w-4 h-4" />
          Generate Limited Key ({keyTitle})
        </a>
      )}
    </div>
  )
}
