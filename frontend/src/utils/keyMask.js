// #264: render a stored key's last-4 hint as a masked string (••••<hint>). The
// full key never reaches the browser — only this hint from the server.
export function maskKeyHint(hint) {
  if (!hint) return null
  return `••••${hint}`
}
