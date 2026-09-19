# Changelog of the dospe/audiobookshelf fork

Fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf) run as a Docker stack in `/opt/audio` (see [docs/UPDATE.md](docs/UPDATE.md)). Versions have the form `<upstream version>-dospe.<n>`: the first part says which upstream release the fork is based on, the suffix grows with every fork change. The Docker image `ghcr.io/dospe/audiobookshelf` is published with the tags `latest`, `edge` and this version.

## 2.36.1-dospe.6 – 2026-09-19

### Fixed

- [#16](https://github.com/dospe/audiobookshelf/pull/16) – The Docker image of 2.36.1-dospe.5 never got built: the `build-client` stage of the Dockerfile ran `npm ci` for `linux/arm64` under QEMU on the GitHub runner and died with `Illegal instruction` (the same QEMU problem upstream worked around for `tsc` in the new `compile-server` stage). The client output is static files, so the stage now runs on the builder CPU (`FROM --platform=$BUILDPLATFORM`) like the server compile; the runtime image still installs the native server dependencies for the target platform.

## 2.36.1-dospe.5 – 2026-09-19

Base: upstream v2.36.1 plus the upstream `master` commits up to `1e88ff01` (15 commits after the release). Conflicts only in the version fields of the package files.

### Changed

- [#15](https://github.com/dospe/audiobookshelf/pull/15) – Upstream `master` merged into the fork. It brings:
  - v2.36.1: hardened endpoints (the settings PATCH accepts a fixed set of general settings, auth settings only through the auth-settings endpoint; the cover endpoints accept only `webp`, `jpeg` and `png` as the format; the library item `updateMedia` endpoint no longer accepts `ebookFile`, `chapters` and `audioFiles`; narrator, author and share endpoints scoped and returning 404 correctly; comic book extractor path sanitization; `authLoginCustomMessage` sanitized), a logging fix in `AudioMetadataManager` and Weblate updates,
  - the start of the TypeScript migration ([advplyr#5510](https://github.com/advplyr/audiobookshelf/pull/5510)): the server is compiled with `tsc` (`tsconfig.server.json`, `allowJs`) into `dist-server` and started from there; the Dockerfile compiles it on the build platform (no `tsc` under QEMU on arm64) and the runtime image runs `dist-server/index.js`; `npm test` runs against the compiled output after `npm run build:server`,
  - the translate-credits workflow.
- `docker-build.yml` keeps the fork's setup (image published to `ghcr.io/<owner>/audiobookshelf`, no Docker Hub login, no `advplyr/audiobookshelf` repository guard that would skip the fork's builds) and takes over upstream's new path triggers (`Dockerfile`, `tsconfig.server.json`).

### Fixed

- The compiled server runs in strict mode (`"use strict"` in every file of `dist-server`), where a name that was never declared throws `ReferenceError` instead of quietly becoming a global. Upstream `master` has these; the fork's `getBookDataFromFile` tests caught the first one and an `eslint no-undef` pass over `server/` the rest:
  - `getBookDataFromDir` and `getPublishedYear` in `server/utils/scandir.js` assigned `series`, `author` and `pattern` without declaring them, so the scanner threw for every book folder named from its path (`ReferenceError: series is not defined`) - declared;
  - `BackupManager` logged an undefined `path` when moving an uploaded backup failed (the log line itself threw) - logs the temp path;
  - `BinaryManager` referenced `binaryPath` in a catch block it was not declared in - declared outside the `try`;
  - `podcastUtils.extractStringOrStringify` stringified an undefined `value` and always fell through to an empty string - stringifies the given object as intended.

## 2.36.0-dospe.4 – 2026-09-19

### Changed

- [#14](https://github.com/dospe/audiobookshelf/pull/14) – `PATCH /api/me/progress/:id` merges `ebookSettings` into the stored settings of the book instead of replacing them. A flat key (`theme`, `font`, `fontScale`, `lineSpacing`, `fontBoldness`, `textStroke`, `spread`, `legacyEncoding`, `ttsLanguage`) is set by a value and removed by `null`; an entry of `devices` is replaced by an object and removed by `null`; keys and devices left out stay as they are; `ebookSettings: null` still clears everything, as older clients expect. When the map would exceed 50 devices the oldest entries are dropped. Until now every client wrote the whole object: the web reader, which knows only the flat keys, wiped the per-device appearance saved by the mobile app, and a mobile reader left open for days wrote back the device map it had loaded when the book was opened, dropping the entries the other devices had saved since. Both looked like "the app does not remember the settings of this book".
- The web reader sends every per-book key it manages on each save (`null` for the ones back at the default), so the merge can remove them.

### Counterpart in the mobile app

[dospe/audiobookshelf-app#29](https://github.com/dospe/audiobookshelf-app/pull/29) (branch `claude/cross-device-reading-settings-walw6k`) on top of this server version:

- The appearance saved for a book (font size, theme, ...) was not applied when the book opened, only after any later settings change, whenever the read aloud page step differed from 3: the read aloud sync asked epub.js for the page size before the book was displayed, which throws, and the appearance settings were skipped with it.
- The app sends only its own device entry and the shared keys of the book (this merge; the whole object on an older server), keeps an unsent save in the preferences and sends it on the next start, and flushes a pending save when the reader closes or the app goes to the background.
- The reader follows a newer reading position from the server while it is open (socket events, return to the foreground, network back), automatically or after asking, per a new setting; a failed position fetch when the book opens is retried in the background and the stale position is not pushed to the server meanwhile.
- Read aloud resumed after a longer pause (Android Auto, lock screen, the reader) continues from a newer server position; a downloaded book picked in the car takes the newer of the phone's and the server's position; iOS sends a newer local reading position to the server on the progress sync as Android does; a car or headset disconnect pauses read aloud and saves the position.

## 2.36.0-dospe.3 – 2026-09-09

Base: upstream v2.36.0 plus the upstream `master` commits up to `0a797ab` (11 commits after the release), merged without conflicts.

### Added

- [#12](https://github.com/dospe/audiobookshelf/pull/12) – `ebookSettings` accepts a per-device appearance (`devices[deviceId]`, up to 50 devices) and the read-aloud language (`ttsLanguage`) for the mobile app; the top-level keys stay as they are for the web client and older app versions.

### Changed

- Upstream `master` merged into the fork. It brings:
  - the podcast rescan no longer emits stale episodes in the `item_updated` event ([advplyr#5409](https://github.com/advplyr/audiobookshelf/pull/5409)),
  - the collapsed series query works with active filters ([advplyr#5280](https://github.com/advplyr/audiobookshelf/pull/5280)),
  - npm 12 compatibility: `allowScripts` for `sqlite3` in `package.json` ([advplyr#5429](https://github.com/advplyr/audiobookshelf/pull/5429)),
  - the new Next (React) client keeps its base path when served under a subfolder ([advplyr#5507](https://github.com/advplyr/audiobookshelf/pull/5507)); this does not affect the Vue client the fork uses.
- All fork documentation is in English: `docs/UPDATE.md` (was `docs/UPDATE.cs.md`), `docs/EBOOKS.md` (was `docs/EBOOKS.cs.md`), this changelog and the fork section of `readme.md`.

### Fixed

- `docs/UPDATE.md` no longer describes the repository as private; the scripts can be downloaded with a plain `curl`, no token is needed.
- The fork section of `readme.md` lists every fork change, including the per-book reader settings and their per-device variant for the mobile app, and the ebook feature list names the formats added by the fork.

## 2.36.0-dospe.2 – 2026-09-07

### Fixed

- A `PATCH /api/me/progress/:id` carrying only `ebookSettings` (the display settings of a book saved from the mobile app or the web) no longer moves the `lastUpdate` of the progress (it is saved with `silent: true`). Until now every font size change looked like a newer reading position, so the mobile app, when comparing the server and local positions (`syncLocalMediaProgressForUser`, Android Auto), preferred the older server position over the newer local one and the reading position on the phone drifted away from the read-aloud position. The counterpart in the app: dospe/audiobookshelf-app, branch `claude/ebook-tts-sync-mobile-ntqnjk`.

## 2.36.0-dospe.1 – 2026-09-05

Base: upstream v2.36.0.

### Added

- Fork versioning (`2.36.0-dospe.N`) in the `package.json` of the server and the client; the version is shown in the UI at the bottom left and in the server log at startup, so it is clear which build is running.
- The Docker image built from `master` is also tagged with the version (`ghcr.io/dospe/audiobookshelf:2.36.0-dospe.1`), so it can be pinned in `.env` through `ABS_TAG`.
- This `CHANGELOG.md` and the fork section in `readme.md`.

### Fixed

- The update check and the changelog in the UI compare against upstream releases by the base version (`2.36.0`), so they keep working with the fork suffix.

## Earlier fork changes (without a fork version, image `latest` from 4–5 September 2026)

Based on upstream v2.36.0. In the order they were merged into `master`.

- [#1](https://github.com/dospe/audiobookshelf/pull/1) (2026-09-04) – `doc`, `docx`, `rtf` and `pdb` files are treated as ebooks; the web reader displays them and remembers the display settings and the text encoding for every book separately.
- [#2](https://github.com/dospe/audiobookshelf/pull/2) (2026-09-04) – The Docker image is built and published from the fork to `ghcr.io/dospe/audiobookshelf` (tags `latest` and `edge`) on every push to `master`.
- [#3](https://github.com/dospe/audiobookshelf/pull/3) (2026-09-05) – Idempotent script `scripts/update-server.sh` (image pull, config backup, recreation of changed containers only, health check) and the update guide `docs/UPDATE.md` (Czech at the time).
- [#4](https://github.com/dospe/audiobookshelf/pull/4) (2026-09-05) – Guide: the package on ghcr is public, only the repository was private.
- [#5](https://github.com/dospe/audiobookshelf/pull/5) (2026-09-05) – `scripts/deploy.sh`: deployment of the whole stack in `/opt/audio` including the Czech metadata provider (`ghcr.io/stecik/audiobookshelf_czech_metadata`) and the takeover of data from an older installation.
- [#6](https://github.com/dospe/audiobookshelf/pull/6) (2026-09-05) – Caddy as an HTTPS reverse proxy with an automatic Let's Encrypt certificate.
- [#7](https://github.com/dospe/audiobookshelf/pull/7) (2026-09-05) – rclone mount of cloud storage (e.g. Google Drive) available in Audiobookshelf as `/media`, extra bind mounts (`ABS_EXTRA_MOUNTS`) and running the container as a chosen user (`ABS_UID`/`ABS_GID`).
- [#8](https://github.com/dospe/audiobookshelf/pull/8) (2026-09-05) – The response timeout of a custom metadata provider is configurable (`CUSTOM_METADATA_PROVIDER_TIMEOUT`, default 30 s instead of 10 s).
- [#9](https://github.com/dospe/audiobookshelf/pull/9) (2026-09-05) – A directory with several ebooks is scanned as separate books (library setting "Split folders with multiple ebooks into separate books", on by default). Files with the same name without extension stay together as one book, author and series are read from the parent folders. Details and Calibre recommendations in `docs/EBOOKS.md`.
