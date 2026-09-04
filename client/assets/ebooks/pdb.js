/**
 * Palm Database (.pdb) ebook reader. Supported variants:
 *   - MobiPocket (BOOKMOBI)   -> delegated to the existing MOBI parser
 *   - PalmDOC (TEXtREAd)      -> PalmDOC LZ77 text
 *   - TealDoc (TEXtTlDc)      -> PalmDOC text with TealDoc tags stripped
 *   - eReader (PNRdPPrs)      -> PML markup, PalmDOC or zlib compressed
 *   - zTXT (zTXTGPlm)         -> zlib compressed text
 */

import pako from 'pako'
import MobiParser, { uncompression_lz77 } from './mobi.js'
import { DocumentParseError } from './documentError.js'
import { decodeBytes, decodeWithFallback, textToBlocks } from './textEncoding.js'

/**
 * @param {Uint8Array} bytes
 * @returns {{ name: string, type: string, creator: string, records: Uint8Array[] }}
 */
export function readPdb(bytes) {
  if (bytes.length < 78) throw new DocumentParseError('corrupt', 'File too small for a PDB header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start, len) => {
    let s = ''
    for (let i = start; i < start + len; i++) {
      if (!bytes[i]) break
      s += String.fromCharCode(bytes[i])
    }
    return s
  }
  const name = ascii(0, 32)
  const type = ascii(60, 4)
  const creator = ascii(64, 4)
  const numRecords = view.getUint16(76, false)
  if (78 + numRecords * 8 > bytes.length) throw new DocumentParseError('corrupt', 'Truncated PDB record list')
  const offsets = []
  for (let i = 0; i < numRecords; i++) offsets.push(view.getUint32(78 + i * 8, false))
  const records = offsets.map((offset, i) => {
    const end = i + 1 < offsets.length ? offsets[i + 1] : bytes.length
    return bytes.subarray(Math.min(offset, bytes.length), Math.min(Math.max(offset, end), bytes.length))
  })
  return { name, type, creator, records }
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

function palmdocDecompress(record) {
  return uncompression_lz77(record).shrink()
}

function inflate(data) {
  try {
    return pako.inflate(data)
  } catch (error) {
    throw new DocumentParseError('corrupt', 'zlib decompression failed')
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {{ legacyEncoding?: string }} [options]
 * @returns {Promise<{ blocks?: Array, rawHtml?: string, title?: string, usedFallbackEncoding: boolean }>}
 */
export async function parsePdb(bytes, options = {}) {
  const pdb = readPdb(bytes)
  const id = pdb.type + pdb.creator
  const title = pdb.name || undefined

  if (id === 'BOOKMOBI') {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const mobi = new MobiParser(buffer)
    const rendered = await mobi.render()
    const rawHtml = typeof rendered === 'string' ? rendered : rendered.outerHTML
    return { rawHtml, title, usedFallbackEncoding: false }
  }

  if (id === 'TEXtREAd' || id === 'TEXtTlDc') {
    const text = readPalmDoc(pdb, options)
    let content = text.text
    if (id === 'TEXtTlDc') content = content.replace(/<\/?(?:HEADER|LINK|BOOKMARK|LABEL|TEALPAINT|HRULE)[^>]*>/gi, '\n')
    return { blocks: textToBlocks(content), title, usedFallbackEncoding: text.usedFallbackEncoding }
  }

  if (id === 'PNRdPPrs') {
    return parseEReader(pdb, options, title)
  }

  if (id === 'zTXTGPlm') {
    const header = pdb.records[0]
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const numTextRecords = view.getUint16(2, false)
    const textRecords = pdb.records.slice(1, 1 + numTextRecords)
    let data
    try {
      data = inflate(concat(textRecords))
    } catch (error) {
      data = concat(textRecords.map((r) => inflate(r)))
    }
    const decoded = decodeWithFallback(data, options.legacyEncoding)
    return { blocks: textToBlocks(decoded.text), title, usedFallbackEncoding: decoded.usedFallbackEncoding }
  }

  throw new DocumentParseError('unsupported', `Unsupported PDB type "${pdb.type}${pdb.creator}"`)
}

function readPalmDoc(pdb, options) {
  const header = pdb.records[0]
  if (!header || header.length < 16) throw new DocumentParseError('corrupt', 'Missing PalmDOC header')
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const compression = view.getUint16(0, false)
  const recordCount = view.getUint16(8, false)
  if (compression !== 1 && compression !== 2) {
    throw new DocumentParseError('unsupported', `Unsupported PalmDOC compression ${compression}`)
  }
  const chunks = []
  for (let i = 1; i <= recordCount && i < pdb.records.length; i++) {
    const record = pdb.records[i]
    chunks.push(compression === 2 ? palmdocDecompress(record) : record)
  }
  const data = concat(chunks)
  return decodeWithFallback(data, options.legacyEncoding)
}

function parseEReader(pdb, options, title) {
  const header = pdb.records[0]
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const version = view.getUint16(0, false)
  let nonTextOffset
  let decompress
  if (version === 2 || version === 4) {
    nonTextOffset = view.getUint16(8, false)
    decompress = palmdocDecompress
  } else if (version === 10) {
    nonTextOffset = view.getUint16(12, false)
    decompress = inflate
  } else if (version === 260 || version === 272) {
    throw new DocumentParseError('encrypted', 'DRM protected eReader file')
  } else {
    throw new DocumentParseError('unsupported', `Unsupported eReader version ${version}`)
  }
  if (!nonTextOffset || nonTextOffset > pdb.records.length) nonTextOffset = pdb.records.length
  const chunks = []
  for (let i = 1; i < nonTextOffset; i++) chunks.push(decompress(pdb.records[i]))
  const data = concat(chunks)
  // eReader text is cp1252 by specification (with \U and \a escapes for the rest)
  const decoded = decodeWithFallback(data, 'windows-1252')
  return { blocks: pmlToBlocks(decoded.text), title, usedFallbackEncoding: false }
}

/**
 * Convert eReader PML markup to blocks.
 * @param {string} pml
 */
function pmlToBlocks(pml) {
  const blocks = []
  let runs = []
  let current = ''
  let type = 'p'
  let bold = false
  let italic = false
  let hidden = false
  let headingLevel = 0

  const flushRun = () => {
    if (current) {
      const last = runs[runs.length - 1]
      if (last && !last.br && !!last.bold === bold && !!last.italic === italic) last.text += current
      else runs.push({ text: current, bold, italic })
    }
    current = ''
  }
  const endBlock = () => {
    flushRun()
    if (runs.some((r) => r.text && r.text.trim())) blocks.push({ type, runs })
    runs = []
    type = headingLevel ? `h${headingLevel}` : 'p'
  }

  const text = pml.replace(/\r\n?/g, '\n')
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '\n') {
      endBlock()
      i++
      continue
    }
    if (ch !== '\\') {
      if (!hidden) current += ch
      i++
      continue
    }
    const code = text[i + 1]
    i += 2
    switch (code) {
      case '\\':
        current += '\\'
        break
      case 'p':
        endBlock()
        break
      case 'x':
        flushRun()
        if (headingLevel) {
          headingLevel = 0
          endBlock()
        } else {
          endBlock()
          headingLevel = 1
          type = 'h1'
        }
        break
      case 'X': {
        const lvl = Number(text[i]) || 0
        i++
        flushRun()
        if (headingLevel) {
          headingLevel = 0
          endBlock()
        } else {
          endBlock()
          headingLevel = Math.min(6, lvl + 1)
          type = `h${headingLevel}`
        }
        break
      }
      case 'C': {
        // \Cn="Chapter title" - chapter marker, text is usually repeated in \x
        const m = text.slice(i).match(/^\d="([^"]*)"/)
        if (m) i += m[0].length
        break
      }
      case 'b':
      case 'B':
        flushRun()
        bold = !bold
        break
      case 'i':
        flushRun()
        italic = !italic
        break
      case 'v':
        flushRun()
        hidden = !hidden
        break
      case 'a': {
        const m = text.slice(i, i + 3).match(/^\d{3}/)
        if (m) {
          i += 3
          if (!hidden) current += decodeBytes(Uint8Array.of(Number(m[0])), 'windows-1252')
        }
        break
      }
      case 'U': {
        const m = text.slice(i, i + 4).match(/^[0-9a-fA-F]{4}/)
        if (m) {
          i += 4
          if (!hidden) current += String.fromCharCode(parseInt(m[0], 16))
        }
        break
      }
      case 't':
        // indent toggle: keep as tab at the start
        break
      case 'T':
      case 'w':
      case 'm':
      case 'Q':
      case 'q': {
        const m = text.slice(i).match(/^="[^"]*"/)
        if (m) i += m[0].length
        break
      }
      case 'F': {
        // \Fn="id"...\Fn footnote reference: drop the marker
        const m = text.slice(i).match(/^n="[^"]*"/)
        if (m) i += m[0].length
        else if (text[i] === 'n') i++
        break
      }
      case 'S': {
        // \Sb \Sp \Sd="id" \Sfn="id" \St="..."
        const m = text.slice(i).match(/^(?:b|p|t|d="[^"]*"|fn="[^"]*")/)
        if (m) i += m[0].length
        break
      }
      case '-':
        // soft hyphen
        break
      default:
        // \c \r \n \s \l \k \u \o \e \d ... alignment/font toggles: ignored
        break
    }
  }
  endBlock()
  return blocks
}
