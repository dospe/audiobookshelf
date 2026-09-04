/**
 * Error thrown by the document parsers (doc, docx, rtf, pdb).
 * `code` tells the reader which message to show.
 */
export class DocumentParseError extends Error {
  /**
   * @param {'unsupported'|'encrypted'|'corrupt'} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code)
    this.name = 'DocumentParseError'
    this.code = code
  }
}
