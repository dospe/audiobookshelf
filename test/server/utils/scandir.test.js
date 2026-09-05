const Path = require('path')
const chai = require('chai')
const expect = chai.expect
const scanUtils = require('../../../server/utils/scandir')

describe('scanUtils', async () => {
  it('should properly group files into potential book library items', async () => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: true
    }

    const filePaths = [
      'randomfile.txt', // Should be ignored because it's not a book media file
      'Book1.m4b', // Root single file audiobook
      'Book2/audiofile.m4b',
      'Book2/disk 001/audiofile.m4b',
      'Book2/disk 002/audiofile.m4b',
      'Author/Book3/audiofile.mp3',
      'Author/Book3/Disc 1/audiofile.mp3',
      'Author/Book3/Disc 2/audiofile.mp3',
      'Author/Series/Book4/cover.jpg',
      'Author/Series/Book4/CD1/audiofile.mp3',
      'Author/Series/Book4/CD2/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 01/audiofile.mp3',
      'Author/Series2/Book5/deeply/nested/cd 02/audiofile.mp3',
      'Author/Series2/Book5/randomfile.js' // Should be ignored because it's not a book media file
    ]

    // Create fileItems to match the format of fileUtils.recurseFiles
    const fileItems = []
    for (const filePath of filePaths) {
      const dirname = Path.dirname(filePath)
      fileItems.push({
        name: Path.basename(filePath),
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.extname(filePath),
        deep: filePath.split('/').length - 1
      })
    }

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)

    expect(libraryItemGrouping).to.deep.equal({
      'Book1.m4b': 'Book1.m4b',
      Book2: ['audiofile.m4b', 'disk 001/audiofile.m4b', 'disk 002/audiofile.m4b'],
      'Author/Book3': ['audiofile.mp3', 'Disc 1/audiofile.mp3', 'Disc 2/audiofile.mp3'],
      'Author/Series/Book4': ['CD1/audiofile.mp3', 'CD2/audiofile.mp3', 'cover.jpg'],
      'Author/Series2/Book5/deeply/nested': ['cd 01/audiofile.mp3', 'cd 02/audiofile.mp3']
    })
  })
})

describe('scanUtils document ebook formats', () => {
  it('should treat doc, docx, rtf and pdb files as book media files', () => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: true
    }

    const filePaths = ['Author/Book1/book.docx', 'Author/Book2/book.doc', 'Author/Book3/book.rtf', 'Author/Book4/book.pdb', 'Author/Book5/notes.odt']
    const fileItems = filePaths.map((filePath) => {
      const dirname = Path.dirname(filePath)
      return {
        name: Path.basename(filePath),
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.extname(filePath),
        deep: filePath.split('/').length - 1
      }
    })

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/Book1': ['book.docx'],
      'Author/Book2': ['book.doc'],
      'Author/Book3': ['book.rtf'],
      'Author/Book4': ['book.pdb']
    })
  })
})

describe('scanUtils splitEbooksByFile', () => {
  // Create fileItems to match the format of fileUtils.recurseFiles
  const buildFileItems = (filePaths) =>
    filePaths.map((filePath) => {
      const dirname = Path.dirname(filePath)
      return {
        name: Path.basename(filePath),
        reldirpath: dirname === '.' ? '' : dirname,
        extension: Path.extname(filePath),
        deep: filePath.split('/').length - 1
      }
    })

  before(() => {
    global.isWin = process.platform === 'win32'
    global.ServerSettings = {
      scannerParseSubtitle: false
    }
  })

  it('should split a directory holding several ebooks into one library item per book', () => {
    const fileItems = buildFileItems(['Author/Kniha1.epub', 'Author/Kniha1.pdf', 'Author/Kniha1.opf', 'Author/Kniha1.jpg', 'Author/Kniha2.epub'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/Kniha1.epub': ['Author/Kniha1.epub', 'Author/Kniha1.pdf', 'Author/Kniha1.opf', 'Author/Kniha1.jpg'],
      'Author/Kniha2.epub': ['Author/Kniha2.epub']
    })
  })

  it('should keep a directory with a single ebook as one library item', () => {
    const fileItems = buildFileItems(['Author/Kniha1.epub', 'Author/Kniha1.pdf', 'Author/cover.jpg'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      Author: ['Kniha1.epub', 'Kniha1.pdf', 'cover.jpg']
    })
  })

  it('should not split a directory that has audio files', () => {
    const fileItems = buildFileItems(['Author/Book/audio.m4b', 'Author/Book/a.epub', 'Author/Book/b.epub'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/Book': ['audio.m4b', 'a.epub', 'b.epub']
    })
  })

  it('should leave subdirectories of a split directory to the directory grouping', () => {
    const fileItems = buildFileItems(['Author/Kniha1.epub', 'Author/Kniha2.epub', 'Author/Audiokniha/audio.m4b', 'Author/Audiokniha/bonus.epub', 'Author/Series/1 - Kniha3.epub', 'Author/Series/2 - Kniha4.epub'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/Kniha1.epub': ['Author/Kniha1.epub'],
      'Author/Kniha2.epub': ['Author/Kniha2.epub'],
      'Author/Audiokniha': ['audio.m4b', 'bonus.epub'],
      'Author/Series/1 - Kniha3.epub': ['Author/Series/1 - Kniha3.epub'],
      'Author/Series/2 - Kniha4.epub': ['Author/Series/2 - Kniha4.epub']
    })
  })

  it('should split a directory with a single ebook when more ebooks are in its subdirectories', () => {
    const fileItems = buildFileItems(['Author/Loose.epub', 'Author/Series/1 - A.epub', 'Author/Series/2 - B.epub', 'Author/Other Book/other.epub', 'Author/Audiobook/audio.mp3'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/Loose.epub': ['Author/Loose.epub'],
      'Author/Series/1 - A.epub': ['Author/Series/1 - A.epub'],
      'Author/Series/2 - B.epub': ['Author/Series/2 - B.epub'],
      'Author/Other Book': ['other.epub'],
      'Author/Audiobook': ['audio.mp3']
    })
  })

  it('should keep a book directory with a single ebook and audio in subdirectories as one library item', () => {
    const fileItems = buildFileItems(['Book/book.epub', 'Book/cd1/a.mp3', 'Book/extras/bonus.mp3'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      Book: ['book.epub', 'cd1/a.mp3', 'extras/bonus.mp3']
    })
  })

  it('should prefer epub as the primary file and ignore files not belonging to any book', () => {
    const fileItems = buildFileItems(['Author/A.pdf', 'Author/A.epub', 'Author/B.mobi', 'Author/cover.jpg', 'Author/desc.txt'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Author/A.epub': ['Author/A.epub', 'Author/A.pdf'],
      'Author/B.mobi': ['Author/B.mobi']
    })
  })

  it('should not split when the setting is off', () => {
    const fileItems = buildFileItems(['Author/Kniha1.epub', 'Author/Kniha2.epub'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, false)

    expect(libraryItemGrouping).to.deep.equal({
      Author: ['Kniha1.epub', 'Kniha2.epub']
    })
  })

  it('should not create ebook items when audiobooksOnly is set', () => {
    const fileItems = buildFileItems(['Author/Kniha1.epub', 'Author/Kniha2.epub'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, true, false, true)

    expect(libraryItemGrouping).to.deep.equal({})
  })

  it('should keep media files in the library folder root as single file items', () => {
    const fileItems = buildFileItems(['Kniha.epub', 'Kniha.pdf'])

    const libraryItemGrouping = scanUtils.groupFileItemsIntoLibraryItemDirs('book', fileItems, false, false, true)

    expect(libraryItemGrouping).to.deep.equal({
      'Kniha.epub': 'Kniha.epub',
      'Kniha.pdf': 'Kniha.pdf'
    })
  })
})

describe('scanUtils getBookDataFromFile', () => {
  it('should parse the author from the parent directory and the title from the filename', () => {
    const bookData = scanUtils.getBookDataFromFile('Author/Kniha1.epub', false)

    expect(bookData.title).to.equal('Kniha1')
    expect(bookData.authors).to.deep.equal(['Author'])
    expect(bookData.seriesName).to.be.null
  })

  it('should parse series and sequence like a title directory', () => {
    const bookData = scanUtils.getBookDataFromFile('Author/Series/2 - Kniha4.epub', false)

    expect(bookData.title).to.equal('Kniha4')
    expect(bookData.authors).to.deep.equal(['Author'])
    expect(bookData.seriesName).to.equal('Series')
    expect(bookData.seriesSequence).to.equal('2')
  })

  it('should only strip the last extension', () => {
    expect(scanUtils.getBookDataFromFile('Author/Kniha.v2.epub', false).title).to.equal('Kniha.v2')
    expect(scanUtils.getBookDataFromFile('Author/Kniha', false).title).to.equal('Kniha')
  })

  it('should return only the title for a file in the library folder root', () => {
    const bookData = scanUtils.getBookDataFromFile('Kniha.epub', false)

    expect(bookData.title).to.equal('Kniha')
    expect(bookData.authors).to.deep.equal([])
  })
})
