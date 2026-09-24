const { DataTypes, Model } = require('sequelize')
const Logger = require('../Logger')
const { isNullOrNaN } = require('../utils')

// Per-book ereader settings (extraData.ebookSettings): the appearance and the
// text encoding any client stores at the top level, the read aloud language of
// the book, and the appearance the mobile app keeps per device under `devices`
// ({ [deviceId]: { theme, fontScale, ... } }) - a font size that suits a
// tablet is too big for a phone.
//
// An update merges into what is stored (see mergeEbookSettings): every client
// writes only the keys it manages and the entries of the other devices stay.
// Replacing the whole object let the web reader, which knows only the flat
// keys, wipe the per-device appearance, and a mobile reader left open for
// days wrote back the device map it had loaded when the book was opened.
const EBOOK_APPEARANCE_KEYS = ['theme', 'font', 'fontScale', 'lineSpacing', 'fontBoldness', 'textStroke', 'spread']
const EBOOK_SETTINGS_KEYS = [...EBOOK_APPEARANCE_KEYS, 'legacyEncoding', 'ttsLanguage']
const EBOOK_SETTINGS_MAX_DEVICES = 50
const EBOOK_SETTINGS_MAX_DEVICE_ID_LENGTH = 128

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether the value is storable as an ebook setting (a short string or a finite number)
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEbookSettingValue(value) {
  if (typeof value === 'string') return value.length <= 64
  return typeof value === 'number' && isFinite(value)
}

/**
 * Whitelisted string and number values of an ebook settings object
 *
 * @param {Object} settings
 * @param {string[]} allowedKeys
 * @returns {Object}
 */
function pickEbookSettingValues(settings, allowedKeys) {
  const picked = {}
  for (const key of allowedKeys) {
    if (isEbookSettingValue(settings[key])) picked[key] = settings[key]
  }
  return picked
}

/**
 * Whether a device id may key an entry of `devices`
 *
 * @param {string} deviceId
 * @returns {boolean}
 */
function isValidDeviceId(deviceId) {
  return !!deviceId && deviceId.length <= EBOOK_SETTINGS_MAX_DEVICE_ID_LENGTH
}

class MediaProgress extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.mediaItemId
    /** @type {string} */
    this.mediaItemType
    /** @type {number} */
    this.duration
    /** @type {number} */
    this.currentTime
    /** @type {boolean} */
    this.isFinished
    /** @type {boolean} */
    this.hideFromContinueListening
    /** @type {string} */
    this.ebookLocation
    /** @type {number} */
    this.ebookProgress
    /** @type {Date} */
    this.finishedAt
    /** @type {Object} */
    this.extraData
    /** @type {UUIDV4} */
    this.userId
    /** @type {Date} */
    this.updatedAt
    /** @type {Date} */
    this.createdAt
    /** @type {UUIDV4} */
    this.podcastId
  }

  static removeById(mediaProgressId) {
    return this.destroy({
      where: {
        id: mediaProgressId
      }
    })
  }

  /**
   * Initialize model
   *
   * Polymorphic association: Book has many MediaProgress. PodcastEpisode has many MediaProgress.
   * @see https://sequelize.org/docs/v6/advanced-association-concepts/polymorphic-associations/
   *
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        mediaItemId: DataTypes.UUID,
        mediaItemType: DataTypes.STRING,
        duration: DataTypes.FLOAT,
        currentTime: DataTypes.FLOAT,
        isFinished: DataTypes.BOOLEAN,
        hideFromContinueListening: DataTypes.BOOLEAN,
        ebookLocation: DataTypes.STRING,
        ebookProgress: DataTypes.FLOAT,
        finishedAt: DataTypes.DATE,
        extraData: DataTypes.JSON,
        podcastId: DataTypes.UUID
      },
      {
        sequelize,
        modelName: 'mediaProgress',
        indexes: [
          {
            fields: ['updatedAt']
          },
          {
            name: 'media_progresses_user_item_finished_time',
            fields: ['userId', 'mediaItemId', 'isFinished', 'currentTime']
          }
        ]
      }
    )

    const { book, podcastEpisode, user } = sequelize.models

    book.hasMany(MediaProgress, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'book'
      }
    })
    MediaProgress.belongsTo(book, { foreignKey: 'mediaItemId', constraints: false })

    podcastEpisode.hasMany(MediaProgress, {
      foreignKey: 'mediaItemId',
      constraints: false,
      scope: {
        mediaItemType: 'podcastEpisode'
      }
    })
    MediaProgress.belongsTo(podcastEpisode, { foreignKey: 'mediaItemId', constraints: false })

    MediaProgress.addHook('afterFind', (findResult) => {
      if (!findResult) return

      if (!Array.isArray(findResult)) findResult = [findResult]

      for (const instance of findResult) {
        if (instance.mediaItemType === 'book' && instance.book !== undefined) {
          instance.mediaItem = instance.book
          instance.dataValues.mediaItem = instance.dataValues.book
        } else if (instance.mediaItemType === 'podcastEpisode' && instance.podcastEpisode !== undefined) {
          instance.mediaItem = instance.podcastEpisode
          instance.dataValues.mediaItem = instance.dataValues.podcastEpisode
        }
        // To prevent mistakes:
        delete instance.book
        delete instance.dataValues.book
        delete instance.podcastEpisode
        delete instance.dataValues.podcastEpisode
      }
    })

    // make sure to call the afterDestroy hook for each instance
    MediaProgress.addHook('beforeBulkDestroy', (options) => {
      options.individualHooks = true
    })

    // update the potentially cached user after destroying the media progress
    MediaProgress.addHook('afterDestroy', (instance) => {
      user.mediaProgressRemoved(instance)
    })

    user.hasMany(MediaProgress, {
      onDelete: 'CASCADE'
    })
    MediaProgress.belongsTo(user)
  }

  getMediaItem(options) {
    if (!this.mediaItemType) return Promise.resolve(null)
    const mixinMethodName = `get${this.sequelize.uppercaseFirst(this.mediaItemType)}`
    return this[mixinMethodName](options)
  }

  getOldMediaProgress() {
    const isPodcastEpisode = this.mediaItemType === 'podcastEpisode'

    return {
      id: this.id,
      userId: this.userId,
      libraryItemId: this.extraData?.libraryItemId || null,
      episodeId: isPodcastEpisode ? this.mediaItemId : null,
      mediaItemId: this.mediaItemId,
      mediaItemType: this.mediaItemType,
      duration: this.duration,
      progress: this.extraData?.progress || 0,
      currentTime: this.currentTime,
      isFinished: !!this.isFinished,
      hideFromContinueListening: !!this.hideFromContinueListening,
      ebookLocation: this.ebookLocation,
      ebookProgress: this.ebookProgress,
      ebookSettings: this.extraData?.ebookSettings || null,
      furthestTime: this.furthestTime,
      lastUpdate: this.updatedAt.valueOf(),
      startedAt: this.createdAt.valueOf(),
      finishedAt: this.finishedAt?.valueOf() || null
    }
  }

  /**
   * Per-book ereader settings overrides stored in extraData.
   * Only whitelisted keys are kept (see EBOOK_SETTINGS_KEYS): the settings of
   * the book at the top level and the appearance per device under `devices`.
   * Returns null when nothing is left.
   *
   * @param {Object|null} ebookSettings
   * @returns {Object|null}
   */
  static sanitizeEbookSettings(ebookSettings) {
    if (!isPlainObject(ebookSettings)) return null
    const sanitized = pickEbookSettingValues(ebookSettings, EBOOK_SETTINGS_KEYS)
    if (isPlainObject(ebookSettings.devices)) {
      const devices = {}
      for (const deviceId of Object.keys(ebookSettings.devices)) {
        if (Object.keys(devices).length >= EBOOK_SETTINGS_MAX_DEVICES) break
        if (!isValidDeviceId(deviceId) || !isPlainObject(ebookSettings.devices[deviceId])) continue
        const deviceSettings = pickEbookSettingValues(ebookSettings.devices[deviceId], EBOOK_APPEARANCE_KEYS)
        if (Object.keys(deviceSettings).length) devices[deviceId] = deviceSettings
      }
      if (Object.keys(devices).length) sanitized.devices = devices
    }
    return Object.keys(sanitized).length ? sanitized : null
  }

  /**
   * Merge an ebookSettings update into the stored settings of a book:
   * - `null` clears everything (the reset an older client sends),
   * - a flat key (see EBOOK_SETTINGS_KEYS) is set by a string or number value
   *   and removed by `null`; a key left out or with an invalid value stays,
   * - an entry of `devices` is replaced as a whole by an object of appearance
   *   keys (the complete override of that device), removed by `null` or by an
   *   object without a valid key; devices left out stay.
   * The oldest entries are dropped when a device would push the map past the
   * limit. Returns the settings to store, null when nothing is left.
   *
   * @param {Object|null} current - the stored settings
   * @param {Object|null} update - the update from the client
   * @returns {Object|null}
   */
  static mergeEbookSettings(current, update) {
    if (update === null) return null
    const stored = MediaProgress.sanitizeEbookSettings(current)
    if (!isPlainObject(update)) return stored

    const merged = { ...(stored || {}) }
    const devices = isPlainObject(merged.devices) ? { ...merged.devices } : {}
    delete merged.devices

    for (const key of EBOOK_SETTINGS_KEYS) {
      if (update[key] === undefined) continue
      if (update[key] === null) {
        delete merged[key]
      } else if (isEbookSettingValue(update[key])) {
        merged[key] = update[key]
      }
    }

    if (isPlainObject(update.devices)) {
      for (const deviceId of Object.keys(update.devices)) {
        if (!isValidDeviceId(deviceId) || update.devices[deviceId] === undefined) continue
        const deviceSettings = isPlainObject(update.devices[deviceId]) ? pickEbookSettingValues(update.devices[deviceId], EBOOK_APPEARANCE_KEYS) : {}
        // Re-inserted at the end so the entries written last are the ones the limit keeps
        delete devices[deviceId]
        if (Object.keys(deviceSettings).length) devices[deviceId] = deviceSettings
      }
    }

    const deviceIds = Object.keys(devices)
    while (deviceIds.length > EBOOK_SETTINGS_MAX_DEVICES) delete devices[deviceIds.shift()]
    if (deviceIds.length) merged.devices = devices

    return Object.keys(merged).length ? merged : null
  }

  /**
   * The furthest position ever reached in the media (extraData.furthestTime),
   * so a client can offer to jump back there after the current position moved
   * back (a sync from another device, an accidental seek). Progress saved before
   * it was tracked falls back to the current position.
   *
   * @returns {number}
   */
  get furthestTime() {
    const furthestTime = Number(this.extraData?.furthestTime)
    return Math.max(isNaN(furthestTime) ? 0 : furthestTime, this.currentTime || 0)
  }

  get progress() {
    // Value between 0 and 1
    if (!this.duration) return 0
    return Math.max(0, Math.min(this.currentTime / this.duration, 1))
  }

  /**
   * Apply update to media progress
   *
   * @param {import('./User').ProgressUpdatePayload} progressPayload
   * @returns {Promise<MediaProgress>}
   */
  async applyProgressUpdate(progressPayload) {
    if (!this.extraData) this.extraData = {}
    // A payload carrying only ebookSettings changes how the book is displayed,
    // not how far it was read. Saved silently so updatedAt (lastUpdate for the
    // clients) stays with the last position update - otherwise a reading
    // position saved elsewhere (the local db of a phone) would lose against
    // the unchanged server position just because it is "older"
    const isEbookSettingsOnlyUpdate = progressPayload.ebookSettings !== undefined && Object.keys(progressPayload).every((key) => ['ebookSettings', 'libraryItemId', 'episodeId'].includes(key))
    if (progressPayload.ebookSettings !== undefined) {
      const ebookSettings = MediaProgress.mergeEbookSettings(this.extraData.ebookSettings, progressPayload.ebookSettings)
      if (ebookSettings) {
        this.extraData.ebookSettings = ebookSettings
      } else {
        delete this.extraData.ebookSettings
      }
      this.changed('extraData', true)
      delete progressPayload.ebookSettings
    }
    // Derived from currentTime by the server only
    delete progressPayload.furthestTime
    if (progressPayload.isFinished !== undefined) {
      if (progressPayload.isFinished && !this.isFinished) {
        this.finishedAt = progressPayload.finishedAt || Date.now()
        this.extraData.progress = 1
        this.changed('extraData', true)
        delete progressPayload.finishedAt
      } else if (!progressPayload.isFinished && this.isFinished) {
        this.finishedAt = null
        this.extraData.progress = 0
        this.currentTime = 0
        // Listening starts over
        delete this.extraData.furthestTime
        this.changed('extraData', true)
        delete progressPayload.finishedAt
        delete progressPayload.currentTime
      }
    } else if (!isNaN(progressPayload.progress) && progressPayload.progress !== this.progress) {
      // Old model stored progress on object
      this.extraData.progress = Math.min(1, Math.max(0, progressPayload.progress))
      this.changed('extraData', true)
    }

    this.set(progressPayload)

    if (this.changed('currentTime') && this.currentTime > (Number(this.extraData.furthestTime) || 0)) {
      this.extraData.furthestTime = this.currentTime
      this.changed('extraData', true)
    }

    // Reset hideFromContinueListening if the progress has changed
    if (this.changed('currentTime') && !progressPayload.hideFromContinueListening) {
      this.hideFromContinueListening = false
    }

    const timeRemaining = this.duration - this.currentTime

    // Check if progress is far enough to mark as finished
    //   - If markAsFinishedPercentComplete is provided, use that otherwise use markAsFinishedTimeRemaining (default 10 seconds)
    let shouldMarkAsFinished = false
    if (this.duration) {
      if (!isNullOrNaN(progressPayload.markAsFinishedPercentComplete) && progressPayload.markAsFinishedPercentComplete > 0) {
        const markAsFinishedPercentComplete = Number(progressPayload.markAsFinishedPercentComplete) / 100
        shouldMarkAsFinished = markAsFinishedPercentComplete < this.progress
        if (shouldMarkAsFinished) {
          Logger.info(`[MediaProgress] Marking media progress as finished because progress (${this.progress}) is greater than ${markAsFinishedPercentComplete} (media item ${this.mediaItemId})`)
        }
      } else {
        const markAsFinishedTimeRemaining = isNullOrNaN(progressPayload.markAsFinishedTimeRemaining) ? 10 : Number(progressPayload.markAsFinishedTimeRemaining)
        shouldMarkAsFinished = timeRemaining < markAsFinishedTimeRemaining
        if (shouldMarkAsFinished) {
          Logger.info(`[MediaProgress] Marking media progress as finished because time remaining (${timeRemaining}) is less than ${markAsFinishedTimeRemaining} seconds (media item ${this.mediaItemId})`)
        }
      }
    }

    if (!this.isFinished && shouldMarkAsFinished) {
      this.isFinished = true
      this.finishedAt = this.finishedAt || Date.now()
      this.extraData.progress = 1
      this.changed('extraData', true)
    } else if (this.isFinished && this.changed('currentTime') && !shouldMarkAsFinished) {
      this.isFinished = false
      this.finishedAt = null
    }

    await this.save(isEbookSettingsOnlyUpdate ? { silent: true } : undefined)

    // For local sync
    if (progressPayload.lastUpdate) {
      if (isNaN(new Date(progressPayload.lastUpdate))) {
        Logger.warn(`[MediaProgress] Invalid date provided for lastUpdate: ${progressPayload.lastUpdate} (media item ${this.mediaItemId})`)
      } else {
        const escapedDate = this.sequelize.escape(new Date(progressPayload.lastUpdate))
        Logger.info(`[MediaProgress] Manually setting updatedAt to ${escapedDate} (media item ${this.mediaItemId})`)

        await this.sequelize.query(`UPDATE "mediaProgresses" SET "updatedAt" = ${escapedDate} WHERE "id" = '${this.id}'`)

        await this.reload()
      }
    }

    return this
  }
}

module.exports = MediaProgress
