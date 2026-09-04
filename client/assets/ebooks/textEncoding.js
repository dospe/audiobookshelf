/**
 * Text decoding helpers shared by the document parsers (rtf, doc, pdb).
 *
 * Legacy 8-bit documents often carry no reliable encoding information, so the
 * strategy is: use the encoding declared by the file when there is one, then
 * try strict UTF-8, and finally fall back to a "legacy" single-byte codepage
 * chosen by the user (or guessed from the device language).
 */

const CODEPAGE_LABELS = {
  437: 'windows-1252', // cp437/cp850 are not available in TextDecoder
  850: 'windows-1252',
  852: 'windows-1250',
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  1201: 'utf-16be',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  10029: 'x-mac-ce',
  20866: 'koi8-r',
  21866: 'koi8-u',
  28591: 'iso-8859-1',
  28592: 'iso-8859-2',
  28595: 'iso-8859-5',
  28597: 'iso-8859-7',
  28599: 'iso-8859-9',
  65001: 'utf-8'
}

// Windows language identifiers (primary language part) -> ANSI codepage
const LID_CODEPAGES = {
  0x05: 1250, // Czech
  0x0e: 1250, // Hungarian
  0x15: 1250, // Polish
  0x18: 1250, // Romanian
  0x1a: 1250, // Croatian / Serbian (latin)
  0x1b: 1250, // Slovak
  0x24: 1250, // Slovenian
  0x02: 1251, // Bulgarian
  0x19: 1251, // Russian
  0x22: 1251, // Ukrainian
  0x23: 1251, // Belarusian
  0x2f: 1251, // Macedonian
  0x08: 1253, // Greek
  0x1f: 1254, // Turkish
  0x0d: 1255, // Hebrew
  0x01: 1256, // Arabic
  0x29: 1256, // Farsi
  0x25: 1257, // Estonian
  0x26: 1257, // Latvian
  0x27: 1257, // Lithuanian
  0x2a: 1258 // Vietnamese
}

// Browser/device language -> legacy codepage label
const LANGUAGE_ENCODINGS = {
  cs: 'windows-1250',
  sk: 'windows-1250',
  pl: 'windows-1250',
  hu: 'windows-1250',
  hr: 'windows-1250',
  sl: 'windows-1250',
  ro: 'windows-1250',
  sr: 'windows-1250',
  bs: 'windows-1250',
  sq: 'windows-1250',
  ru: 'windows-1251',
  uk: 'windows-1251',
  bg: 'windows-1251',
  be: 'windows-1251',
  mk: 'windows-1251',
  el: 'windows-1253',
  tr: 'windows-1254',
  he: 'windows-1255',
  ar: 'windows-1256',
  fa: 'windows-1256',
  et: 'windows-1257',
  lv: 'windows-1257',
  lt: 'windows-1257',
  vi: 'windows-1258'
}

/** Encodings offered in the reader settings */
export const LEGACY_ENCODING_OPTIONS = ['windows-1250', 'windows-1252', 'windows-1251', 'iso-8859-2', 'utf-8']

/**
 * @param {number} codepage Windows codepage number
 * @returns {string} TextDecoder label
 */
export function codepageLabel(codepage) {
  return CODEPAGE_LABELS[Number(codepage)] || 'windows-1252'
}

/**
 * @param {number} lid Windows language identifier (e.g. 0x0405 for Czech)
 * @returns {string} TextDecoder label of the matching ANSI codepage
 */
export function codepageForLid(lid) {
  const primary = Number(lid) & 0x3ff
  return codepageLabel(LID_CODEPAGES[primary] || 1252)
}

/**
 * Guess the single-byte codepage a legacy document most likely uses, based
 * on the device language.
 *
 * @param {string} [language] e.g. navigator.language
 * @returns {string} TextDecoder label
 */
export function guessLegacyEncoding(language) {
  const lang = String(language || (typeof navigator !== 'undefined' ? navigator.language : '') || '')
    .toLowerCase()
    .split(/[-_]/)[0]
  return LANGUAGE_ENCODINGS[lang] || 'windows-1252'
}

/**
 * Decode bytes with the given encoding label, falling back to utf-8 when the
 * label is not supported by the runtime.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} [encoding]
 * @returns {string}
 */
export function decodeBytes(bytes, encoding = 'utf-8') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try {
    return new TextDecoder(encoding).decode(data)
  } catch (error) {
    return new TextDecoder('utf-8').decode(data)
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean} true when the bytes are well-formed UTF-8
 */
export function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch (error) {
    return false
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean} true when the bytes contain any byte >= 0x80
 */
export function hasHighBytes(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) return true
  }
  return false
}

/**
 * Decode text without a declared encoding: strict UTF-8 first, then the
 * legacy fallback codepage.
 *
 * @param {Uint8Array} bytes
 * @param {string} legacyEncoding fallback label
 * @returns {{ text: string, encoding: string, usedFallbackEncoding: boolean }}
 */
export function decodeWithFallback(bytes, legacyEncoding) {
  if (!hasHighBytes(bytes) || isValidUtf8(bytes)) {
    return { text: decodeBytes(bytes, 'utf-8'), encoding: 'utf-8', usedFallbackEncoding: false }
  }
  const encoding = legacyEncoding || guessLegacyEncoding()
  return { text: decodeBytes(bytes, encoding), encoding, usedFallbackEncoding: true }
}

/**
 * Split plain text into paragraph blocks. Blank lines separate paragraphs when
 * the text uses them, otherwise every line is a paragraph.
 *
 * @param {string} text
 * @returns {Array<{ type: string, runs: Array<{ text: string }> }>}
 */
export function textToBlocks(text) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '')
  const hasBlankLines = /\n[ \t]*\n/.test(normalized)
  const parts = hasBlankLines ? normalized.split(/\n[ \t]*\n+/) : normalized.split('\n')
  const blocks = []
  for (const part of parts) {
    const paragraph = hasBlankLines ? part.replace(/[ \t]*\n[ \t]*/g, ' ').trim() : part.trim()
    if (!paragraph) continue
    blocks.push({ type: 'p', runs: [{ text: paragraph }] })
  }
  return blocks
}
