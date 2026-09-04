/**
 * Minimal reader for the Compound File Binary (OLE2) container used by
 * legacy Microsoft Office documents (.doc). Only stream reading is supported.
 */

import { DocumentParseError } from './documentError.js'

const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const MAX_CHAIN = 1 << 22

export class CompoundFile {
  /**
   * @param {Uint8Array} bytes
   */
  constructor(bytes) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    if (bytes.length < 512 || !signature.every((b, i) => bytes[i] === b)) {
      throw new DocumentParseError('corrupt', 'Not a compound file')
    }
    this.sectorShift = this.view.getUint16(0x1e, true)
    this.miniSectorShift = this.view.getUint16(0x20, true)
    this.sectorSize = 1 << this.sectorShift
    this.miniSectorSize = 1 << this.miniSectorShift
    this.numFatSectors = this.view.getUint32(0x2c, true)
    this.firstDirSector = this.view.getUint32(0x30, true)
    this.miniStreamCutoff = this.view.getUint32(0x38, true) || 4096
    this.firstMiniFatSector = this.view.getUint32(0x3c, true)
    this.numMiniFatSectors = this.view.getUint32(0x40, true)
    this.firstDifatSector = this.view.getUint32(0x44, true)
    this.numDifatSectors = this.view.getUint32(0x48, true)
    if (this.sectorShift < 7 || this.sectorShift > 16) throw new DocumentParseError('corrupt', 'Invalid sector size')

    this.fat = this.readFat()
    this.entries = this.readDirectory()
    this.miniFat = null
    this.miniStream = null
  }

  sectorOffset(sector) {
    return (sector + 1) * this.sectorSize
  }

  readSector(sector) {
    const start = this.sectorOffset(sector)
    if (start >= this.bytes.length) return new Uint8Array(0)
    return this.bytes.subarray(start, Math.min(this.bytes.length, start + this.sectorSize))
  }

  readFat() {
    const entriesPerSector = this.sectorSize / 4
    const difat = []
    for (let i = 0; i < 109; i++) {
      const s = this.view.getUint32(0x4c + i * 4, true)
      if (s === FREESECT || s === ENDOFCHAIN) break
      difat.push(s)
    }
    let difatSector = this.firstDifatSector
    let guard = 0
    while (difatSector !== ENDOFCHAIN && difatSector !== FREESECT && guard++ < this.numDifatSectors + 1) {
      const start = this.sectorOffset(difatSector)
      if (start + this.sectorSize > this.bytes.length) break
      for (let i = 0; i < entriesPerSector - 1; i++) {
        const s = this.view.getUint32(start + i * 4, true)
        if (s === FREESECT || s === ENDOFCHAIN) continue
        difat.push(s)
      }
      difatSector = this.view.getUint32(start + (entriesPerSector - 1) * 4, true)
    }
    const fat = new Uint32Array(difat.length * entriesPerSector)
    let n = 0
    for (const s of difat) {
      const start = this.sectorOffset(s)
      for (let i = 0; i < entriesPerSector; i++) {
        fat[n++] = start + i * 4 + 4 <= this.bytes.length ? this.view.getUint32(start + i * 4, true) : FREESECT
      }
    }
    return fat
  }

  /**
   * @param {number} startSector
   * @param {Uint32Array} fat
   * @returns {number[]} sector chain
   */
  chain(startSector, fat) {
    const sectors = []
    let s = startSector
    const seen = new Set()
    while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length && !seen.has(s) && sectors.length < MAX_CHAIN) {
      seen.add(s)
      sectors.push(s)
      s = fat[s]
    }
    return sectors
  }

  readChain(startSector, size) {
    const sectors = this.chain(startSector, this.fat)
    const out = new Uint8Array(Math.min(size, sectors.length * this.sectorSize))
    let pos = 0
    for (const s of sectors) {
      if (pos >= out.length) break
      const data = this.readSector(s)
      const len = Math.min(data.length, out.length - pos)
      out.set(data.subarray(0, len), pos)
      pos += len
    }
    return out
  }

  readDirectory() {
    const raw = this.readChain(this.firstDirSector, Number.MAX_SAFE_INTEGER)
    const entries = []
    for (let off = 0; off + 128 <= raw.length; off += 128) {
      const view = new DataView(raw.buffer, raw.byteOffset + off, 128)
      const nameLen = view.getUint16(0x40, true)
      const type = view.getUint8(0x42)
      if (type === 0) continue
      let name = ''
      for (let i = 0; i + 1 < Math.min(nameLen, 64); i += 2) {
        const ch = view.getUint16(i, true)
        if (!ch) break
        name += String.fromCharCode(ch)
      }
      entries.push({
        name,
        type, // 1 storage, 2 stream, 5 root
        startSector: view.getUint32(0x74, true),
        size: view.getUint32(0x78, true)
      })
    }
    return entries
  }

  getMiniStream() {
    if (this.miniStream) return this.miniStream
    const root = this.entries.find((e) => e.type === 5)
    this.miniStream = root ? this.readChain(root.startSector, root.size) : new Uint8Array(0)
    const miniFatRaw = this.readChain(this.firstMiniFatSector, this.numMiniFatSectors * this.sectorSize)
    this.miniFat = new Uint32Array(miniFatRaw.length >> 2)
    const mv = new DataView(miniFatRaw.buffer, miniFatRaw.byteOffset, miniFatRaw.byteLength)
    for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mv.getUint32(i * 4, true)
    return this.miniStream
  }

  /**
   * @param {string} name stream name (case-insensitive)
   * @returns {Uint8Array|null}
   */
  readStream(name) {
    const entry = this.entries.find((e) => e.type === 2 && e.name.toLowerCase() === name.toLowerCase())
    if (!entry) return null
    if (entry.size >= this.miniStreamCutoff) {
      return this.readChain(entry.startSector, entry.size)
    }
    const mini = this.getMiniStream()
    const sectors = this.chain(entry.startSector, this.miniFat)
    const out = new Uint8Array(Math.min(entry.size, sectors.length * this.miniSectorSize))
    let pos = 0
    for (const s of sectors) {
      if (pos >= out.length) break
      const start = s * this.miniSectorSize
      const data = mini.subarray(start, start + this.miniSectorSize)
      const len = Math.min(data.length, out.length - pos)
      out.set(data.subarray(0, len), pos)
      pos += len
    }
    return out
  }

  hasStream(name) {
    return this.entries.some((e) => e.type === 2 && e.name.toLowerCase() === name.toLowerCase())
  }
}
