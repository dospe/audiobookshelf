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

  it('keeps the read aloud language of the book and the appearance per device', async () => {
    const response = await user.createUpdateMediaProgressFromPayload({
      libraryItemId,
      ebookSettings: {
        ttsLanguage: 'cs-CZ',
        legacyEncoding: 'windows-1250',
        fontScale: 120,
        devices: {
          'phone-1': { fontScale: 100, theme: 'black', ttsLanguage: 'en-US', unknownKey: 'x' },
          'tablet-1': { fontScale: 160, lineSpacing: 130 },
          'empty-1': { unknownKey: 'x' },
          'array-1': [1, 2],
          'string-1': 'x'
        }
      }
    })
    expect(response.error).to.be.undefined

    const mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({
      ttsLanguage: 'cs-CZ',
      legacyEncoding: 'windows-1250',
      fontScale: 120,
      devices: {
        'phone-1': { fontScale: 100, theme: 'black' },
        'tablet-1': { fontScale: 160, lineSpacing: 130 }
      }
    })
    expect(mediaProgress.getOldMediaProgress().ebookSettings.devices['tablet-1']).to.deep.equal({ fontScale: 160, lineSpacing: 130 })
  })

  it('ignores devices that are not a map of device settings and keeps the entries written last within the limit', async () => {
    const devices = {}
    for (let i = 0; i < 60; i++) devices[`device-${i}`] = { fontScale: 100 + i }
    devices['x'.repeat(129)] = { fontScale: 50 }
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { theme: 'light', devices } })
    let mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(Object.keys(mediaProgress.extraData.ebookSettings.devices)).to.have.lengthOf(50)
    expect(mediaProgress.extraData.ebookSettings.devices['device-0']).to.be.undefined
    expect(mediaProgress.extraData.ebookSettings.devices['device-59']).to.deep.equal({ fontScale: 159 })
    expect(mediaProgress.extraData.ebookSettings.devices['x'.repeat(129)]).to.be.undefined

    // An invalid devices value changes nothing, the flat key is still applied
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { theme: 'black', devices: ['phone-1'] } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings.theme).to.equal('black')
    expect(Object.keys(mediaProgress.extraData.ebookSettings.devices)).to.have.lengthOf(50)

    // A new device pushes the oldest entry out; an entry without a valid key is not stored
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { devices: { 'phone-1': { fontScale: 90 }, 'phone-2': { unknownKey: 'x' } } } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(Object.keys(mediaProgress.extraData.ebookSettings.devices)).to.have.lengthOf(50)
    expect(mediaProgress.extraData.ebookSettings.devices['device-10']).to.be.undefined
    expect(mediaProgress.extraData.ebookSettings.devices['device-11']).to.deep.equal({ fontScale: 111 })
    expect(mediaProgress.extraData.ebookSettings.devices['phone-1']).to.deep.equal({ fontScale: 90 })
    expect(mediaProgress.extraData.ebookSettings.devices['phone-2']).to.be.undefined
  })

  it('merges an update into the stored settings: keys and devices left out stay, null removes them', async () => {
    await user.createUpdateMediaProgressFromPayload({
      libraryItemId,
      ebookSettings: { ttsLanguage: 'cs-CZ', theme: 'light', devices: { 'phone-1': { fontScale: 100 }, 'tablet-1': { fontScale: 160, theme: 'black' } } }
    })
    user.mediaProgresses = await Database.mediaProgressModel.findAll({ where: { userId: user.id } })

    // The tablet replaces its own entry and leaves the phone and the language alone
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { devices: { 'tablet-1': { fontScale: 170 } } } })
    let mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({
      ttsLanguage: 'cs-CZ',
      theme: 'light',
      devices: { 'phone-1': { fontScale: 100 }, 'tablet-1': { fontScale: 170 } }
    })

    // The phone removes its entry and changes the language; an invalid value keeps the stored one
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { ttsLanguage: 'en-US', theme: { nested: true }, devices: { 'phone-1': null } } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ ttsLanguage: 'en-US', theme: 'light', devices: { 'tablet-1': { fontScale: 170 } } })

    // The web reader writes every flat key (null for the ones at the default) without touching the devices or the language
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({
      libraryItemId,
      ebookSettings: { theme: null, font: null, fontScale: 130, lineSpacing: null, fontBoldness: null, textStroke: null, spread: null, legacyEncoding: null }
    })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.extraData.ebookSettings).to.deep.equal({ ttsLanguage: 'en-US', fontScale: 130, devices: { 'tablet-1': { fontScale: 170 } } })

    // Removing the last key and the last device leaves no settings
    user.mediaProgresses = [mediaProgress]
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookSettings: { ttsLanguage: null, fontScale: null, devices: { 'tablet-1': null, 'unknown-1': null } } })
    mediaProgress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(mediaProgress.getOldMediaProgress().ebookSettings).to.equal(null)
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

describe('MediaProgress furthestTime', () => {
  let user
  let libraryItemId

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    const library = await Database.libraryModel.create({ name: 'Book Library', mediaType: 'book' })
    const libraryFolder = await Database.libraryFolderModel.create({ path: '/books', libraryId: library.id })
    const book = await Database.bookModel.create({ title: 'Test Book', audioFiles: [], tags: [], narrators: [], genres: [], chapters: [] })
    const libraryItem = await Database.libraryItemModel.create({
      libraryFiles: [],
      mediaId: book.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    libraryItemId = libraryItem.id

    user = await Database.userModel.create({ username: 'listener', type: 'user', isActive: true, permissions: {}, extraData: {} })
    user.mediaProgresses = []
  })

  afterEach(async () => {
    await Database.sequelize.close()
  })

  const getProgress = () => Database.mediaProgressModel.findOne({ where: { userId: user.id } })

  it('keeps the furthest position when the current position moves back', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, duration: 1000, currentTime: 100 })
    expect((await getProgress()).getOldMediaProgress().furthestTime).to.equal(100)

    await user.createUpdateMediaProgressFromPayload({ libraryItemId, currentTime: 500 })
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, currentTime: 200 })

    const oldProgress = (await getProgress()).getOldMediaProgress()
    expect(oldProgress.currentTime).to.equal(200)
    expect(oldProgress.furthestTime).to.equal(500)
  })

  it('ignores a furthestTime sent by a client', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, duration: 1000, currentTime: 100 })
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, currentTime: 150, furthestTime: 900 })

    expect((await getProgress()).getOldMediaProgress().furthestTime).to.equal(150)
  })

  it('falls back to the current position for progress saved before furthestTime was tracked', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, duration: 1000, currentTime: 300 })
    const mediaProgress = await getProgress()
    delete mediaProgress.extraData.furthestTime
    mediaProgress.changed('extraData', true)
    await mediaProgress.save()

    expect((await getProgress()).getOldMediaProgress().furthestTime).to.equal(300)

    // Moving back keeps the position it had reached
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, currentTime: 100 })
    expect((await getProgress()).getOldMediaProgress().furthestTime).to.equal(300)
  })

  it('keeps the furthest place in the ebook when reading moves back', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/4)', ebookProgress: 0.2 })
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/20)', ebookProgress: 0.6 })
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: 'epubcfi(/6/8)', ebookProgress: 0.3, furthestEbookProgress: 0.9 })

    const oldProgress = (await getProgress()).getOldMediaProgress()
    expect(oldProgress.ebookLocation).to.equal('epubcfi(/6/8)')
    expect(oldProgress.furthestEbookLocation).to.equal('epubcfi(/6/20)')
    expect(oldProgress.furthestEbookProgress).to.equal(0.6)
  })

  it('falls back to the current ebook location for progress saved before it was tracked', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: '40', ebookProgress: 0.4 })
    const mediaProgress = await getProgress()
    delete mediaProgress.extraData.furthestEbook
    mediaProgress.changed('extraData', true)
    await mediaProgress.save()
    expect((await getProgress()).getOldMediaProgress().furthestEbookLocation).to.equal('40')

    await user.createUpdateMediaProgressFromPayload({ libraryItemId, ebookLocation: '10', ebookProgress: 0.1 })
    const oldProgress = (await getProgress()).getOldMediaProgress()
    expect(oldProgress.furthestEbookLocation).to.equal('40')
    expect(oldProgress.furthestEbookProgress).to.equal(0.4)
  })

  it('starts over when the media is marked as not finished', async () => {
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, duration: 1000, currentTime: 100 })
    await user.createUpdateMediaProgressFromPayload({ libraryItemId, currentTime: 995 })
    expect((await getProgress()).isFinished).to.be.true

    await user.createUpdateMediaProgressFromPayload({ libraryItemId, isFinished: false })

    const oldProgress = (await getProgress()).getOldMediaProgress()
    expect(oldProgress.currentTime).to.equal(0)
    expect(oldProgress.furthestTime).to.equal(0)
  })
})
