// Client half of the CSV table export (#517).
//
// The download cannot be a plain link: the endpoint needs an Authorization
// header, and a `<a href>` navigation carries none. So the browser fetches the
// stream itself — which turns out to be the only way to honour the completion
// marker as well, because a navigation download has no chance to inspect what
// it saved.
import { apiFetch } from './apiClient'

/**
 * The server's trailer, anchored to the very end of the body.
 *
 * ⚠️ Why the client checks this at all: the export streams, so the 200 status
 * was sent before the first row was read. A database error at row 300,000
 * cannot become an error response — the browser receives a file that opens
 * perfectly and is missing two thirds of its data. This marker is the only
 * evidence that the server got to the end.
 */
const TRAILER = /(?:^|\r?\n)(# complete: (\d+) rows\r?\n?)$/

/**
 * Inspect the tail of a downloaded body.
 *
 * `markerBytes` counts ONLY the marker line, not the CRLF that ends the last
 * data row before it — trimming that too would leave the file without its
 * final line terminator.
 */
export function inspectTrailer(tail) {
  const m = TRAILER.exec(tail)
  if (!m) return { complete: false, rows: null, markerBytes: 0 }
  return {
    complete: true,
    rows: Number(m[2]),
    markerBytes: new TextEncoder().encode(m[1]).length,
  }
}

/** Drop `count` bytes from the end of a chunk list, dropping whole chunks first. */
export function trimBytes(chunks, count) {
  if (count <= 0) return chunks
  const out = chunks.slice()
  let left = count
  while (left > 0 && out.length > 0) {
    const last = out[out.length - 1]
    if (last.length <= left) {
      left -= last.length
      out.pop()
    } else {
      out[out.length - 1] = last.subarray(0, last.length - left)
      left = 0
    }
  }
  return out
}

/** How many trailing bytes to decode when looking for the marker. */
const TAIL_BYTES = 256

function decodeTail(chunks) {
  const tail = []
  let have = 0
  for (let i = chunks.length - 1; i >= 0 && have < TAIL_BYTES; i--) {
    tail.unshift(chunks[i])
    have += chunks[i].length
  }
  const joined = new Uint8Array(have)
  let at = 0
  for (const c of tail) { joined.set(c, at); at += c.length }
  return new TextDecoder().decode(joined)
}

/**
 * `<table>_<from>_<to>.csv`, with the punctuation a filesystem dislikes
 * flattened. The range is in the name because two exports of the same table
 * are otherwise indistinguishable in a downloads folder.
 */
export function csvFilename(table, from, to) {
  return `${table}_${from}_${to}.csv`.replace(/[^\w.\-]/g, '_')
}

/** TCT date + optional time → the bound the API accepts. */
export function tctBound(date, time) {
  if (!date) return null
  return time ? `${date}T${time}` : date
}

/**
 * Fetch an export and assemble it.
 *
 * Chunks are kept as byte arrays and handed straight to a Blob rather than
 * concatenated into a string: a 444k-row export is tens of megabytes, and a
 * JS string of that size is the one thing the server-side cursor was built to
 * avoid recreating in the browser.
 */
export async function fetchTableCsv({ table, from, to }, fetchImpl = apiFetch) {
  const path = `/api/export/${encodeURIComponent(table)}/csv` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const res = await fetchImpl(path)

  if (!res.ok) {
    // The error path DOES return JSON — nothing has streamed yet.
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.error ?? `Export failed (${res.status})` }
  }

  const chunks = []
  if (res.body?.getReader) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) chunks.push(value)
    }
  } else {
    // Test doubles and older runtimes hand back a whole buffer.
    chunks.push(new Uint8Array(await res.arrayBuffer()))
  }

  const { complete, rows, markerBytes } = inspectTrailer(decodeTail(chunks))
  return {
    ok: true,
    complete,
    rows,
    blob: new Blob(trimBytes(chunks, markerBytes), { type: 'text/csv;charset=utf-8' }),
  }
}

/** Hand a finished blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
