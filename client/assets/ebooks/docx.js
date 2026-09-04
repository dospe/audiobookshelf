/**
 * Text extractor for Office Open XML documents (.docx): paragraphs, headings
 * (by style name or outline level) and bold/italic runs.
 */

import JSZip from 'jszip'
import { DocumentParseError } from './documentError.js'

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{ blocks: Array, title?: string, usedFallbackEncoding: boolean }>}
 */
export async function parseDocx(bytes) {
  let zip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (error) {
    throw new DocumentParseError('corrupt', 'Not a valid zip archive')
  }
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new DocumentParseError('unsupported', 'Archive does not contain word/document.xml')
  const documentXml = await documentFile.async('string')
  const stylesXml = zip.file('word/styles.xml') ? await zip.file('word/styles.xml').async('string') : ''
  const coreXml = zip.file('docProps/core.xml') ? await zip.file('docProps/core.xml').async('string') : ''

  const parser = new DOMParser()
  const doc = parser.parseFromString(documentXml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new DocumentParseError('corrupt', 'Invalid document.xml')

  const headingStyles = readHeadingStyles(stylesXml, parser)
  let title
  if (coreXml) {
    const core = parser.parseFromString(coreXml, 'application/xml')
    const titleEl = findByLocalName(core, 'title')[0]
    if (titleEl?.textContent?.trim()) title = titleEl.textContent.trim()
  }

  const body = findByLocalName(doc, 'body')[0]
  if (!body) throw new DocumentParseError('corrupt', 'document.xml has no body')

  const blocks = []
  walk(body, blocks, headingStyles)
  return { blocks, title, usedFallbackEncoding: false }
}

function findByLocalName(root, localName) {
  const result = []
  const all = root.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) result.push(all[i])
  }
  return result
}

function childrenByLocalName(el, localName) {
  const result = []
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i]
    if (c.nodeType === 1 && c.localName === localName) result.push(c)
  }
  return result
}

function attr(el, name) {
  if (!el?.attributes) return null
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    if (a.localName === name || a.name === name || a.name === `w:${name}`) return a.value
  }
  return null
}

function readHeadingStyles(stylesXml, parser) {
  const map = {}
  if (!stylesXml) return map
  const styles = parser.parseFromString(stylesXml, 'application/xml')
  for (const style of findByLocalName(styles, 'style')) {
    const styleId = attr(style, 'styleId')
    if (!styleId) continue
    const nameEl = childrenByLocalName(style, 'name')[0]
    const name = (attr(nameEl, 'val') || '').toLowerCase()
    let level = null
    const m = name.match(/^heading\s*(\d)$/)
    if (m) level = Number(m[1])
    else if (name === 'title') level = 1
    else {
      const pPr = childrenByLocalName(style, 'pPr')[0]
      const outline = pPr && childrenByLocalName(pPr, 'outlineLvl')[0]
      const lvl = outline && attr(outline, 'val')
      if (lvl !== null && lvl !== undefined && lvl !== '' && Number(lvl) < 9) level = Number(lvl) + 1
    }
    if (level) map[styleId] = `h${Math.min(6, Math.max(1, level))}`
  }
  return map
}

const SKIPPED = new Set(['del', 'drawing', 'pict', 'object', 'footnoteReference', 'endnoteReference', 'commentReference', 'commentRangeStart', 'commentRangeEnd', 'instrText', 'delText', 'fldChar', 'sectPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'pPr', 'rPr'])

function walk(el, blocks, headingStyles) {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]
    if (node.nodeType !== 1) continue
    const name = node.localName
    if (SKIPPED.has(name)) continue
    if (name === 'p') {
      const block = paragraphToBlock(node, headingStyles)
      if (block) blocks.push(block)
      continue
    }
    // tbl, tr, tc, sdt, sdtContent, body, hyperlink, ins, smartTag, fldSimple ...
    walk(node, blocks, headingStyles)
  }
}

function isOn(el) {
  if (!el) return false
  const val = attr(el, 'val')
  return val === null || !(val === '0' || val === 'false' || val === 'off')
}

function paragraphToBlock(p, headingStyles) {
  const runs = []
  let type = 'p'
  const pPr = childrenByLocalName(p, 'pPr')[0]
  if (pPr) {
    const pStyle = childrenByLocalName(pPr, 'pStyle')[0]
    const styleId = pStyle && attr(pStyle, 'val')
    if (styleId && headingStyles[styleId]) type = headingStyles[styleId]
    else if (styleId && /^(heading|nadpis)(\d)$/i.test(styleId)) type = `h${Math.min(6, Number(styleId.match(/(\d)$/)[1]))}`
    const outline = childrenByLocalName(pPr, 'outlineLvl')[0]
    const lvl = outline && attr(outline, 'val')
    if (type === 'p' && lvl !== null && lvl !== undefined && lvl !== '' && Number(lvl) < 6) type = `h${Number(lvl) + 1}`
    const numPr = childrenByLocalName(pPr, 'numPr')[0]
    if (numPr) runs.push({ text: '• ' })
  }
  let pageBreak = false
  collectRuns(p, runs, { bold: false, italic: false }, () => (pageBreak = true))
  const block = { type, runs }
  if (!runs.some((r) => r.text && r.text.trim())) return null
  return block
}

function collectRuns(el, runs, inherited, onPageBreak) {
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i]
    if (node.nodeType !== 1) continue
    const name = node.localName
    if (SKIPPED.has(name)) continue
    if (name === 'r') {
      const rPr = childrenByLocalName(node, 'rPr')[0]
      const style = {
        bold: rPr ? isOn(childrenByLocalName(rPr, 'b')[0]) : inherited.bold,
        italic: rPr ? isOn(childrenByLocalName(rPr, 'i')[0]) : inherited.italic
      }
      for (let j = 0; j < node.childNodes.length; j++) {
        const c = node.childNodes[j]
        if (c.nodeType !== 1) continue
        const cn = c.localName
        if (cn === 't') pushText(runs, c.textContent || '', style)
        else if (cn === 'tab') pushText(runs, '\t', style)
        else if (cn === 'br') {
          if (attr(c, 'type') === 'page') onPageBreak()
          else runs.push({ br: true })
        } else if (cn === 'cr') runs.push({ br: true })
        else if (cn === 'noBreakHyphen') pushText(runs, '‑', style)
        else if (cn === 'softHyphen') pushText(runs, '­', style)
        else if (cn === 'sym') {
          const ch = attr(c, 'char')
          if (ch) pushText(runs, String.fromCharCode(parseInt(ch, 16) & 0xff), style)
        }
      }
      continue
    }
    if (name === 'p') {
      // nested paragraph (e.g. inside a text box): flatten
      collectRuns(node, runs, inherited, onPageBreak)
      continue
    }
    // hyperlink, ins, smartTag, fldSimple, sdt, sdtContent, ...
    collectRuns(node, runs, inherited, onPageBreak)
  }
}

function pushText(runs, text, style) {
  if (!text) return
  const last = runs[runs.length - 1]
  if (last && !last.br && !!last.bold === !!style.bold && !!last.italic === !!style.italic) {
    last.text += text
  } else {
    runs.push({ text, bold: !!style.bold, italic: !!style.italic })
  }
}
