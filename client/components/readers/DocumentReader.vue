<template>
  <div class="w-full h-full">
    <div ref="viewer" class="document-viewer absolute overflow-y-auto overflow-x-hidden left-0 right-0 top-16 w-full max-w-4xl m-auto z-10" :class="{ 'player-open': playerOpen }" @scroll.passive="onScroll">
      <div ref="content" class="document-content w-full px-6 pt-4 pb-16" :class="fontClass" :style="contentStyle" />

      <div v-if="errorMessage" class="w-full flex items-center justify-center px-8 py-16">
        <p class="text-center text-gray-300">{{ errorMessage }}</p>
      </div>
    </div>

    <div v-show="loading" class="absolute top-0 left-0 w-full h-full flex items-center justify-center z-20">
      <ui-loading-indicator />
    </div>

    <div class="absolute bottom-0 left-0 w-full h-8 px-4 flex items-center text-gray-400 text-xs z-10 pointer-events-none">
      <p v-if="usedFallbackEncoding" class="truncate">{{ effectiveLegacyEncoding }}</p>
      <div class="flex-grow" />
      <p>{{ progressPercent }}%</p>
    </div>
  </div>
</template>

<script>
import defaultCss from '@/assets/ebooks/basic.js'
import { parseDocumentToHtml } from '@/assets/ebooks/documentParser.js'
import { guessLegacyEncoding } from '@/assets/ebooks/textEncoding.js'

/**
 * Reader for the "document" ebook formats (doc, docx, rtf, pdb). The file is
 * parsed into a small HTML subset and rendered in a scrolling container. The
 * reading position is the index of the first visible paragraph.
 */
export default {
  props: {
    libraryItem: {
      type: Object,
      default: () => {}
    },
    playerOpen: Boolean,
    keepProgress: Boolean,
    fileId: String,
    ebookFormat: String
  },
  data() {
    return {
      loading: true,
      errorMessage: null,
      fileData: null,
      blocks: [],
      chapters: [],
      progressPercent: 0,
      usedFallbackEncoding: false,
      scrollTimeout: null,
      lastSavedLocation: null,
      ereaderSettings: {
        theme: 'dark',
        font: 'serif',
        fontScale: 100,
        lineSpacing: 115,
        textStroke: 0,
        legacyEncoding: ''
      }
    }
  },
  computed: {
    libraryItemId() {
      return this.libraryItem?.id
    },
    ebookUrl() {
      if (this.fileId) {
        return `/api/items/${this.libraryItemId}/ebook/${this.fileId}`
      }
      return `/api/items/${this.libraryItemId}/ebook`
    },
    userMediaProgress() {
      if (!this.libraryItemId) return null
      return this.$store.getters['user/getUserMediaProgress'](this.libraryItemId)
    },
    savedBlockIndex() {
      if (!this.keepProgress) return 0
      const location = Number(this.userMediaProgress?.ebookLocation)
      if (isNaN(location) || location < 0) return 0
      return Math.floor(location)
    },
    effectiveLegacyEncoding() {
      return this.ereaderSettings.legacyEncoding || guessLegacyEncoding(navigator.language)
    },
    fontClass() {
      return this.ereaderSettings.font === 'sans-serif' ? 'font-sans' : 'font-serif'
    },
    contentStyle() {
      const fontScale = Number(this.ereaderSettings.fontScale) || 100
      const lineSpacing = Number(this.ereaderSettings.lineSpacing) || 115
      const textStroke = Number(this.ereaderSettings.textStroke) || 0
      return {
        fontSize: `${fontScale}%`,
        lineHeight: `${lineSpacing}%`,
        '-webkit-text-stroke': textStroke ? `${textStroke / 100}px currentColor` : ''
      }
    }
  },
  methods: {
    updateSettings(settings) {
      const encodingChanged = (settings.legacyEncoding || '') !== (this.ereaderSettings.legacyEncoding || '')
      this.ereaderSettings = { ...this.ereaderSettings, ...settings }
      if (encodingChanged && this.usedFallbackEncoding && this.fileData) {
        const index = this.currentBlockIndex()
        this.render().then(() => this.scrollToBlock(index))
      }
    },
    goToChapter(href) {
      const index = Number(String(href).replace(/^#block-/, ''))
      if (!isNaN(index)) this.scrollToBlock(index)
    },
    collectBlocks() {
      const content = this.$refs.content
      if (!content) return []
      const selector = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, dt, dd'
      const blocks = []
      content.querySelectorAll(selector).forEach((el) => {
        if (el.parentElement?.closest(selector)) return
        if (!(el.textContent || '').trim()) return
        blocks.push(el)
      })
      return blocks
    },
    /** Index of the first block whose bottom edge is below the top of the view */
    currentBlockIndex() {
      const viewer = this.$refs.viewer
      if (!viewer || !this.blocks.length) return 0
      const scrollTop = viewer.scrollTop + 4
      const index = this.blocks.findIndex((el) => el.offsetTop + el.offsetHeight > scrollTop)
      return index < 0 ? this.blocks.length - 1 : index
    },
    scrollToBlock(index) {
      const viewer = this.$refs.viewer
      const el = this.blocks[index]
      if (!viewer || !el) return
      viewer.scrollTop = Math.max(0, el.offsetTop - 8)
      this.updateProgressPercent()
    },
    next() {
      const viewer = this.$refs.viewer
      if (!viewer) return
      viewer.scrollTo({ top: viewer.scrollTop + viewer.clientHeight - 48, behavior: 'smooth' })
    },
    prev() {
      const viewer = this.$refs.viewer
      if (!viewer) return
      viewer.scrollTo({ top: Math.max(0, viewer.scrollTop - viewer.clientHeight + 48), behavior: 'smooth' })
    },
    onScroll() {
      this.updateProgressPercent()
      clearTimeout(this.scrollTimeout)
      this.scrollTimeout = setTimeout(() => this.updateProgress(), 1000)
    },
    updateProgressPercent() {
      const viewer = this.$refs.viewer
      if (!viewer) return
      const scrollable = viewer.scrollHeight - viewer.clientHeight
      this.progressPercent = scrollable > 0 ? Math.min(100, Math.round((viewer.scrollTop / scrollable) * 100)) : 100
    },
    isAtEnd() {
      const viewer = this.$refs.viewer
      return !!viewer && viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 4
    },
    updateProgress() {
      if (!this.keepProgress || !this.blocks.length || this.loading || !this.libraryItemId) return

      const index = this.currentBlockIndex()
      const ebookProgress = this.isAtEnd() ? 1 : Math.max(0, Math.min(1, index / this.blocks.length))
      const payload = {
        ebookLocation: String(index),
        ebookProgress
      }
      if (this.lastSavedLocation === `${payload.ebookLocation}:${ebookProgress}`) return
      this.lastSavedLocation = `${payload.ebookLocation}:${ebookProgress}`

      this.$axios.$patch(`/api/me/progress/${this.libraryItemId}`, payload, { progress: false }).catch((error) => {
        console.error('DocumentReader.updateProgress failed:', error)
      })
    },
    buildChapters() {
      const chapters = []
      this.blocks.forEach((el, index) => {
        if (!/^H[1-3]$/.test(el.tagName)) return
        const title = (el.textContent || '').trim()
        if (!title) return
        chapters.push({ id: `block-${index}`, title, label: title, href: `#block-${index}`, subitems: [] })
      })
      this.chapters = chapters
    },
    async render() {
      const content = this.$refs.content
      if (!content || !this.fileData) return
      this.loading = true
      this.errorMessage = null
      // Let the spinner paint before the (synchronous) parse
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        const result = await parseDocumentToHtml(this.fileData, {
          format: this.ebookFormat,
          legacyEncoding: this.effectiveLegacyEncoding
        })
        this.usedFallbackEncoding = result.usedFallbackEncoding
        let html = result.html
        if (result.rawHtml) {
          // Book HTML from the MOBI parser relies on calibre's class based stylesheet
          html = `<style>${defaultCss}</style>${html}`
        }
        content.innerHTML = html
        content.querySelectorAll('a[href]').forEach((a) => a.removeAttribute('href'))
        this.blocks = this.collectBlocks()
        this.buildChapters()
      } catch (error) {
        console.error('[DocumentReader] Failed to open document', error)
        content.innerHTML = ''
        this.blocks = []
        const message = error?.code === 'encrypted' ? this.$strings.MessageEbookEncrypted : error?.code === 'unsupported' ? this.$getString('MessageUnsupportedEbookFormat', [error.message || this.ebookFormat]) : this.$strings.MessageEbookOpenFailed
        this.errorMessage = message
        this.$toast.error(message)
      }
      this.loading = false
    },
    async init() {
      this.loading = true
      try {
        this.fileData = await this.$axios.$get(this.ebookUrl, { responseType: 'arraybuffer' })
      } catch (error) {
        console.error('[DocumentReader] Failed to load document', error)
        this.errorMessage = this.$strings.MessageEbookOpenFailed
        this.$toast.error(this.$strings.MessageEbookOpenFailed)
        this.loading = false
        return
      }
      await this.render()
      if (!this.errorMessage) {
        await this.$nextTick()
        if (this.savedBlockIndex > 0) this.scrollToBlock(this.savedBlockIndex)
        this.updateProgressPercent()
      }
    }
  },
  mounted() {
    this.init()
  },
  beforeDestroy() {
    clearTimeout(this.scrollTimeout)
    this.updateProgress()
  }
}
</script>

<style>
.document-viewer {
  height: calc(100% - 96px);
}
.document-viewer.player-open {
  height: calc(100% - 260px);
}
.document-content p {
  margin: 0 0 0.9em 0;
  text-align: justify;
  hyphens: auto;
}
.document-content h1,
.document-content h2,
.document-content h3,
.document-content h4,
.document-content h5,
.document-content h6 {
  font-weight: bold;
  margin: 1.4em 0 0.7em 0;
  line-height: 1.25;
}
.document-content h1 {
  font-size: 1.6em;
}
.document-content h2 {
  font-size: 1.35em;
}
.document-content h3 {
  font-size: 1.15em;
}
.document-content img {
  max-width: 100%;
  height: auto;
}
</style>
