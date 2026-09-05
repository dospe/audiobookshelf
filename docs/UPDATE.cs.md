# Instalace a aktualizace serveru Audiobookshelf (fork `dospe`) v `/opt/audio`

Tento návod popisuje nasazení a údržbu celého serverového stacku pomocí dvou
skriptů z `scripts/`:

| Skript | K čemu je |
| --- | --- |
| `deploy.sh` | První instalace nebo znovunasazení: založí `/opt/audio`, převezme data ze staré instalace, vytvoří konfiguraci a stack spustí. Umí i vzdálený režim přes SSH. |
| `update-server.sh` | Běžná idempotentní aktualizace: stáhne nové image, zazálohuje config, znovu vytvoří jen změněné kontejnery, ověří health check. Vhodné pro cron. |

Stack tvoří až čtyři služby v jednom Docker Compose projektu:

| Služba | Image | Port na hostiteli | Poznámka |
| --- | --- | --- | --- |
| `audiobookshelf` | `ghcr.io/dospe/audiobookshelf` (tento fork) | `ABS_PORT`, výchozí 13378 | web UI a API |
| `provider` | `ghcr.io/stecik/audiobookshelf_czech_metadata` | `PROVIDER_PORT`, výchozí 8000 | český metadata provider; ABS ho volá uvnitř compose sítě jako `http://provider:8000` |
| `caddy` | `caddy:2` | 80 a 443 (`CADDY_HTTP_PORT`, `CADDY_HTTPS_PORT`) | HTTPS reverzní proxy pro `CADDY_DOMAIN` s automatickým certifikátem Let's Encrypt; nasazuje se jen s nastavenou doménou |
| `rclone` | `rclone/rclone` | žádný | FUSE mount cloudového úložiště (`RCLONE_REMOTE`, např. Google Drive) na `RCLONE_MOUNT_POINT`; Audiobookshelf ho vidí jako `/media`; nasazuje se jen s nastaveným remote |

Všechny image jsou veřejné, na serveru není potřeba žádné přihlášení k registru.

## Rozložení `/opt/audio`

| Cesta | Obsah |
| --- | --- |
| `/opt/audio/.env` | jediný konfigurační soubor všech služeb; vytvoří ho `deploy.sh`, dál se edituje ručně a nikdy se nepřepisuje |
| `/opt/audio/docker-compose.yml` | generovaný skriptem `update-server.sh`, ručně neupravovat |
| `/opt/audio/deploy.sh`, `/opt/audio/update-server.sh` | kopie skriptů, které `deploy.sh` nainstaluje |
| `/opt/audio/config` | databáze a nastavení Audiobookshelf (zálohovat) |
| `/opt/audio/metadata` | obálky, cache, streamy (lze znovu vygenerovat) |
| `/opt/audio/backups` | zálohy configu z aktualizací (`config-<datum>.tar.gz`) |
| `/opt/audio/audiobooks` | knihovna, pokud není v `.env` nastavena jiná cesta (`ABS_AUDIOBOOKS_DIR`) |
| `/opt/audio/caddy/Caddyfile` | konfigurace HTTPS proxy; vznikne při nasazení (převzatá ze staré instalace nebo vygenerovaná z `--domain`), dál se edituje ručně a nepřepisuje se |
| `/opt/audio/caddy/data` | certifikáty a účet Let's Encrypt (zálohovat spolu s configem; při ztrátě si Caddy vyžádá nové) |
| `/opt/audio/caddy/config` | interní stav Caddy |
| `/opt/audio/rclone/config/rclone.conf` | přihlášení k cloudovému remote (vytvoří `rclone config`, při migraci se převezme; zálohovat, obsahuje token) |
| `/opt/audio/rclone/cache` | VFS cache rclone (až `--vfs-cache-max-size`, může obsahovat ještě nenahrané soubory; při migraci se přesouvá, ne kopíruje) |
| `/opt/audio/.update.lock` | zámek proti souběhu aktualizací |

## Požadavky

- Linux s Dockerem 20.10+ a pluginem Docker Compose v2 (`docker compose version`).
- `curl`, `tar`, `flock` (balík `util-linux`), volitelně `rsync` pro rychlejší migraci dat.
- Root nebo `sudo` (skripty zapisují do `/opt/audio`; `deploy.sh` se sám znovu spustí přes `sudo`).
- Síťový přístup na `ghcr.io` a `docker.io` (image Caddy).
- Pro HTTPS: DNS záznam domény míří na server a porty 80 a 443 jsou zvenku dostupné (Let's Encrypt ověřuje přes HTTP na portu 80). Na portech nesmí běžet nic jiného (jiná Caddy, nginx, Apache).
- Pro rclone: jádro s FUSE (`/dev/fuse`), přípojný bod na sdíleném mountu (výchozí systemd má `/` jako `shared`; jinak `mount --make-rshared /`).

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
     projekt zastaví a složku přejmenuje na `abs-czech-metadata.migrated-<datum>`;
   - u starého kontejneru `audiobookshelf` převezme i **ostatní bind mounty**
     (`/media` → `ABS_MEDIA_DIR`, cokoli dalšího → `ABS_EXTRA_MOUNTS` včetně
     `ro` a propagace) a uživatele, pod kterým běžel (`ABS_UID`/`ABS_GID`);
   - najde starý kontejner rclone (název `rclone*` nebo image `rclone/rclone`)
     z jiného compose projektu, z jeho příkazu vyčte remote a volby mountu, ze
     starého `.env` UID/GID uživatele serveru, zkopíruje `rclone.conf`, VFS
     cache **přesune** (může obsahovat nenahrané soubory), kontejner odstraní
     a mount znovu vytvoří v novém stacku. Tento krok proběhne i nad existující
     instalací v `/opt/audio`, která ještě sekci `RCLONE_*` v `.env` nemá;
   - najde starý kontejner Caddy (název `caddy` nebo image `caddy:*`) z
     jiného compose projektu, z jeho Caddyfile vyčte doménu a e-mail pro
     Let's Encrypt, Caddyfile i certifikáty (`/data`, `/config`; z bind mountu
     i z pojmenovaného svazku) zkopíruje do `/opt/audio/caddy`, kontejner
     odstraní, a pokud ve starém compose projektu už žádný kontejner nezbyl,
     přejmenuje jeho složku na `<název>.migrated-<datum>`. Tento krok proběhne
     i nad existující instalací v `/opt/audio`, která ještě sekci `CADDY_*`
     v `.env` nemá.
3. Vytvoří `/opt/audio/.env` (výchozí hodnoty + zjištěné cesty + importované
   hodnoty provideru + doména Caddy + remote rclone + uživatel). Při dalších
   bězích `.env` zachová a jen do něj promítne volby z příkazové řádky.
4. Spustí `update-server.sh --force`: zapíše compose, vytvoří chybějící
   `caddy/Caddyfile`, při nastaveném `ABS_UID` převede vlastnictví `config`
   a `metadata`, stáhne image, vytvoří kontejnery a počká na `/healthcheck`
   (ABS), `/health` (provider) a health checky Caddy a rclone (mount existuje).

Kopírování dat probíhá jen do prázdné cílové složky; existující obsah
`/opt/audio/config`, `/opt/audio/caddy/Caddyfile` ani `/opt/audio/caddy/data`
se nikdy nepřepíše.

### Volby `deploy.sh`

| Volba | Význam |
| --- | --- |
| `--remote user@host` | Přenese skripty přes SSH a spustí nasazení na serveru. |
| `--dir DIR` | Jiná nasazovací složka než `/opt/audio`. |
| `--audiobooks PATH` | Cesta ke knihovně na hostiteli (jinak z migrace, jinak `DIR/audiobooks`). |
| `--port N` | Port Audiobookshelf (výchozí 13378). |
| `--provider-port N` | Port provideru (výchozí 8000). |
| `--domain HOST` | Veřejná doména pro HTTPS (`CADDY_DOMAIN`, zapne `CADDY_ENABLED=true`). Bez ní se doména bere ze starého Caddyfile; když není známa žádná, Caddy se nenasadí. |
| `--email ADRESA` | Kontaktní e-mail pro Let's Encrypt (`CADDY_EMAIL`; jinak ze starého Caddyfile). |
| `--rclone-remote R` | Remote k připojení, např. `gdrive:Audiobookshelf` (`RCLONE_REMOTE`, zapne `RCLONE_ENABLED=true`). Bez něj se bere ze starého kontejneru rclone; když není znám, rclone se nenasadí. |
| `--mount-point PATH` | Přípojný bod na hostiteli (`RCLONE_MOUNT_POINT`, výchozí `/mnt/gdrive` nebo ten starý). |
| `--media-dir PATH` | Složka hostitele viditelná v ABS jako `/media` (`ABS_MEDIA_DIR`; výchozí přípojný bod rclone, nebo `/media` starého kontejneru). |
| `--user UID:GID` | Uživatel, pod kterým ABS poběží (`ABS_UID`/`ABS_GID`; výchozí ze starého kontejneru či starého `.env`, jinak root). |
| `--tag TAG`, `--provider-tag TAG`, `--caddy-tag TAG`, `--rclone-tag TAG` | Tagy image (výchozí `latest`, `latest`, `2`, `latest`). |
| `--no-provider` | Provider nenasazovat (`PROVIDER_ENABLED=false`). |
| `--no-caddy` | Caddy nenasazovat (`CADDY_ENABLED=false`); starý kontejner Caddy se pak jen zastaví. |
| `--no-rclone` | rclone nenasazovat (`RCLONE_ENABLED=false`); starý kontejner rclone zůstane běžet. |
| `--no-migrate` | Nehledat starou instalaci. |

### Po instalaci

1. Otevřete `https://<doména>/` (s Caddy) nebo `http://<server>:13378/`. Při
   migraci se přihlásíte původními účty; při čisté instalaci projdete průvodcem.
2. Knihovna má uvnitř kontejneru cestu `/audiobooks`, cloudové úložiště přes
   rclone cestu `/media` (např. `/media/Audioknihy`, `/media/Eknihy`); při
   čisté instalaci knihovny v ABS založte s těmito cestami. Po migraci
   spusťte sken knihoven, položky označené jako Missing se vrátí.
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
CUSTOM_METADATA_PROVIDER_TIMEOUT=30000   # ms; jak dlouho ABS čeká na odpověď custom provideru

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

# --- Storage and user of the Audiobookshelf container ---
ABS_UID=1001                        # prázdné = root; config a metadata se převedou na tohoto uživatele
ABS_GID=1001
ABS_MEDIA_DIR=/mnt/gdrive           # složka hostitele jako /media (propagace rslave); prázdné = bez mountu
ABS_EXTRA_MOUNTS="/srv/knihy:/mnt/knihy:ro"   # další bind mounty host:kontejner[:ro][:rslave], oddělené mezerou

# --- rclone: FUSE mount cloudového remote ---
RCLONE_ENABLED=true
RCLONE_IMAGE=rclone/rclone
RCLONE_TAG=latest
RCLONE_REMOTE=gdrive:Audiobookshelf # remote:cesta z rclone.conf; prázdné = rclone se nenasadí
RCLONE_MOUNT_POINT=/mnt/gdrive
RCLONE_CONFIG_DIR=/opt/audio/rclone/config
RCLONE_CACHE_DIR=/opt/audio/rclone/cache
RCLONE_MOUNT_ARGS="--allow-other --allow-non-empty --umask 002 --vfs-cache-mode full --vfs-cache-max-size 2G --vfs-cache-max-age 720h --vfs-read-ahead 64M --buffer-size 16M --dir-cache-time 72h --poll-interval 1m --log-level INFO"

# --- Caddy: HTTPS reverse proxy (Let's Encrypt) ---
CADDY_ENABLED=true                  # false = Caddy se nenasadí (kontejner se odstraní jako orphan)
CADDY_DOMAIN=audio.example.cz       # veřejná doména; musí být vyplněna, když je CADDY_ENABLED=true
CADDY_EMAIL=admin@example.cz        # kontakt pro Let's Encrypt (nepovinné)
CADDY_IMAGE=caddy
CADDY_TAG=2
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443
```

Změna hodnot v `.env` se projeví při dalším běhu `update-server.sh`
(compose změnu portů a cest pozná a kontejner znovu vytvoří); pro jistotu
lze spustit `update-server.sh --force`.

## Úložiště přes rclone

Služba `rclone` připojí `RCLONE_REMOTE` přes FUSE na `RCLONE_MOUNT_POINT`
(uvnitř kontejneru `/data` s propagací `shared`). Audiobookshelf má tentýž
adresář jako `/media` s propagací `rslave`, takže mount zůstane vidět i po
restartu rclone. Kontejner běží s `/dev/fuse`, `SYS_ADMIN` a vypnutým
AppArmor profilem, jak FUSE v Dockeru vyžaduje.

Nový remote (bez migrace) vytvoříte interaktivně:

```bash
sudo docker run --rm -it -v /opt/audio/rclone/config:/config/rclone rclone/rclone config
```

Pro Google Drive: `n` → název `gdrive` → typ `drive` → vlastní `client_id` a
`client_secret` (doporučeno, jinak sdílíte kvótu API) → scope `1` → „Use web
browser“ **No** → příkaz `rclone authorize` spusťte na počítači s prohlížečem
a token vložte zpět. Pak do `.env` zapište `RCLONE_REMOTE=gdrive:<složka>`
a `RCLONE_ENABLED=true` a spusťte `update-server.sh --force`.

Volby mountu jsou v `RCLONE_MOUNT_ARGS` (remote, přípojný bod a `--cache-dir`
doplní skript). Cache `--vfs-cache-mode full` drží až `--vfs-cache-max-size`
v `/opt/audio/rclone/cache`; soubory nahrané přes ABS se do cloudu odesílají
na pozadí, proto se cache při migraci přesouvá a nikdy nemaže.

V knihovnách nad `/media` v ABS zapněte **Disable folder watcher** (inotify na
FUSE nefunguje) a **naplánovaný sken** (např. `0 4 * * *`); změny na Drive se
v mountu projeví do `--poll-interval`.

## HTTPS přes Caddy

Caddy běží jako služba `caddy` ve stejném compose projektu, takže
Audiobookshelf oslovuje uvnitř sítě jako `audiobookshelf:80`. Certifikát pro
`CADDY_DOMAIN` si vyžádá sama při prvním startu (HTTP-01 na portu 80) a
obnovuje ho automaticky; certifikáty a účet Let's Encrypt jsou v
`/opt/audio/caddy/data`, proto se při migraci kopírují a nevydávají se znovu.

Výchozí `/opt/audio/caddy/Caddyfile`:

```caddyfile
{
	email admin@example.cz
}

audio.example.cz {
	encode zstd gzip
	reverse_proxy audiobookshelf:80
}
```

Caddyfile je váš: skripty ho vytvoří jen tehdy, když neexistuje. Po ruční
úpravě ho načtěte bez výpadku:

```bash
docker exec audiobookshelf-caddy caddy reload --config /etc/caddy/Caddyfile
```

Změna `CADDY_DOMAIN` v `.env` Caddyfile nemění; doménu upravte v obou
souborech (`.env` slouží skriptům pro výpis a kontrolu). Chcete-li provider
zpřístupnit i zvenku přes HTTPS, přidejte do bloku domény například:

```caddyfile
	handle_path /provider/* {
		reverse_proxy provider:8000
	}
```

V ABS ale nadále používejte interní URL `http://provider:8000`.

Stávající instalace v `/opt/audio` bez Caddy se doplní znovu spuštěním
`deploy.sh` (najde starý kontejner `caddy` a převezme ho) nebo
`deploy.sh --domain <doména> --email <adresa>` (čistá konfigurace).

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
| `--service audiobookshelf` / `--service provider` / `--service caddy` / `--service rclone` | Aktualizuje jen jednu službu. |
| `--force` | Znovu vytvoří kontejnery i bez nového image (např. po změně `.env`). |
| `--no-backup` | Přeskočí zálohu configu. |
| `--tag TAG` | Tag Audiobookshelf; uloží se do `.env` jako `ABS_TAG`. |
| `--provider-tag TAG` | Tag provideru; uloží se jako `PROVIDER_TAG`. |
| `--caddy-tag TAG` | Tag Caddy (výchozí `2`); uloží se jako `CADDY_TAG`. |
| `--rclone-tag TAG` | Tag rclone (výchozí `latest`); uloží se jako `RCLONE_TAG`. |
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
- `https://<doména>/healthcheck` vrací HTTP 200 s platným certifikátem
  (`curl -sSI https://<doména>/healthcheck`); `docker logs audiobookshelf-caddy`
  bez chyb `obtaining certificate`.
- `docker compose -f /opt/audio/docker-compose.yml ps` ukazuje všechny služby jako `healthy`.
- `mount | grep rclone` ukazuje `RCLONE_REMOTE` na `RCLONE_MOUNT_POINT`; `docker exec audiobookshelf ls /media` vypíše složky knihoven.
- V ABS proběhne vyhledání metadat přes provider (Match u libovolné knihy).
- `docker compose -f /opt/audio/docker-compose.yml logs --tail 100` bez chyb.

## Řešení potíží

| Příznak | Příčina a řešení |
| --- | --- |
| `pull failed` / `denied` / `unauthorized` | Výpadek sítě nebo ghcr.io; zkuste znovu. Pokud by byl některý balíček přepnut na private, přihlaste se `docker login ghcr.io` jako uživatel, který skript spouští (u `sudo` a cronu root), s tokenem `read:packages`. |
| `curl: (404)` při stahování skriptů | Repozitář je soukromý; použijte hlavičku `Authorization: token <token>` (oprávnění `repo`), `scp`, nebo `deploy.sh --remote`. |
| `cannot talk to the Docker daemon` | Docker neběží nebo chybí práva; spusťte se `sudo`. |
| `another update-server.sh is already running` | Běží jiná instance (cron). Počkejte, nebo smažte `.update.lock`, pokud proces prokazatelně neběží. |
| Služba nenaběhne do 120 s | Podívejte se do vypsaného logu. Nejčastěji obsazený port (`ABS_PORT`, `PROVIDER_PORT`) nebo práva k `config`/`metadata` (`ABS_UID`/`ABS_GID`). |
| Po migraci je knihovna prázdná | `ABS_CONFIG_DIR` míří jinam než původní config, nebo se kopírovalo do neprázdné složky (skript ji nechal být). Zkontrolujte `.env` a obsah `/opt/audio/config`. |
| Sken hlásí `Invalid folder path does not exist "/media/..."`, položky Missing | Kontejner nevidí složku knihovny: chybí `ABS_MEDIA_DIR`/`ABS_EXTRA_MOUNTS` v `.env`, nebo rclone neběží (`docker logs audiobookshelf-rclone`). Doplňte `.env`, spusťte `update-server.sh --force` a pak sken knihovny; Missing položky se vrátí, „Remove missing“ nepoužívejte. |
| rclone: `path /mnt/gdrive is mounted on / but it is not a shared mount` | Přípojný bod musí ležet na sdíleném mountu: `sudo mount --make-rshared /` (trvale přes systemd unit nebo `/etc/fstab`) a `update-server.sh --service rclone --force`. |
| rclone: `Transport endpoint is not connected` / `looks like a stale FUSE mount` | Zůstal odpojený mount: `sudo umount -l /mnt/gdrive` a spusťte skript znovu. |
| `rclone.conf does not exist` | Vytvořte remote příkazem v sekci Úložiště přes rclone, nebo nastavte `RCLONE_ENABLED=false`. |
| ABS nenajde provider | V ABS musí být URL `http://provider:8000` (název služby v compose síti), ne `localhost`. Pokud běží ABS mimo tento compose, použijte `http://<server>:8000`. |
| Provider vrací prázdné výsledky | V logu ABS je `[CustomMetadataProvider] Search error timeout of Xms exceeded`: provider nestihl odpovědět. Zvyšte `CUSTOM_METADATA_PROVIDER_TIMEOUT` (ms, výchozí 30000), případně snižte `REQUEST_TIMEOUT_SECONDS`/`SCRAPER_TIMEOUT_SECONDS` nebo vypněte pomalé zdroje `ENABLE_*=false`. Timeout providerů musí zůstat pod hodnotou `CUSTOM_METADATA_PROVIDER_TIMEOUT`. |
| `--check` hlásí chybu manifestu | `docker manifest inspect` potřebuje síť; zkontrolujte připojení k ghcr.io. |
| Caddy nenaběhne, v logu `bind: address already in use` | Na portu 80/443 běží něco jiného (stará Caddy z jiného compose projektu, nginx). Zastavte to (`docker ps`, `ss -ltnp`) a spusťte `update-server.sh --service caddy --force`. |
| HTTPS vrací 502 nebo `dial tcp: lookup audiobookshelf` | Caddy neběží ve stejné compose síti jako ABS. Tak to dopadne, když zůstala stará Caddy z původní instalace: převezměte ji znovu spuštěním `deploy.sh`, nebo dočasně `docker network connect audio_default <starý kontejner>`. |
| V logu Caddy `obtaining certificate ... failed` | DNS domény nemíří na server, port 80 není zvenku dostupný, nebo `CADDY_DOMAIN` v Caddyfile neodpovídá. Caddy zkouší znovu sama; při opakovaných chybách pozor na limity Let's Encrypt (5 vydání týdně na doménu). |
| `CADDY_ENABLED=true but CADDY_DOMAIN is empty` | Doplňte `CADDY_DOMAIN` v `.env` (a doménu v `caddy/Caddyfile`), nebo nastavte `CADDY_ENABLED=false`. |
