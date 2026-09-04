/**
 * Entry point for the "document" ebook formats (doc, docx, rtf, pdb).
 *
 * Every parser produces a list of blocks:
 *   { type: 'p' | 'h1'..'h6', runs: [{ text, bold?, italic?, br? }] }
 * which is serialized here into a small, safe HTML subset
 * (<p>, <h1>-<h6>, <strong>, <em>, <br>) with all text escaped.
 */

import { parseRtf } from './rtf.js'
import { parseDoc } from './doc.js'
import { parseDocx } from './docx.js'
import { parsePdb } from './pdb.js'
import { decodeWithFallback, textToBlocks } from './textEncoding.js'
import { DocumentParseError } from './documentError.js'

export { DocumentParseError }

export const DOCUMENT_FORMATS = ['doc', 'docx', 'rtf', 'pdb']

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c])
}

/**
 * Escape run text and turn tabs into em spaces (HTML collapses tabs).
 */
function runText(text) {
  return escapeHtml(String(text).replace(/\t/g, '\u2003'))
}

/**
 * Serialize blocks to HTML. Empty blocks are dropped so that the index of a
 * block element in the DOM matches the index of the paragraph for TTS and
 * reading progress.
 *
 * @param {Array<{ type: string, runs: Array<{ text: string, bold?: boolean, italic?: boolean, br?: boolean }> }>} blocks
 * @returns {string}
 */
export function blocksToHtml(blocks) {
  const html = []
  for (const block of blocks || []) {
    if (!block?.runs?.length) continue
    // Merge adjacent runs with the same formatting
    const parts = []
    let hasText = false
    const isHeading = /^h[1-6]$/.test(block.type)
    for (const run of block.runs) {
      if (run.br) {
        parts.push('<br>')
        continue
      }
      if (!run.text) continue
      if (run.text.trim()) hasText = true
      let piece = runText(run.text)
      // Headings are already bold, so bold runs inside them are redundant
      if (run.bold && !isHeading) piece = `<strong>${piece}</strong>`
      if (run.italic) piece = `<em>${piece}</em>`
      parts.push(piece)
    }
    if (!hasText) continue
    // Trim leading/trailing <br> so blocks do not start or end with empty lines
    while (parts.length && parts[0] === '<br>') parts.shift()
    while (parts.length && parts[parts.length - 1] === '<br>') parts.pop()
    const tag = isHeading ? block.type : 'p'
    html.push(`<${tag}>${parts.join('').replace(/<\/strong><strong>/g, '').replace(/<\/em><em>/g, '')}</${tag}>`)
  }
  return html.join('\n')
}

/**
 * Detect the container type from the leading bytes.
 *
 * @param {Uint8Array} bytes
 * @param {string} format extension hint
 * @returns {'rtf'|'doc'|'docx'|'pdb'|'text'}
 */
export function sniffFormat(bytes, format) {
  const head = Array.from(bytes.slice(0, 8))
  const startsWith = (sig) => sig.every((b, i) => head[i] === b)
  if (startsWith([0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf' // {\rtf
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc' // CFB
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return 'docx' // zip
  if (format === 'pdb' || looksLikePdb(bytes)) return 'pdb'
  if (format === 'rtf') return 'rtf'
  return 'text'
}

function looksLikePdb(bytes) {
  if (bytes.length < 78) return false
  // type/creator at 60..68 are printable ascii
  for (let i = 60; i < 68; i++) {
    if (bytes[i] < 0x20 || bytes[i] > 0x7e) return false
  }
  return true
}

/**
 * Parse a document file to HTML.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @param {{ format?: string, legacyEncoding?: string }} [options]
 * @returns {Promise<{ html: string, title?: string, usedFallbackEncoding: boolean, rawHtml?: boolean, blocks?: Array }>}
 */
export async function parseDocumentToHtml(data, options = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (!bytes.length) throw new DocumentParseError('corrupt', 'Empty file')
  const format = String(options.format || '').toLowerCase()
  const legacyEncoding = options.legacyEncoding || ''
  const kind = sniffFormat(bytes, format)

  let result
  try {
    if (kind === 'rtf') result = parseRtf(bytes, { legacyEncoding })
    else if (kind === 'doc') result = parseDoc(bytes, { legacyEncoding })
    else if (kind === 'docx') result = await parseDocx(bytes)
    else if (kind === 'pdb') result = await parsePdb(bytes, { legacyEncoding })
    else result = parsePlainText(bytes, { legacyEncoding })
  } catch (error) {
    if (error instanceof DocumentParseError) throw error
    console.error('[documentParser] parse failed', error)
    throw new DocumentParseError('corrupt', error?.message || 'Failed to parse document')
  }

  if (result.rawHtml) {
    return { html: result.rawHtml, title: result.title, usedFallbackEncoding: false, rawHtml: true }
  }
  const html = blocksToHtml(result.blocks)
  if (!html) throw new DocumentParseError('corrupt', 'Document contains no text')
  return { html, title: result.title, usedFallbackEncoding: !!result.usedFallbackEncoding, blocks: result.blocks }
}

function parsePlainText(bytes, { legacyEncoding }) {
  const decoded = decodeWithFallback(bytes, legacyEncoding)
  return { blocks: textToBlocks(decoded.text), usedFallbackEncoding: decoded.usedFallbackEncoding }
}
