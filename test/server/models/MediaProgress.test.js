const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')

describe('MediaProgress ebookSettings', () => {
  let user
  let libraryItemId

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    const library = await Database.libraryModel.create({ name: 'Book Library', mediaType: 'book' })
    const libraryFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    const book = await Database.bookModel.create({
      title: 'Test Book',
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: [],
      ebookFile: { ino: '2', metadata: { filename: 'book.rtf', ext: '.rtf', path: '/book.rtf', relPath: 'book.rtf', size: 500 }, ebookFormat: 'rtf' }
    })
    const libraryItem = await Database.libraryItemModel.create({
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    libraryItemId = libraryItem.id

    user = await Database.userModel.create({ username: 'reader', type: 'user', isActive: true, permissions: {}, extraData: {} })
    user.mediaProgresses = []
  })

  afterEach(async () => {
    await Database.sequelize.close()
  })

  it('stores whitelisted ebookSettings in extraData and exposes them in the old JSON', async () => {
    const response = await user.createUpdateMediaProgressFromPayload({
      libraryItemId,
      ebookLocation: '12',
      ebookProgress: 0.25,
      ebookSettings: { theme: 'light', fontScale: 120, legacyEncoding: 'windows-1250', unknownKey: 'x', font: { nested: true } }
    })
    expect(response.error).to.be.undefined

    const mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ theme: 'light', fontScale: 120, legacyEncoding: 'windows-1250' })
    expect(mediaProgress.ebookLocation).to.equal('12')
    expect(mediaProgress.getOldMediaProgress().ebookSettings).to.deep.equal({ theme: 'light', fontScale: 120, legacyEncoding: 'windows-1250' })
  })

  it('clears ebookSettings when null is sent and leaves them untouched when omitted', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { theme: 'black' } })
    user.mediaProgresses = await Database.mediaProgressModel.findAll({ where: { userId: user.id } })

    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: '3' })
    let mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ theme: 'black' })
    expect(mediaProgress.ebookLocation).to.equal('3')

    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: null })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.getOldMediaProgress().ebookSettings).to.equal(null)
  })

  it('does not move lastUpdate for an update carrying only ebookSettings', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/2!/4/2/1:0)', ebookProgress: 0.3 })
    user.mediaProgresses = await Database.mediaProgressModel.findAll({ where: { userId: user.id } })

    // A position update from a device sync carries its own lastUpdate, which becomes updatedAt
    const lastUpdate = Date.now() - 60 * 60 * 1000
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/4!/4/2/1:0)', ebookProgress: 0.4, lastUpdate })
    let mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.getOldMediaProgress().lastUpdate).to.equal(lastUpdate)
    user.mediaProgresses = [mediaProgress]

    // Display settings alone leave the position and its timestamp as they are
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { fontScale: 130 } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ fontScale: 130 })
    expect(mediaProgress.ebookLocation).to.equal('epubcfi(/6/4!/4/2/1:0)')
    expect(mediaProgress.getOldMediaProgress().lastUpdate).to.equal(lastUpdate)

    // A position update (with or without settings) still moves it
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/6!/4/2/1:0)', ebookProgress: 0.5, ebookSettings: { fontScale: 140 } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.getOldMediaProgress().lastUpdate).to.be.greaterThan(lastUpdate)
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ fontScale: 140 })
  })
})
