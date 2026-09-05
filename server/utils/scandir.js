const Path = require('path')
const { filePathToPOSIX } = require('./fileUtils')
const globals = require('./globals')
const LibraryFile = require('../objects/files/LibraryFile')
const parseNameString = require('./parsers/parseNameString')

/**
 * @typedef LibraryItemFilenameMetadata
 * @property {string} title
 * @property {string} subtitle Book mediaType only
 * @property {string} asin Book mediaType only
 * @property {string[]} authors Book mediaType only
 * @property {string[]} narrators Book mediaType only
 * @property {string} seriesName Book mediaType only
 * @property {string} seriesSequence Book mediaType only
 * @property {string} publishedYear Book mediaType only
 */

function isMediaFile(mediaType, ext, audiobooksOnly = false) {
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  if (mediaType === 'podcast') return globals.SupportedAudioTypes.includes(extclean)
  else if (audiobooksOnly) return globals.SupportedAudioTypes.includes(extclean)
  return globals.SupportedAudioTypes.includes(extclean) || globals.SupportedEbookTypes.includes(extclean)
}

function isAudioFileExt(ext) {
  if (!ext) return false
  return globals.SupportedAudioTypes.includes(ext.slice(1).toLowerCase())
}

function isEbookFileExt(ext) {
  if (!ext) return false
  return globals.SupportedEbookTypes.includes(ext.slice(1).toLowerCase())
}

function isScannableNonMediaFile(ext) {
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  return globals.TextFileTypes.includes(extclean) || globals.MetadataFileTypes.includes(extclean) || globals.SupportedImageTypes.includes(extclean)
}

function checkFilepathIsAudioFile(filepath) {
  const ext = Path.extname(filepath)
  if (!ext) return false
  const extclean = ext.slice(1).toLowerCase()
  return globals.SupportedAudioTypes.includes(extclean)
}
module.exports.checkFilepathIsAudioFile = checkFilepathIsAudioFile

/**
 * Group ebook files of a directory into one library item per book
 *
 * A directory holding several ebooks, or one ebook next to subdirectories with more ebooks,
 * is not a single book, it is a shelf. Files are grouped by their filename without the
 * extension, so "Book.epub", "Book.pdf" and "Book.opf" all belong to the same book, while
 * "Book1.epub" and "Book2.epub" are two books.
 *
 * The resulting groups are keyed by the relative path of the primary ebook file and their
 * paths are relative to the library folder (like single media files in the library folder
 * root). The first entry of a group is always the key, which marks the group as a single
 * media file library item.
 *
 * @param {import('./fileUtils').FilePathItem[]} mediaFileItems
 * @param {import('./fileUtils').FilePathItem[]} otherFileItems
 * @returns {{ groups: Record<string,string[]>, splitDirs: Set<string> }}
 */
function groupEbookFilesIntoLibraryItems(mediaFileItems, otherFileItems) {
  // Bucket media files by the directory they are in
  const mediaFileItemsByDir = {}
  for (const item of mediaFileItems) {
    // Files in the library folder root are already single media file library items
    if (!item.deep) continue
    mediaFileItemsByDir[item.reldirpath] = mediaFileItemsByDir[item.reldirpath] || []
    mediaFileItemsByDir[item.reldirpath].push(item)
  }

  const groups = {}
  const splitDirs = new Set()
  // Maps "<dir>\n<filename without extension>" to the group key it belongs to
  const groupKeyByDirAndBasename = {}
  const dirsWithEbooks = Object.keys(mediaFileItemsByDir).filter((reldirpath) => mediaFileItemsByDir[reldirpath].some((item) => isEbookFileExt(item.extension)))

  for (const reldirpath in mediaFileItemsByDir) {
    // A directory with audio files is a single audiobook, ebooks in it are supplementary
    if (mediaFileItemsByDir[reldirpath].some((item) => isAudioFileExt(item.extension))) continue

    const ebookFileItems = mediaFileItemsByDir[reldirpath].filter((item) => isEbookFileExt(item.extension))
    const basenames = [...new Set(ebookFileItems.map((item) => Path.basename(item.name, item.extension)))]
    if (!basenames.length) continue
    // A directory holding a single book is still a shelf (e.g. an author directory) when more books
    //   live in its subdirectories. Otherwise it is the directory of that book and stays as is.
    const hasEbooksInSubdirs = dirsWithEbooks.some((dir) => dir.startsWith(`${reldirpath}/`))
    if (basenames.length < 2 && !hasEbooksInSubdirs) continue

    splitDirs.add(reldirpath)
    for (const basename of basenames) {
      const groupFileItems = ebookFileItems.filter((item) => Path.basename(item.name, item.extension) === basename)
      // Prefer epub as the primary ebook file to match BookScanner
      const primaryFileItem = groupFileItems.find((item) => item.extension.slice(1).toLowerCase() === 'epub') || groupFileItems[0]
      const key = Path.posix.join(reldirpath, primaryFileItem.name)
      groups[key] = [key]
      groupKeyByDirAndBasename[`${reldirpath}\n${basename}`] = key
    }
  }

  if (!splitDirs.size) return { groups, splitDirs }

  // Add the remaining ebook formats and the sidecar files (e.g. "Book.opf", "Book.jpg") to their book
  for (const item of [...mediaFileItems, ...otherFileItems]) {
    if (!splitDirs.has(item.reldirpath)) continue
    const key = groupKeyByDirAndBasename[`${item.reldirpath}\n${Path.basename(item.name, item.extension)}`]
    if (!key) continue // No book with this filename, e.g. a "cover.jpg" shared by the whole directory
    const relPath = Path.posix.join(item.reldirpath, item.name)
    if (relPath !== key) groups[key].push(relPath)
  }

  return { groups, splitDirs }
}

/**
 * @param {string} mediaType
 * @param {import('./fileUtils').FilePathItem[]} fileItems
 * @param {boolean} audiobooksOnly
 * @param {boolean} [includeNonMediaFiles=false] - Used by the watcher to re-scan when covers/metadata files are added/removed
 * @param {boolean} [splitEbooksByFile=false] - Split a directory holding multiple ebooks into one library item per book
 * @returns {Record<string,string[]|string>} map of files grouped into potential libarary item dirs
 */
function groupFileItemsIntoLibraryItemDirs(mediaType, fileItems, audiobooksOnly, includeNonMediaFiles = false, splitEbooksByFile = false) {
  // Step 1: Filter out non-book-media files in root dir (with depth of 0)
  const itemsFiltered = fileItems.filter((i) => {
    return i.deep > 0 || (mediaType === 'book' && isMediaFile(mediaType, i.extension, audiobooksOnly))
  })

  // Step 2: Separate media files and other files
  //     - Directories without a media file will not be included (unless includeNonMediaFiles is true)
  /** @type {import('./fileUtils').FilePathItem[]} */
  let mediaFileItems = []
  /** @type {import('./fileUtils').FilePathItem[]} */
  let otherFileItems = []
  itemsFiltered.forEach((item) => {
    if (isMediaFile(mediaType, item.extension, audiobooksOnly) || (includeNonMediaFiles && isScannableNonMediaFile(item.extension))) {
      mediaFileItems.push(item)
    } else {
      otherFileItems.push(item)
    }
  })

  // Step 2b: Split directories holding multiple ebooks into one library item per book
  let ebookLibraryItemGroup = {}
  if (mediaType === 'book' && !audiobooksOnly && splitEbooksByFile) {
    const { groups, splitDirs } = groupEbookFilesIntoLibraryItems(mediaFileItems, otherFileItems)
    ebookLibraryItemGroup = groups
    if (splitDirs.size) {
      // Files directly in a split directory are already assigned, keep them out of the directory grouping.
      // Files in subdirectories are untouched, so an audiobook folder inside a split directory still works.
      mediaFileItems = mediaFileItems.filter((item) => !splitDirs.has(item.reldirpath))
      otherFileItems = otherFileItems.filter((item) => !splitDirs.has(item.reldirpath))
    }
  }

  // Step 3: Group media files (or non-media files if includeNonMediaFiles is true) in library items
  const libraryItemGroup = { ...ebookLibraryItemGroup }
  mediaFileItems.forEach((item) => {
    const dirparts = item.reldirpath.split('/').filter((p) => !!p)
    const numparts = dirparts.length
    let _path = ''

    if (!dirparts.length) {
      // Media file in root
      libraryItemGroup[item.name] = item.name
    } else {
      // Iterate over directories in path
      for (let i = 0; i < numparts; i++) {
        const dirpart = dirparts.shift()
        _path = Path.posix.join(_path, dirpart)

        if (libraryItemGroup[_path]) {
          // Directory already has files, add file
          const relpath = Path.posix.join(dirparts.join('/'), item.name)
          libraryItemGroup[_path].push(relpath)
          return
        } else if (!dirparts.length) {
          // This is the last directory, create group
          libraryItemGroup[_path] = [item.name]
          return
        } else if (dirparts.length === 1 && /^(cd|dis[ck])\s*\d{1,3}$/i.test(dirparts[0])) {
          // Next directory is the last and is a CD dir, create group
          libraryItemGroup[_path] = [Path.posix.join(dirparts[0], item.name)]
          return
        }
      }
    }
  })

  // Step 4: Add other files into library item groups
  otherFileItems.forEach((item) => {
    const dirparts = item.reldirpath.split('/')
    const numparts = dirparts.length
    let _path = ''

    // Iterate over directories in path
    for (let i = 0; i < numparts; i++) {
      const dirpart = dirparts.shift()
      _path = Path.posix.join(_path, dirpart)
      if (libraryItemGroup[_path]) {
        // Directory is audiobook group
        const relpath = Path.posix.join(dirparts.join('/'), item.name)
        libraryItemGroup[_path].push(relpath)
        return
      }
    }
  })
  return libraryItemGroup
}
module.exports.groupFileItemsIntoLibraryItemDirs = groupFileItemsIntoLibraryItemDirs

/**
 * Get LibraryFile from filepath
 * @param {string} libraryItemPath
 * @param {string[]} files
 * @returns {import('../objects/files/LibraryFile')}
 */
function buildLibraryFile(libraryItemPath, files) {
  return Promise.all(
    files.map(async (file) => {
      const filePath = Path.posix.join(libraryItemPath, file)
      const newLibraryFile = new LibraryFile()
      await newLibraryFile.setDataFromPath(filePath, file)
      return newLibraryFile
    })
  )
}
module.exports.buildLibraryFile = buildLibraryFile

/**
 * Get details parsed from filenames
 *
 * @param {string} relPath
 * @param {boolean} parseSubtitle
 * @returns {LibraryItemFilenameMetadata}
 */
function getBookDataFromDir(relPath, parseSubtitle = false) {
  const splitDir = relPath.split('/')

  var folder = splitDir.pop() // Audio files will always be in the directory named for the title
  series = splitDir.length > 1 ? splitDir.pop() : null // If there are at least 2 more directories, next furthest will be the series
  author = splitDir.length > 0 ? splitDir.pop() : null // There could be many more directories, but only the top 3 are used for naming /author/series/title/

  // The  may contain various other pieces of metadata, these functions extract it.
  var [folder, asin] = getASIN(folder)
  var [folder, narrators] = getNarrator(folder)
  var [folder, sequence] = series ? getSequence(folder) : [folder, null]
  var [folder, publishedYear] = getPublishedYear(folder)
  var [title, subtitle] = parseSubtitle ? getSubtitle(folder) : [folder, null]

  return {
    title,
    subtitle,
    asin,
    authors: parseNameString.parse(author)?.names || [],
    narrators: parseNameString.parse(narrators)?.names || [],
    seriesName: series,
    seriesSequence: sequence,
    publishedYear
  }
}
module.exports.getBookDataFromDir = getBookDataFromDir

/**
 * Get details parsed from a media file path
 *
 * The filename takes the place of the title directory, so "Author/Series/1 - Title.epub"
 * is parsed exactly like the directory "Author/Series/1 - Title".
 *
 * @param {string} relPath
 * @param {boolean} parseSubtitle
 * @returns {LibraryItemFilenameMetadata}
 */
function getBookDataFromFile(relPath, parseSubtitle = false) {
  const ext = Path.extname(relPath)
  return getBookDataFromDir(ext ? relPath.slice(0, -ext.length) : relPath, parseSubtitle)
}
module.exports.getBookDataFromFile = getBookDataFromFile

/**
 * Extract narrator from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, narrator]
 */
function getNarrator(folder) {
  let pattern = /^(?<title>.*) \{(?<narrators>.*)\}$/
  let match = folder.match(pattern)
  return match ? [match.groups.title, match.groups.narrators] : [folder, null]
}

/**
 * Extract series sequence from folder name
 *
 * @example
 * 'Book 2 - Title - Subtitle'
 * 'Title - Subtitle - Vol 12'
 * 'Title - volume 9 - Subtitle'
 * 'Vol. 3 Title Here - Subtitle'
 * '1980 - Book 2 - Title'
 * 'Volume 12. Title - Subtitle'
 * '100 - Book Title'
 * '6. Title'
 * '0.5 - Book Title'
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, sequence]
 */
function getSequence(folder) {
  // Matches a valid volume string. Also matches a book whose title starts with a 1 to 3 digit number. Will handle that later.
  let pattern = /^(?<volumeLabel>vol\.? |volume |book )?(?<sequence>\d{0,3}(?:\.\d{1,2})?)(?<trailingDot>\.?)(?: (?<suffix>.*))?$/i

  let volumeNumber = null
  let parts = folder.split(' - ')
  for (let i = 0; i < parts.length; i++) {
    let match = parts[i].match(pattern)
    // This excludes '101 Dalmations' but includes '101. Dalmations'
    if (match && !(match.groups.suffix && !(match.groups.volumeLabel || match.groups.trailingDot))) {
      volumeNumber = isNaN(match.groups.sequence) ? match.groups.sequence : Number(match.groups.sequence).toString()
      parts[i] = match.groups.suffix
      if (!parts[i]) {
        parts.splice(i, 1)
      }
      break
    }
  }

  folder = parts.join(' - ')
  return [folder, volumeNumber]
}

/**
 * Extract published year from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, publishedYear]
 */
function getPublishedYear(folder) {
  var publishedYear = null

  pattern = /^ *\(?([0-9]{4})\)? * - *(.+)/ //Matches #### - title or (####) - title
  var match = folder.match(pattern)
  if (match) {
    publishedYear = match[1]
    folder = match[2]
  }

  return [folder, publishedYear]
}

/**
 * Extract subtitle from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, subtitle]
 */
function getSubtitle(folder) {
  // Subtitle is everything after " - "
  var splitTitle = folder.split(' - ')
  return [splitTitle.shift(), splitTitle.join(' - ')]
}

/**
 * Extract asin from folder name
 *
 * @param {string} folder
 * @returns {[string, string]} [folder, asin]
 */
function getASIN(folder) {
  let asin = null

  let pattern = /(?: |^)\[([A-Z0-9]{10})](?= |$)/ // Matches "[B0015T963C]"
  const match = folder.match(pattern)
  if (match) {
    asin = match[1]
    folder = folder.replace(match[0], '')
  }
  return [folder.trim(), asin]
}

/**
 *
 * @param {string} relPath
 * @returns {LibraryItemFilenameMetadata}
 */
function getPodcastDataFromDir(relPath) {
  const splitDir = relPath.split('/')

  // Audio files will always be in the directory named for the title
  const title = splitDir.pop()
  return {
    title
  }
}

/**
 *
 * @param {string} libraryMediaType
 * @param {string} folderPath
 * @param {string} relPath
 * @returns {{ mediaMetadata: LibraryItemFilenameMetadata, relPath: string, path: string}}
 */
function getDataFromMediaDir(libraryMediaType, folderPath, relPath) {
  relPath = filePathToPOSIX(relPath)
  let fullPath = Path.posix.join(folderPath, relPath)
  let mediaMetadata = null

  if (libraryMediaType === 'podcast') {
    mediaMetadata = getPodcastDataFromDir(relPath)
  } else {
    // book
    mediaMetadata = getBookDataFromDir(relPath, !!global.ServerSettings.scannerParseSubtitle)
  }

  return {
    mediaMetadata,
    relPath,
    path: fullPath
  }
}
module.exports.getDataFromMediaDir = getDataFromMediaDir

/**
 * Get metadata for a single media file library item
 *
 * @param {string} libraryMediaType
 * @param {string} folderPath
 * @param {string} relPath - path of the media file relative to the library folder
 * @returns {{ mediaMetadata: LibraryItemFilenameMetadata, relPath: string, path: string}}
 */
function getDataFromMediaFile(libraryMediaType, folderPath, relPath) {
  relPath = filePathToPOSIX(relPath)
  const fullPath = Path.posix.join(folderPath, relPath)
  let mediaMetadata = null

  if (libraryMediaType === 'podcast') {
    mediaMetadata = { title: Path.basename(relPath, Path.extname(relPath)) }
  } else {
    // book
    mediaMetadata = getBookDataFromFile(relPath, !!global.ServerSettings.scannerParseSubtitle)
  }

  return {
    mediaMetadata,
    relPath,
    path: fullPath
  }
}
module.exports.getDataFromMediaFile = getDataFromMediaFile
