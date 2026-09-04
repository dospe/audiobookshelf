/**
 * Text extractor for binary Word documents (.doc).
 *
 * Word 97-2003 files are read through the piece table (CLX) in the table
 * stream, older Word 6/95 files through the raw fcMin..fcMac text range.
 * Character formatting (CHPX) is not interpreted; every paragraph is a <p>.
 */

import { CompoundFile } from './cfb.js'
import { DocumentParseError } from './documentError.js'
import { codepageForLid, decodeBytes } from './textEncoding.js'

const FIB_WORD97 = 0xc1

/**
 * @param {Uint8Array} bytes
 * @param {{ legacyEncoding?: string }} [options]
 * @returns {{ blocks: Array, usedFallbackEncoding: boolean }}
 */
export function parseDoc(bytes, options = {}) {
  const cfb = new CompoundFile(bytes)
  const wordDocument = cfb.readStream('WordDocument')
  if (!wordDocument || wordDocument.length < 0x20) {
    throw new DocumentParseError('unsupported', 'No WordDocument stream (not a Word file)')
  }
  const fib = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength)
  const wIdent = fib.getUint16(0, true)
  if (wIdent !== 0xa5ec && wIdent !== 0xa5dc) {
    throw new DocumentParseError('unsupported', 'Not a Word document')
  }
  const nFib = fib.getUint16(2, true)
  const lid = fib.getUint16(6, true)
  const flags = fib.getUint16(0x0a, true)
  const fComplex = !!(flags & 0x0004)
  const fEncrypted = !!(flags & 0x0100)
  const fWhichTblStm = !!(flags & 0x0200)
  if (fEncrypted) throw new DocumentParseError('encrypted', 'Word document is encrypted')

  let text = ''
  if (nFib < FIB_WORD97) {
    if (fComplex) throw new DocumentParseError('unsupported', 'Fast-saved Word 6/95 documents are not supported')
    const fcMin = fib.getUint32(0x18, true)
    const fcMac = fib.getUint32(0x1c, true)
    const encoding = options.legacyEncoding || codepageForLid(lid)
    text = decodeBytes(wordDocument.subarray(fcMin, Math.min(fcMac, wordDocument.length)), encoding)
  } else {
    const tableStream = cfb.readStream(fWhichTblStm ? '1Table' : '0Table') || cfb.readStream(fWhichTblStm ? '0Table' : '1Table')
    if (!tableStream) throw new DocumentParseError('corrupt', 'Missing table stream')
    const ccpText = fib.getInt32(0x4c, true)
    const fcClx = fib.getUint32(0x1a2, true)
    const lcbClx = fib.getUint32(0x1a6, true)
    const pieces = readPieceTable(tableStream, fcClx, lcbClx)
    if (!pieces.length) {
      // Fall back to the raw text range
      const fcMin = fib.getUint32(0x18, true)
      const fcMac = fib.getUint32(0x1c, true)
      text = decodeBytes(wordDocument.subarray(fcMin, Math.min(fcMac, wordDocument.length)), 'windows-1252')
    } else {
      // Compressed pieces are Windows-1252 by specification; other characters
      // are always stored in UTF-16 pieces
      const ansiEncoding = 'windows-1252'
      const parts = []
      let cpRemaining = ccpText > 0 ? ccpText : Number.MAX_SAFE_INTEGER
      for (const piece of pieces) {
        if (cpRemaining <= 0) break
        const count = Math.min(piece.cpEnd - piece.cpStart, cpRemaining)
        if (count <= 0) continue
        if (piece.compressed) {
          const start = piece.fc
          parts.push(decodeBytes(wordDocument.subarray(start, Math.min(start + count, wordDocument.length)), ansiEncoding))
        } else {
          const start = piece.fc
          parts.push(decodeBytes(wordDocument.subarray(start, Math.min(start + count * 2, wordDocument.length)), 'utf-16le'))
        }
        cpRemaining -= count
      }
      text = parts.join('')
    }
  }

  return { blocks: textToBlocks(text), usedFallbackEncoding: false }
}

/**
 * Parse the CLX structure into text pieces.
 *
 * @param {Uint8Array} table
 * @param {number} fcClx
 * @param {number} lcbClx
 * @returns {Array<{ cpStart: number, cpEnd: number, fc: number, compressed: boolean }>}
 */
function readPieceTable(table, fcClx, lcbClx) {
  if (!lcbClx || fcClx + lcbClx > table.length) return []
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength)
  let pos = fcClx
  const end = fcClx + lcbClx
  while (pos < end) {
    const clxt = view.getUint8(pos)
    if (clxt === 0x01) {
      const cb = view.getUint16(pos + 1, true)
      pos += 3 + cb
      continue
    }
    if (clxt !== 0x02) return []
    const lcb = view.getUint32(pos + 1, true)
    pos += 5
    const n = Math.floor((lcb - 4) / 12)
    if (n <= 0) return []
    const cps = []
    for (let i = 0; i <= n; i++) cps.push(view.getUint32(pos + i * 4, true))
    let pcdPos = pos + (n + 1) * 4
    const pieces = []
    for (let i = 0; i < n; i++) {
      const fcRaw = view.getUint32(pcdPos + 2, true)
      const compressed = !!(fcRaw & 0x40000000)
      const fc = compressed ? (fcRaw & 0x3fffffff) >>> 1 : fcRaw & 0x3fffffff
      pieces.push({ cpStart: cps[i], cpEnd: cps[i + 1], fc, compressed })
      pcdPos += 8
    }
    return pieces
  }
  return []
}

/**
 * Split Word text into paragraph blocks. Paragraph marks are CR (0x0D);
 * field codes, pictures and other control characters are removed.
 *
 * @param {string} text
 */
function textToBlocks(text) {
  const blocks = []
  let runs = []
  let current = ''
  let fieldDepth = 0
  let inFieldCode = false

  const pushBlock = () => {
    if (current) runs.push({ text: current })
    current = ''
    if (runs.some((r) => r.text && r.text.trim())) blocks.push({ type: 'p', runs })
    runs = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = text.charCodeAt(i)
    if (code === 0x13) {
      fieldDepth++
      inFieldCode = true
      continue
    }
    if (code === 0x14) {
      inFieldCode = false
      continue
    }
    if (code === 0x15) {
      if (fieldDepth > 0) fieldDepth--
      inFieldCode = false
      continue
    }
    if (inFieldCode) continue
    if (code === 0x0d || code === 0x0c || code === 0x07 || code === 0x0e || code === 0x0f) {
      pushBlock()
      continue
    }
    if (code === 0x0b) {
      if (current) runs.push({ text: current })
      current = ''
      runs.push({ br: true })
      continue
    }
    if (code === 0x1e) {
      current += '‑'
      continue
    }
    if (code === 0x1f) {
      continue
    }
    if (code < 0x20 && code !== 0x09) continue
    current += ch
  }
  pushBlock()
  return blocks
}
