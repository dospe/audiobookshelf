# Instalace a aktualizace serveru Audiobookshelf (fork `dospe`) v `/opt/audio`

Tento návod popisuje nasazení a údržbu celého serverového stacku pomocí dvou
skriptů z `scripts/`:

| Skript | K čemu je |
| --- | --- |
| `deploy.sh` | První instalace nebo znovunasazení: založí `/opt/audio`, převezme data ze staré instalace, vytvoří konfiguraci a stack spustí. Umí i vzdálený režim přes SSH. |
| `update-server.sh` | Běžná idempotentní aktualizace: stáhne nové image, zazálohuje config, znovu vytvoří jen změněné kontejnery, ověří health check. Vhodné pro cron. |

Stack tvoří dvě služby v jednom Docker Compose projektu:

| Služba | Image | Port na hostiteli | Poznámka |
| --- | --- | --- | --- |
| `audiobookshelf` | `ghcr.io/dospe/audiobookshelf` (tento fork) | `ABS_PORT`, výchozí 13378 | web UI a API |
| `provider` | `ghcr.io/stecik/audiobookshelf_czech_metadata` | `PROVIDER_PORT`, výchozí 8000 | český metadata provider; ABS ho volá uvnitř compose sítě jako `http://provider:8000` |

Oba image jsou veřejné, na serveru není potřeba žádné přihlášení k registru.

## Rozložení `/opt/audio`

| Cesta | Obsah |
| --- | --- |
| `/opt/audio/.env` | jediný konfigurační soubor obou služeb; vytvoří ho `deploy.sh`, dál se edituje ručně a nikdy se nepřepisuje |
| `/opt/audio/docker-compose.yml` | generovaný skriptem `update-server.sh`, ručně neupravovat |
| `/opt/audio/deploy.sh`, `/opt/audio/update-server.sh` | kopie skriptů, které `deploy.sh` nainstaluje |
| `/opt/audio/config` | databáze a nastavení Audiobookshelf (zálohovat) |
| `/opt/audio/metadata` | obálky, cache, streamy (lze znovu vygenerovat) |
| `/opt/audio/backups` | zálohy configu z aktualizací (`config-<datum>.tar.gz`) |
| `/opt/audio/audiobooks` | knihovna, pokud není v `.env` nastavena jiná cesta (`ABS_AUDIOBOOKS_DIR`) |
| `/opt/audio/.update.lock` | zámek proti souběhu aktualizací |

## Požadavky

- Linux s Dockerem 20.10+ a pluginem Docker Compose v2 (`docker compose version`).
- `curl`, `tar`, `flock` (balík `util-linux`), volitelně `rsync` pro rychlejší migraci dat.
- Root nebo `sudo` (skripty zapisují do `/opt/audio`; `deploy.sh` se sám znovu spustí přes `sudo`).
- Síťový přístup na `ghcr.io`.

Skripty jsou v soukromém repozitáři `dospe/audiobookshelf`, takže je na server
dostanete buď přes `scp` z naklonovaného repozitáře, nebo přes `curl` s classic
tokenem GitHubu s oprávněním `repo` (Settings → Developer settings →
Personal access tokens → Tokens (classic)). Nejjednodušší je vzdálený režim
`deploy.sh --remote`, který oba skripty přenese sám.

## První instalace

### Varianta A: vzdáleně z počítače s naklonovaným repozitářem

```bash
cd audiobookshelf/scripts
./deploy.sh --remote uzivatel@audio.example.cz
```

Skript zkopíruje `deploy.sh` a `update-server.sh` přes `scp`, spustí na serveru
`deploy.sh` (přes `sudo`, pokud nejste root) a po skončení vypíše souhrn.
Všechny volby níže lze předat i ve vzdáleném režimu, například
`./deploy.sh --remote uzivatel@host --audiobooks /mnt/books --port 13378`.

### Varianta B: přímo na serveru

```bash
sudo mkdir -p /opt/audio
# oba skripty zkopírujte do /opt/audio (scp) nebo stáhněte s tokenem:
for f in deploy.sh update-server.sh; do
  sudo curl -fsSL -H "Authorization: token <token>" \
    "https://raw.githubusercontent.com/dospe/audiobookshelf/master/scripts/$f" \
    -o "/opt/audio/$f"
done
sudo chmod +x /opt/audio/*.sh
sudo /opt/audio/deploy.sh
```

### Co `deploy.sh` udělá

1. Ověří `docker`, `docker compose`, `curl` a nainstaluje oba skripty do `/opt/audio`.
2. **Migrace** (jen když `.env` ještě neexistuje a není zadáno `--no-migrate`):
   - najde stávající kontejner `audiobookshelf` (z `docker run` nebo z jiného
     compose projektu), přečte jeho mounty `/audiobooks`, `/config` a
     `/metadata`; cestu ke knihovně převezme do `.env`, obsah `config` a
     `metadata` zkopíruje do `/opt/audio` (z bind mountu i z pojmenovaného
     svazku přes `docker cp`), kontejner zastaví a odstraní (svazky nemaže);
   - bez kontejneru zkusí starou strukturu `/opt/audiobookshelf/{config,metadata}`;
   - najde starý provider z původního `deploy.sh` v `~/abs-czech-metadata`
     (v domovském adresáři uživatele i roota), převezme jeho `.env`
     (`HOST_PORT` → `PROVIDER_PORT`, token, `ENABLE_*` …), starý compose
     projekt zastaví a složku přejmenuje na `abs-czech-metadata.migrated-<datum>`.
3. Vytvoří `/opt/audio/.env` (výchozí hodnoty + zjištěné cesty + importované
   hodnoty provideru). Při dalších bězích `.env` zachová a jen do něj promítne
   volby z příkazové řádky.
4. Spustí `update-server.sh --force`: zapíše compose, stáhne oba image,
   vytvoří kontejnery a počká na `/healthcheck` (ABS) a `/health` (provider).

Kopírování dat probíhá jen do prázdné cílové složky; existující obsah
`/opt/audio/config` se nikdy nepřepíše.

### Volby `deploy.sh`

| Volba | Význam |
| --- | --- |
| `--remote user@host` | Přenese skripty přes SSH a spustí nasazení na serveru. |
| `--dir DIR` | Jiná nasazovací složka než `/opt/audio`. |
| `--audiobooks PATH` | Cesta ke knihovně na hostiteli (jinak z migrace, jinak `DIR/audiobooks`). |
| `--port N` | Port Audiobookshelf (výchozí 13378). |
| `--provider-port N` | Port provideru (výchozí 8000). |
| `--tag TAG`, `--provider-tag TAG` | Tagy image (výchozí `latest`). |
| `--no-provider` | Provider nenasazovat (`PROVIDER_ENABLED=false`). |
| `--no-migrate` | Nehledat starou instalaci. |

### Po instalaci

1. Otevřete `http://<server>:13378/`. Při migraci se přihlásíte původními účty;
   při čisté instalaci projdete průvodcem.
2. Knihovna má uvnitř kontejneru cestu `/audiobooks`; při čisté instalaci ji
   v ABS založte s touto cestou.
3. Provider přidejte v ABS: Nastavení → Metadata Tools → Custom Metadata
   Providers → Add, Media Type `Book`, URL `http://provider:8000`.
   Authorization header vyplňte jen tehdy, když je v `.env` nastaven
   `AUDIOBOOKSHELF_AUTH_TOKEN`. Pro samostatné zdroje lze přidat další
   providery s URL `http://provider:8000/<zdroj>` (např. `/audioteka`).
4. Spusťte sken knihovny, aby se soubory `.doc`, `.docx`, `.rtf` a `.pdb`
   zaevidovaly jako e-knihy.

## Konfigurace `.env`

```dotenv
# --- Audiobookshelf server (fork image) ---
ABS_IMAGE=ghcr.io/dospe/audiobookshelf
ABS_TAG=latest                      # edge, vX.Y.Z, nebo latest@sha256:<digest>
ABS_PORT=13378
ABS_AUDIOBOOKS_DIR=/opt/audio/audiobooks
ABS_CONFIG_DIR=/opt/audio/config
ABS_METADATA_DIR=/opt/audio/metadata
ABS_BACKUP_DIR=/opt/audio/backups
ABS_BACKUP_KEEP=7
ABS_TZ=Europe/Prague
ABS_PUID=1000                       # id -u uživatele s právy ke knihovně
ABS_PGID=1000

# --- Czech metadata provider ---
PROVIDER_ENABLED=true
PROVIDER_IMAGE=ghcr.io/stecik/audiobookshelf_czech_metadata
PROVIDER_TAG=latest
PROVIDER_PORT=8000
LOG_LEVEL=INFO
REQUEST_TIMEOUT_SECONDS=5
SCRAPER_TIMEOUT_SECONDS=5
AUDIOBOOKSHELF_AUTH_TOKEN=
SCRAPER_USER_AGENT=
ENABLE_ALZA=true
# ... ENABLE_<zdroj>=true/false pro každý obchod, ENABLE_DATABAZEKNIH=false
```

Změna hodnot v `.env` se projeví při dalším běhu `update-server.sh`
(compose změnu portů a cest pozná a kontejner znovu vytvoří); pro jistotu
lze spustit `update-server.sh --force`.

## Běžná aktualizace

```bash
sudo /opt/audio/update-server.sh
```

Typický výstup, když je vše aktuální:

```
[...] Deployment directory: /opt/audio
[...] audiobookshelf: image ghcr.io/dospe/audiobookshelf:latest, container running (image 2f1c9a7b3d4e)
[...] provider: image ghcr.io/stecik/audiobookshelf_czech_metadata:latest, container running (image 9c8d7e6f5a4b)
[...] Pulling ghcr.io/dospe/audiobookshelf:latest
[...] Pulling ghcr.io/stecik/audiobookshelf_czech_metadata:latest
[...] Already up to date, nothing to do
```

Když je nová verze Audiobookshelf:

```
[...] audiobookshelf: update needed: new image 8a0b1c2d3e4f (running 2f1c9a7b3d4e)
[...] Backing up /opt/audio/config to /opt/audio/backups/config-20260905-060004.tar.gz
[...] Starting: audiobookshelf
[...] Waiting for http://127.0.0.1:13378/healthcheck
[...] audiobookshelf is up
[...] Done. Audiobookshelf: http://<server>:13378/
```

Znovu se vytvoří jen služba, jejíž image se změnil. Záloha configu se dělá
jen před aktualizací Audiobookshelf (provider nemá žádný stav). Během
aktualizace je daná služba nedostupná zhruba 10 až 60 sekund.

### Volby `update-server.sh`

| Volba | Význam |
| --- | --- |
| `--check` | Jen porovná digesty na ghcr s lokálními; nic nemění. Návratový kód `0` = aktuální, `2` = je aktualizace (nebo není nainstalováno), `1` = chyba. |
| `--service audiobookshelf` / `--service provider` | Aktualizuje jen jednu službu. |
| `--force` | Znovu vytvoří kontejnery i bez nového image (např. po změně `.env`). |
| `--no-backup` | Přeskočí zálohu configu. |
| `--tag TAG` | Tag Audiobookshelf; uloží se do `.env` jako `ABS_TAG`. |
| `--provider-tag TAG` | Tag provideru; uloží se jako `PROVIDER_TAG`. |
| `--dir DIR` | Jiná nasazovací složka. |

## Automatická aktualizace

### cron

```bash
sudo crontab -e
```

```
0 5 * * * /opt/audio/update-server.sh >> /var/log/audiobookshelf-update.log 2>&1
```

### systemd timer

`/etc/systemd/system/audiobookshelf-update.service`:

```ini
[Unit]
Description=Update Audiobookshelf stack
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/opt/audio/update-server.sh
```

`/etc/systemd/system/audiobookshelf-update.timer`:

```ini
[Unit]
Description=Daily Audiobookshelf update

[Timer]
OnCalendar=*-*-* 05:00:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now audiobookshelf-update.timer
journalctl -u audiobookshelf-update.service
```

## Rollback

### Na předchozí image

```bash
docker images --digests ghcr.io/dospe/audiobookshelf
sudo /opt/audio/update-server.sh --tag "latest@sha256:<digest>"
```

Tag se uloží do `.env`, takže další běhy zůstanou na této verzi; návrat na
průběžné aktualizace je `--tag latest`. Pro provider stejně s
`--provider-tag`.

### Obnova databáze ze zálohy

```bash
cd /opt/audio
docker compose stop audiobookshelf
mv /opt/audio/config /opt/audio/config.broken
tar -xzf /opt/audio/backups/config-20260905-060004.tar.gz -C /opt/audio
docker compose start audiobookshelf
```

Zálohu obnovujte se stejnou nebo starší verzí serveru, než se kterou vznikla;
novější server databázi migruje a starší verze ji pak neotevře.

## Ověření

- `http://<server>:13378/healthcheck` vrací HTTP 200; `http://<server>:8000/health` také.
- `docker compose -f /opt/audio/docker-compose.yml ps` ukazuje obě služby jako `healthy`.
- V ABS proběhne vyhledání metadat přes provider (Match u libovolné knihy).
- `docker compose -f /opt/audio/docker-compose.yml logs --tail 100` bez chyb.

## Řešení potíží

| Příznak | Příčina a řešení |
| --- | --- |
| `pull failed` / `denied` / `unauthorized` | Výpadek sítě nebo ghcr.io; zkuste znovu. Pokud by byl některý balíček přepnut na private, přihlaste se `docker login ghcr.io` jako uživatel, který skript spouští (u `sudo` a cronu root), s tokenem `read:packages`. |
| `curl: (404)` při stahování skriptů | Repozitář je soukromý; použijte hlavičku `Authorization: token <token>` (oprávnění `repo`), `scp`, nebo `deploy.sh --remote`. |
| `cannot talk to the Docker daemon` | Docker neběží nebo chybí práva; spusťte se `sudo`. |
| `another update-server.sh is already running` | Běží jiná instance (cron). Počkejte, nebo smažte `.update.lock`, pokud proces prokazatelně neběží. |
| Služba nenaběhne do 120 s | Podívejte se do vypsaného logu. Nejčastěji obsazený port (`ABS_PORT`, `PROVIDER_PORT`) nebo práva k `config`/`metadata` (`ABS_PUID`/`ABS_PGID`). |
| Po migraci je knihovna prázdná | `ABS_CONFIG_DIR` míří jinam než původní config, nebo se kopírovalo do neprázdné složky (skript ji nechal být). Zkontrolujte `.env` a obsah `/opt/audio/config`. |
| ABS nenajde provider | V ABS musí být URL `http://provider:8000` (název služby v compose síti), ne `localhost`. Pokud běží ABS mimo tento compose, použijte `http://<server>:8000`. |
| Provider vrací prázdné výsledky | ABS má limit 10 s na metadata; snižte `REQUEST_TIMEOUT_SECONDS`/`SCRAPER_TIMEOUT_SECONDS` (max. 8) nebo vypněte pomalé zdroje `ENABLE_*=false`. |
| `--check` hlásí chybu manifestu | `docker manifest inspect` potřebuje síť; zkontrolujte připojení k ghcr.io. |
