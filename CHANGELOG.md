# Changelog forku dospe/audiobookshelf

Fork [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf) provozovaný jako stack v `/opt/audio` (viz [docs/UPDATE.cs.md](docs/UPDATE.cs.md)). Verze má tvar `<verze upstreamu>-dospe.<pořadí>`: první část říká, na jakém upstreamu fork stojí, přípona se zvyšuje s každou změnou forku. Docker image `ghcr.io/dospe/audiobookshelf` se publikuje s tagy `latest`, `edge` a touto verzí.

## 2.36.0-dospe.1 – 2026-09-05

Základ: upstream v2.36.0.

### Přidáno

- Verzování forku (`2.36.0-dospe.N`) v `package.json` serveru i klienta; verze je vidět v UI vlevo dole a ve výpisu serveru při startu, takže je jasné, který build běží.
- Docker image se při buildu z `master` taguje i verzí (`ghcr.io/dospe/audiobookshelf:2.36.0-dospe.1`), aby se dala v `.env` připnout přes `ABS_TAG`.
- Tento `CHANGELOG.md` a sekce o forku v `readme.md`.

### Opraveno

- Kontrola aktualizací a changelog v UI porovnávají s vydáními upstreamu podle základní verze (`2.36.0`), takže s příponou forku dál fungují.

## Dřívější změny forku (bez vlastní verze, image `latest` ze 4.–5. 9. 2026)

Založeno na upstream v2.36.0. Pořadí podle sloučení do `master`.

- [#1](https://github.com/dospe/audiobookshelf/pull/1) (2026-09-04) – Soubory `doc`, `docx`, `rtf` a `pdb` se berou jako e-knihy; webový reader je umí zobrazit a pamatuje si nastavení zobrazení a kódování textu pro každou knihu zvlášť.
- [#2](https://github.com/dospe/audiobookshelf/pull/2) (2026-09-04) – Docker image se sestavuje a publikuje z forku na `ghcr.io/dospe/audiobookshelf` (tagy `latest` a `edge`) při každém push do `master`.
- [#3](https://github.com/dospe/audiobookshelf/pull/3) (2026-09-05) – Idempotentní skript `scripts/update-server.sh` (stažení image, záloha configu, obnova jen změněných kontejnerů, health check) a česká příručka `docs/UPDATE.cs.md`.
- [#4](https://github.com/dospe/audiobookshelf/pull/4) (2026-09-05) – Příručka: balíček na ghcr je veřejný, soukromý je jen repozitář.
- [#5](https://github.com/dospe/audiobookshelf/pull/5) (2026-09-05) – `scripts/deploy.sh`: nasazení celého stacku v `/opt/audio` včetně českého metadata provideru (`ghcr.io/stecik/audiobookshelf_czech_metadata`) a převzetí dat ze starší instalace.
- [#6](https://github.com/dospe/audiobookshelf/pull/6) (2026-09-05) – Caddy jako HTTPS reverzní proxy s automatickým certifikátem Let's Encrypt.
- [#7](https://github.com/dospe/audiobookshelf/pull/7) (2026-09-05) – rclone mount cloudového úložiště (např. Google Drive) dostupný v Audiobookshelf jako `/media`, další bind mounty (`ABS_EXTRA_MOUNTS`) a běh kontejneru pod zvoleným uživatelem (`ABS_UID`/`ABS_GID`).
- [#8](https://github.com/dospe/audiobookshelf/pull/8) (2026-09-05) – Timeout odpovědi vlastního metadata provideru je nastavitelný (`CUSTOM_METADATA_PROVIDER_TIMEOUT`, výchozí 30 s místo 10 s).
- [#9](https://github.com/dospe/audiobookshelf/pull/9) (2026-09-05) – Adresář s více e-knihami se skenuje jako samostatné knihy (nastavení knihovny „Rozdělit složky s více e-knihami na samostatné knihy“, výchozí zapnuto). Soubory se stejným názvem bez přípony drží pohromadě jako jedna kniha, autor a série se čtou z nadřazených složek. Podrobnosti a doporučení ke Calibre v `docs/EBOOKS.cs.md`.
