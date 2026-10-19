// @vitest-environment jsdom
// Phone uploads (#965): small images go as they are; failures say why.
import { describe, expect, it } from 'vitest'
import { prepareImage, uploadErrorMessage, formatBytes, SHRINK_ABOVE_BYTES } from '../imageUpload'

describe('prepareImage', () => {
  it('sends a small image untouched', async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'card.png', { type: 'image/png' })
    const out = await prepareImage(file)
    expect(out).toMatchObject({ type: 'image/png', shrunk: false, bytes: 4 })
    expect(out.data.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('refuses something that is not an image', async () => {
    await expect(prepareImage(new File(['x'], 'a.txt', { type: 'text/plain' }))).rejects.toThrow(/Choose an image/)
  })

  it('shrinks only above the threshold', () => {
    expect(SHRINK_ABOVE_BYTES).toBeGreaterThan(1024 * 1024)
  })
})

describe('uploadErrorMessage', () => {
  it('turns a proxy 413 into words', () => {
    expect(uploadErrorMessage(Object.assign(new Error('API error 413'), { status: 413 }))).toMatch(/too large/)
  })
  it('names a dropped connection', () => {
    expect(uploadErrorMessage(new TypeError('Failed to fetch'))).toMatch(/did not reach the server/)
  })
  it('keeps the server\'s own message otherwise', () => {
    expect(uploadErrorMessage(new Error('The card image must be 5 MB or smaller.'))).toBe('The card image must be 5 MB or smaller.')
  })
})

describe('formatBytes', () => {
  it('reads like a phone would', () => {
    expect(formatBytes(2.6 * 1024 * 1024)).toBe('2.6 MB')
    expect(formatBytes(340 * 1024)).toBe('340 KB')
  })
})
