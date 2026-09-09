# Changelog of the dospe/audiobookshelf fork

Fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf) run as a Docker stack in `/opt/audio` (see [docs/UPDATE.md](docs/UPDATE.md)). Versions have the form `<upstream version>-dospe.<n>`: the first part says which upstream release the fork is based on, the suffix grows with every fork change. The Docker image `ghcr.io/dospe/audiobookshelf` is published with the tags `latest`, `edge` and this version.

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
