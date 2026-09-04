/**
 * Minimal RTF parser producing text blocks (paragraphs and headings with
 * bold/italic runs). Formatting beyond that is ignored.
 *
 * The tokenizer works on raw bytes because `\'hh` escapes are bytes in the
 * document codepage (`\ansicpgN`) and must be decoded together.
 */

import { codepageLabel, decodeBytes, guessLegacyEncoding } from './textEncoding.js'

// Destinations whose content is never part of the body text
const SKIPPED_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'info',
  'pict',
  'object',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'xmlnstbl',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'generator',
  'fldinst',
  'xmlopen',
  'xmlclose',
  'mmathPr',
  'docvar',
  'userprops',
  'bkmkstart',
  'bkmkend',
  'annotation',
  'atnid',
  'atnauthor',
  'pntext',
  'pntxta',
  'pntxtb',
  'nonshppict',
  'shpinst',
  'shprslt',
  'wgrffmtfilter',
  'background',
  'passwordhash',
  'protusertbl',
  'sp',
  'sn',
  'sv',
  'template'
])

const SPECIAL_CHARS = {
  par: '\n',
  line: '\v',
  page: '\n',
  sect: '\n',
  tab: '\t',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  zwnj: '‌',
  zwj: '‍',
  ltrmark: '‎',
  rtlmark: '‏',
  chdate: '',
  chtime: '',
  chpgn: ''
}

function isDigit(c) {
  return c >= 0x30 && c <= 0x39
}
function isAlpha(c) {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)
}

/**
 * @param {Uint8Array} bytes
 * @param {{ legacyEncoding?: string }} [options]
 * @returns {{ blocks: Array, title?: string, usedFallbackEncoding: boolean }}
 */
export function parseRtf(bytes, options = {}) {
  let encoding = null
  let usedFallbackEncoding = false
  const fallbackEncoding = options.legacyEncoding || guessLegacyEncoding()
  const getEncoding = () => {
    if (!encoding) {
      encoding = fallbackEncoding
      usedFallbackEncoding = true
    }
    return encoding
  }

  const blocks = []
  const headingStyles = {} // style index -> heading level
  let current = null // { type, runs, fontSize, styleIndex, allBold }

  const newBlock = () => {
    current = { type: 'p', runs: [], fontSize: 0, styleIndex: -1 }
  }
  const finishBlock = () => {
    if (!current) return
    if (current.runs.some((r) => r.text && r.text.trim())) {
      let type = headingStyles[current.styleIndex]
      if (!type) {
        const textRuns = current.runs.filter((r) => r.text && r.text.trim())
        const allBold = textRuns.length && textRuns.every((r) => r.bold)
        const length = textRuns.reduce((n, r) => n + r.text.length, 0)
        if (allBold && length <= 80 && current.fontSize >= 28) type = 'h2'
      }
      blocks.push({ type: type || 'p', runs: current.runs })
    }
    current = null
  }

  // Pending \'hh bytes, decoded together once a non-byte token arrives
  let pendingBytes = []
  let pendingState = null
  const flushBytes = () => {
    if (!pendingBytes.length) return
    const text = decodeBytes(Uint8Array.from(pendingBytes), getEncoding())
    pendingBytes = []
    appendText(text, pendingState)
  }

  const appendText = (text, state) => {
    if (!text) return
    if (state.skip) return
    if (state.destination === 'stylesheet') {
      state.styleName = (state.styleName || '') + text
      return
    }
    if (state.destination === 'title') {
      state.titleText = (state.titleText || '') + text
      return
    }
    if (!current) newBlock()
    if (state.fontSize > current.fontSize) current.fontSize = state.fontSize
    if (state.styleIndex >= 0 && current.styleIndex < 0) current.styleIndex = state.styleIndex
    const last = current.runs[current.runs.length - 1]
    if (last && !last.br && !!last.bold === !!state.bold && !!last.italic === !!state.italic) {
      last.text += text
    } else {
      current.runs.push({ text, bold: !!state.bold, italic: !!state.italic })
    }
  }

  const appendBreak = (state) => {
    if (state.skip) return
    if (!current) newBlock()
    current.runs.push({ br: true })
  }

  let title = ''
  const stack = []
  let state = { bold: false, italic: false, uc: 1, fontSize: 0, styleIndex: -1, skip: false, destination: null, skipChars: 0 }
  let i = 0
  const n = bytes.length
  let sawStylesheetEntry = false

  const handleControlWord = (word, param, hasParam) => {
    if (word === "'") return // handled by caller
    if (state.skipChars > 0 && word !== 'u') {
      // Control words are skipped after \u as one unit? Only \'hh count; other words do not consume
    }
    switch (word) {
      case 'ansicpg':
        if (hasParam) encoding = codepageLabel(param)
        return
      case 'mac':
        if (!encoding) encoding = 'macintosh'
        return
      case 'pc':
      case 'pca':
        if (!encoding) encoding = 'windows-1252'
        return
      case 'ansi':
        return
      case 'uc':
        state.uc = hasParam ? param : 1
        return
      case 'u': {
        let code = hasParam ? param : 0
        if (code < 0) code += 65536
        flushBytes()
        appendText(String.fromCharCode(code), state)
        state.skipChars = state.uc
        return
      }
      case 'par':
        flushBytes()
        if (state.destination === 'stylesheet' || state.skip) return
        finishBlock()
        return
      case 'page':
      case 'sect':
        flushBytes()
        if (!state.skip && state.destination !== 'stylesheet') finishBlock()
        return
      case 'line':
        flushBytes()
        appendBreak(state)
        return
      case 'pard':
        state.styleIndex = -1
        state.fontSize = 0
        return
      case 'plain':
        state.bold = false
        state.italic = false
        state.fontSize = 0
        return
      case 'b':
        flushBytes()
        state.bold = !hasParam || param !== 0
        return
      case 'i':
        flushBytes()
        state.italic = !hasParam || param !== 0
        return
      case 'fs':
        if (hasParam) state.fontSize = param
        return
      case 's':
        if (hasParam) state.styleIndex = param
        return
      case 'stylesheet':
        state.destination = 'stylesheet'
        return
      case 'title':
        // \title lives inside the skipped \info group
        state.skip = false
        state.destination = 'title'
        return
      case 'tab':
        flushBytes()
        appendText('\t', state)
        return
      case 'cell':
      case 'nestcell':
        flushBytes()
        appendText(' ', state)
        return
      case 'row':
      case 'nestrow':
        flushBytes()
        finishBlock()
        return
      case 'fldrslt':
        return
      default:
        if (SKIPPED_DESTINATIONS.has(word)) {
          state.skip = true
          return
        }
        if (Object.prototype.hasOwnProperty.call(SPECIAL_CHARS, word)) {
          const ch = SPECIAL_CHARS[word]
          if (ch === '\n') {
            flushBytes()
            finishBlock()
          } else if (ch === '\v') {
            flushBytes()
            appendBreak(state)
          } else if (ch) {
            flushBytes()
            appendText(ch, state)
          }
        }
    }
  }

  while (i < n) {
    const c = bytes[i]
    if (c === 0x7b) {
      // {
      flushBytes()
      stack.push(state)
      state = { ...state, styleName: undefined, titleText: undefined }
      i++
      // \* destinations are ignorable unless we know them
      if (bytes[i] === 0x5c && bytes[i + 1] === 0x2a) {
        i += 2
        // read the following control word; keep only known ones
        let j = i
        if (bytes[j] === 0x5c) {
          j++
          let w = ''
          while (j < n && isAlpha(bytes[j])) w += String.fromCharCode(bytes[j++])
          if (w !== 'fldrslt') state.skip = true
        } else {
          state.skip = true
        }
      }
      continue
    }
    if (c === 0x7d) {
      // }
      flushBytes()
      const closing = state
      if (closing.destination === 'stylesheet' && closing.styleName !== undefined && closing.styleIndex >= 0) {
        const name = closing.styleName.replace(/;.*$/, '').trim().toLowerCase()
        const m = name.match(/^(?:heading|nadpis|überschrift|titre|título|titolo|nagłówek)\s*(\d)$/)
        if (m) headingStyles[closing.styleIndex] = `h${Math.min(6, Math.max(1, Number(m[1])))}`
        else if (name === 'title' || name === 'název') headingStyles[closing.styleIndex] = 'h1'
        sawStylesheetEntry = true
      }
      if (closing.destination === 'title' && closing.titleText && !title) {
        title = closing.titleText.trim()
      }
      state = stack.pop() || state
      i++
      continue
    }
    if (c === 0x5c) {
      // backslash
      const next = bytes[i + 1]
      if (next === 0x27) {
        // \'hh
        const hex = String.fromCharCode(bytes[i + 2], bytes[i + 3])
        const value = parseInt(hex, 16)
        i += 4
        if (state.skipChars > 0) {
          state.skipChars--
          continue
        }
        if (!isNaN(value)) {
          if (pendingState !== state) flushBytes()
          pendingState = state
          pendingBytes.push(value)
        }
        continue
      }
      if (isAlpha(next)) {
        let j = i + 1
        let word = ''
        while (j < n && isAlpha(bytes[j])) word += String.fromCharCode(bytes[j++])
        let param = 0
        let hasParam = false
        let negative = false
        if (bytes[j] === 0x2d) {
          negative = true
          j++
        }
        if (isDigit(bytes[j])) {
          hasParam = true
          let num = 0
          while (j < n && isDigit(bytes[j])) num = num * 10 + (bytes[j++] - 0x30)
          param = negative ? -num : num
        }
        if (bytes[j] === 0x20) j++ // delimiter space is part of the control word
        i = j
        if (word !== 'u' && word !== 'uc' && word !== 'bin') state.skipChars = 0
        if (word === 'bin' && hasParam) {
          i += Math.max(0, param)
          continue
        }
        handleControlWord(word, param, hasParam)
        continue
      }
      // control symbol
      i += 2
      if (state.skipChars > 0) {
        state.skipChars--
        continue
      }
      flushBytes()
      if (next === 0x5c || next === 0x7b || next === 0x7d) appendText(String.fromCharCode(next), state)
      else if (next === 0x7e) appendText(' ', state)
      else if (next === 0x5f) appendText('‑', state)
      else if (next === 0x0a || next === 0x0d) finishBlock()
      // \- (optional hyphen) and \* handled/ignored
      continue
    }
    if (c === 0x0d || c === 0x0a) {
      i++
      continue
    }
    // plain text byte
    i++
    if (state.skipChars > 0) {
      state.skipChars--
      continue
    }
    if (state.skip) continue
    if (c < 0x80) {
      if (pendingState !== state) flushBytes()
      pendingState = state
      pendingBytes.push(c)
    } else {
      if (pendingState !== state) flushBytes()
      pendingState = state
      pendingBytes.push(c)
    }
  }
  flushBytes()
  finishBlock()

  return { blocks, title: title || undefined, usedFallbackEncoding, sawStylesheetEntry }
}
