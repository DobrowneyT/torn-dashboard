// `name [id]`, linking to the player's or faction's Torn page (MonChoon,
// 2026-10-18: "make them hyperlinks and present names with <username>
// [<user_id>] format ... for all of the tables and names").
import { profileUrl } from '../../utils/rollCallChase'

export const factionUrl = (id) => `https://www.torn.com/factions.php?step=profile&ID=${id}`

const LINK = 'text-blue-600 dark:text-blue-400 hover:underline'

/** The text, without the link — also what a cell's tooltip shows when truncated. */
export function tornLabel(id, name) {
  if (id == null) return name ?? 'Unknown'
  // A name the page could not resolve comes through as "#123"; show the id once.
  return name && !/^#\d+$/.test(name) ? `${name} [${id}]` : `[${id}]`
}

function TornLink({ href, id, name }) {
  const label = tornLabel(id, name)
  if (id == null) return <span>{label}</span>
  return (
    <a href={href(id)} target="_blank" rel="noopener noreferrer" className={LINK} title={label}>{label}</a>
  )
}

export function PlayerLink({ id, name }) {
  return <TornLink href={profileUrl} id={id} name={name} />
}

export function FactionLink({ id, name }) {
  return <TornLink href={factionUrl} id={id} name={name} />
}
