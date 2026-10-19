/**
 * Getting an image off a phone and into a JSON upload (#965).
 *
 * ⚠️ Phone images are big: a camera photo is often 3–8 MB and a screenshot of
 * a tall page not far behind, and base64 adds a third on top. Anything over the
 * size worth sending is redrawn on a canvas — scaled down and re-encoded — so
 * an upload is a few hundred KB rather than several MB on a mobile connection.
 * Small images are sent untouched, so a crisp PNG card stays a PNG.
 */

/** Below this, the file is sent as-is. */
export const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024
/** The longest edge after shrinking — plenty for a card or a log screenshot. */
export const MAX_EDGE = 2400

export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read that file.'))
    r.readAsDataURL(file)
  })
}

/** "2.6 MB", "340 KB". */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return ''
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

/** Bytes a data URL decodes to. */
export function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] ?? ''
  return Math.floor((b64.length * 3) / 4)
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file)
  const url = await readAsDataUrl(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('That image could not be opened.'))
    img.src = url
  })
}

/**
 * The image as `{ type, data, bytes, shrunk }`, ready to send.
 *
 * ⚠️ If the browser cannot redraw it (no canvas, an exotic format), the
 * original is returned and the server's limit decides — never a silent drop.
 */
export async function prepareImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Choose an image (PNG, JPEG, WebP or GIF).')
  if (file.size <= SHRINK_ABOVE_BYTES || file.type === 'image/gif') {
    const data = await readAsDataUrl(file)
    return { type: file.type, data, bytes: file.size, shrunk: false }
  }
  try {
    const img = await decode(file)
    const w = img.width
    const h = img.height
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // WebP keeps text sharp at a fraction of PNG's size; JPEG where WebP
    // encoding is not supported (older Safari returns a PNG instead).
    let data = canvas.toDataURL('image/webp', 0.9)
    let type = 'image/webp'
    if (!data.startsWith('data:image/webp')) { data = canvas.toDataURL('image/jpeg', 0.9); type = 'image/jpeg' }
    const bytes = dataUrlBytes(data)
    if (bytes >= file.size) {
      const original = await readAsDataUrl(file)
      return { type: file.type, data: original, bytes: file.size, shrunk: false }
    }
    return { type, data, bytes, shrunk: true }
  } catch {
    const data = await readAsDataUrl(file)
    return { type: file.type, data, bytes: file.size, shrunk: false }
  }
}

/** A failed upload, said in words — a proxy's 413 carries no JSON message. */
export function uploadErrorMessage(err) {
  if (err?.status === 413) return 'That image is too large for the server. Try a smaller one.'
  if (err?.status === 401 || err?.status === 403) return 'You need to be signed in as leadership to do that.'
  if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message ?? '')) {
    return 'The upload did not reach the server — check your connection and try again.'
  }
  return err?.message || 'The upload failed.'
}
