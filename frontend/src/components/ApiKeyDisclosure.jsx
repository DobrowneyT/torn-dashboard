import { tornKeyGenUrl } from '../config'
import { getApiKeyTitle } from '../utils/factionIdentity'
import { KeyRound } from 'lucide-react'

// Single source of truth for the "how your API key is used" disclosure required
// by Torn's API ToS. As of 2.0 the dashboard uses ONE consolidated Limited key
// per member, so there's a single table (no more separate login/CPR sections).
// Reused by the login opt-in modal and the hamburger "API Key Usage" window so
// the wording can never drift between them.

export const ROWS = [
  ['Storage', 'Encrypted with AES-256-GCM, using a secret held only by the server process, and stored in your faction\'s own database (not shared with any other faction). The raw key never leaves the server in plaintext — clients, faction leadership, and the browser cannot read it, not even from the admin key-pool panel (which shows only status: consent date, key level, enabled/disabled). It is decrypted only inside the server process at the moment of use.'],
  ['Sharing', 'Your key is never shared with other members or other factions. Data fetched with it (CPR stats, member stats, war/attack history, live war-room state) is visible to your faction. One exception is narrower: your live energy and drug/medical/booster cooldowns (below) are shown only to war leads, leadership and admins — not to the faction at large.'],
  ['Purpose', 'Identity & faction verification, CPR (organised-crime) scraping, live War Room polling, and background faction data scrapers (cadence varies by job — every few minutes to once daily). To bypass Torn’s per-key cache, your key joins a rotating pool shared across these automated calls, so it may occasionally be used to fetch a teammate’s public stats or profile, not only your own.'],
  // #336: called out separately from the general "Purpose" row because it is
  // the only thing we read that is personal-state-in-the-moment rather than
  // faction data — members should be able to see it named, not infer it.
  ['Live War Stats', 'While a war room is active AND leadership has switched the sweep on, your key is used to read your own energy bar and your drug, medical and booster cooldowns (at most once every 30 seconds). A long drug cooldown is shown to war leads as an overdose indicator. This is used for war planning — who can hit, who is out of action — and is never read while the war room is off. Nerve, happy and life bars are returned by the same Torn call but are discarded, never stored.'],
  // #348: battle stats are the single most sensitive figure we hold about a
  // member, so they get their own disclosure row rather than being folded into
  // the general "Purpose" line.
  ['Battle Stats', 'Once a day your key is used to read your own battle stats (strength, defense, speed, dexterity). These are visible only to war leads, leadership and admins — never to the faction at large — and are used to plan who can be fielded against whom. If you have not enrolled a key, an estimate may instead be taken from your faction TornStats spy report or from Battle Stats Predictor; the dashboard records which source each figure came from, so an estimate is never presented as fact.'],
  // #459: named here as an OPT-IN, because it is the one use on this page that
  // is off unless you switch it on. Listing it alongside the rest without that
  // distinction would read as something already happening.
  ['Event Start Time (opt-in)', 'Off unless you turn it on, from Members → Calendar. When on, your key is used once a day for one extra call that returns only your chosen Torn event start hour ("11:30 TCT"), so the faction can see where everyone\'s 48-hour event window sits. Visible to your faction. Turning it off deletes the stored time rather than hiding it, and no other member can turn it on for you.'],
  // #889 slice 0: a NEW PURPOSE, so it gets its own row — the same way Live
  // War Stats (#336), Battle Stats (#348) and Event Start Time (#459) each did,
  // even though all of their endpoints were already in the "Torn API Calls"
  // line below. The endpoint list is a technical appendix; THIS is the consent.
  //
  // ⚠️ It is disclosed BEFORE the lookups begin, so members have time to
  // accept before anything uses it. "may be used" is accurate for a permission
  // that is granted but not yet exercised.
  ['Target Lookups', 'When a member adds somebody to the faction\u2019s shared target list (Members → Book of Grudges), your key may be used — as part of the rotating pool described above — to read that person\u2019s public profile (name, level, faction and current status), and the public member list of the faction they belong to. Unlike everything else on this page, these are people OUTSIDE your faction, chosen by whichever member added them, rather than your own teammates. Nothing about you is read by these calls. If you do not accept this, your key is simply skipped for them — everything else it already does carries on unchanged.'],
  ['Torn API Calls', 'GET /v2/key/info · GET /v2/user (basic, profile, personalstats, organizedcrimes, bars, cooldowns, battlestats) · GET /v2/user/calendar (opt-in only) · GET /v2/faction (crimes, members, contributors, chain, attacks, revives, rankedwars + report, basic)'],
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
