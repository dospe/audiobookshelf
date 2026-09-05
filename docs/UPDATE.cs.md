# Instalace a aktualizace serveru Audiobookshelf (fork `dospe`)

Tento návod popisuje, jak nainstalovat a průběžně aktualizovat serverovou část
z tohoto forku pomocí Docker Compose a skriptu `scripts/update-server.sh`.
Skript je idempotentní: můžete ho spouštět opakovaně (ručně i z cronu), a když
není co dělat, nic nezmění.

## Co skript dělá

1. Ověří, že je k dispozici `docker`, plugin `docker compose` a `curl`.
2. Založí nasazovací složku (výchozí `/opt/audiobookshelf`) a v ní soubor `.env`
   s výchozí konfigurací. Existující `.env` nikdy nepřepisuje.
3. Založí chybějící datové složky (audioknihy, config, metadata, zálohy).
4. Zapíše `docker-compose.yml`. Soubor je spravovaný skriptem a přepíše se jen
   tehdy, když se jeho obsah liší (např. po změně skriptu). Vlastní úpravy
   dělejte v `.env`, ne v compose souboru.
5. Stáhne image `ghcr.io/dospe/audiobookshelf:<tag>`.
6. Pokud běží kontejner se stejným image, skončí s hláškou „Already up to date“.
7. Pokud je k dispozici nový image (nebo kontejner neběží, nebo byl použit
   `--force`):
   - zastaví server a zazálohuje složku `config` (databáze a nastavení) do
     `config-<datum>.tar.gz` ve složce záloh, starší zálohy nad limit smaže,
   - znovu vytvoří kontejner z nového image,
   - počká, až server odpoví na `/healthcheck` (max. 120 s),
   - odstraní staré nepoužívané image forku.
8. Při selhání vypíše posledních 50 řádků logu a návod na rollback.

Souběžné spuštění hlídá zámek `.update.lock`, druhá instance skončí chybou.

## Požadavky

- Linux s Dockerem 20.10+ a pluginem Docker Compose v2 (`docker compose version`).
- `curl`, `tar`, `flock` (součást `util-linux`, na běžných distribucích je).
- Uživatel, který skript spouští, musí smět používat Docker (skupina `docker`
  nebo `sudo`).
- Síťový přístup na `ghcr.io`. Balíček s image je veřejný, přihlášení k registru není potřeba.

Image se staví automaticky workflow „Build and Push Docker Image“ při každém
pushi do `master`, který mění `client/`, `server/`, `index.js` nebo
`package.json`. Tagy: `latest` a `edge` (master), `vX.Y.Z` (verze).

## Přístup k image a ke skriptu

- **Image** `ghcr.io/dospe/audiobookshelf` je veřejný balíček. `docker pull`,
  `docker manifest inspect` (volba `--check`) i compose fungují bez
  přihlášení; na serveru není potřeba žádný token ani `docker login`.
- **Repozitář** `dospe/audiobookshelf` je soukromý. Týká se to jen stažení
  samotného skriptu `update-server.sh` (a tohoto návodu); vlastní aktualizace
  serveru repozitář nepotřebuje. Skript získáte jedním ze dvou způsobů:
  1. zkopírováním přes `scp` z počítače, kde máte repozitář naklonovaný, nebo
  2. stažením přes `curl` s tokenem GitHubu: Settings → Developer settings →
     Personal access tokens → Tokens (classic) → Generate new token
     s oprávněním `repo`. Token se použije jen jednorázově při stažení,
     na serveru ho ukládat nemusíte.

> Kdyby byl balíček později přepnutý zpět na private, přidejte tokenu
> oprávnění `read:packages` a na serveru se přihlaste stejným uživatelem,
> který skript spouští (u `sudo` a cronu je to root):
> `echo "<token>" | sudo docker login ghcr.io -u dospe --password-stdin`.
> Přihlášení se ukládá do `~/.docker/config.json` a je trvalé.

## První instalace

```bash
# 1. Skript stáhněte ze soukromého repozitáře (token s oprávněním repo),
#    nebo ho na server zkopírujte přes scp z naklonovaného repozitáře
sudo mkdir -p /opt/audiobookshelf
sudo curl -fsSL -H "Authorization: token <token>" \
  https://raw.githubusercontent.com/dospe/audiobookshelf/master/scripts/update-server.sh \
  -o /opt/audiobookshelf/update-server.sh
sudo chmod +x /opt/audiobookshelf/update-server.sh

# 2. První spuštění vytvoří .env s výchozími hodnotami
sudo /opt/audiobookshelf/update-server.sh
```

Varianta přes `scp` (bez tokenu):

```bash
scp scripts/update-server.sh <uživatel>@<server>:/tmp/
sudo install -m 755 /tmp/update-server.sh /opt/audiobookshelf/update-server.sh
```

Skript obsahuje vše potřebné, jiné soubory z repozitáře nepotřebuje.

Skript při prvním běhu jen vytvoří `/opt/audiobookshelf/.env` a skončí, aby
se nic nenainstalovalo s nesprávnými cestami. Otevřete ho a upravte cesty a
port podle svého prostředí:

```dotenv
ABS_IMAGE=ghcr.io/dospe/audiobookshelf
ABS_TAG=latest
ABS_PORT=13378
ABS_AUDIOBOOKS_DIR=/srv/audiobookshelf/audiobooks
ABS_CONFIG_DIR=/srv/audiobookshelf/config
ABS_METADATA_DIR=/srv/audiobookshelf/metadata
ABS_BACKUP_DIR=/srv/audiobookshelf/backups
ABS_BACKUP_KEEP=7
ABS_TZ=Europe/Prague
ABS_PUID=1000
ABS_PGID=1000
```

Poznámky:

- `ABS_AUDIOBOOKS_DIR` nasměrujte na existující knihovnu; do kontejneru se
  připojí jako `/audiobooks`. V nastavení knihovny v Audiobookshelf pak
  používejte cestu `/audiobooks/...`.
- `ABS_PUID`/`ABS_PGID` musí odpovídat uživateli, který má právo číst
  audioknihy a zapisovat do `config` a `metadata` (`id -u`, `id -g`).
- Skript spouštějte vždy stejným uživatelem, aby vytvořené složky a zálohy měly
  konzistentní vlastníka.

Po úpravě `.env` skript spusťte znovu; teď už stáhne image, vytvoří kontejner
a počká na `/healthcheck`:

```bash
sudo /opt/audiobookshelf/update-server.sh
```

Web UI běží na `http://<server>:13378/`.

## Přechod z oficiálního image `advplyr/audiobookshelf`

Data (config, metadata) jsou s forkem kompatibilní, databáze se neměnila.

1. Zastavte a odstraňte původní kontejner (nebo `docker compose down` v původní
   složce). Svazky s daty nemažte.
2. V `.env` nastavte `ABS_CONFIG_DIR`, `ABS_METADATA_DIR` a `ABS_AUDIOBOOKS_DIR`
   na stejné hostitelské cesty, jaké používal původní kontejner, a `ABS_PORT`
   na původní port.
3. Spusťte `update-server.sh`.
4. Po naběhnutí spusťte v Audiobookshelf sken knihovny, aby se soubory
   `.doc`, `.docx`, `.rtf` a `.pdb` zaevidovaly jako e-knihy.

Pokud jste původně používali pojmenované Docker svazky místo složek, nejdřív
jejich obsah zkopírujte do složek (`docker cp` nebo `docker run --rm -v ...`).

## Běžná aktualizace

```bash
sudo /opt/audiobookshelf/update-server.sh
```

Typický výstup, když je vše aktuální:

```
[2026-09-05 06:00:01] Deployment directory: /opt/audiobookshelf
[2026-09-05 06:00:01] Image: ghcr.io/dospe/audiobookshelf:latest
[2026-09-05 06:00:01] Container: running (image 2f1c9a7b3d4e)
[2026-09-05 06:00:01] Pulling ghcr.io/dospe/audiobookshelf:latest
[2026-09-05 06:00:04] Already up to date, nothing to do
```

Když je nová verze:

```
[...] Update needed: new image 8a0b1c2d3e4f (running 2f1c9a7b3d4e)
[...] Backing up /srv/audiobookshelf/config to /srv/audiobookshelf/backups/config-20260905-060004.tar.gz
[...] Starting container
[...] Waiting for http://127.0.0.1:13378/healthcheck
[...] Audiobookshelf is up (container 5b6c7d8e9f01, image 8a0b1c2d3e4f)
[...] Done. Open http://<server>:13378/ and run a library scan if new ebook formats should be picked up.
```

Během aktualizace je server nedostupný zhruba 10 až 60 sekund (záloha +
restart).

### Jen zjistit, jestli je aktualizace

```bash
sudo /opt/audiobookshelf/update-server.sh --check
```

Nic nemění, jen porovná digest image na ghcr s lokálním. Návratový kód:
`0` = aktuální, `2` = je k dispozici aktualizace (nebo není nainstalováno),
`1` = chyba (např. nedostupný registr).

### Volby

| Volba | Význam |
| --- | --- |
| `--check` | Pouze zjistí, zda existuje novější image. |
| `--force` | Znovu vytvoří kontejner i bez nového image (např. po změně `.env`). |
| `--no-backup` | Přeskočí zálohu configu pro tento běh. |
| `--tag TAG` | Nasadí jiný tag a uloží ho do `.env` jako `ABS_TAG`. |
| `--dir DIR` | Jiná nasazovací složka než `/opt/audiobookshelf`. |

Změna portu nebo cest v `.env` se aplikuje při dalším běhu skriptu (compose si
změny sám všimne a kontejner znovu vytvoří).

## Automatická aktualizace

### cron

Denně v 5:00, s logem:

```bash
sudo crontab -e
```

```
0 5 * * * /opt/audiobookshelf/update-server.sh >> /var/log/audiobookshelf-update.log 2>&1
```

Díky idempotenci skript ve dnech bez nové verze jen stáhne manifest a skončí.

### systemd timer

`/etc/systemd/system/audiobookshelf-update.service`:

```ini
[Unit]
Description=Update Audiobookshelf server
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/opt/audiobookshelf/update-server.sh
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
journalctl -u audiobookshelf-update.service   # log posledních běhů
```

## Rollback

### Na předchozí image

Každý image na ghcr má digest. Zjistíte ho ze stránky balíčku na GitHubu nebo
lokálně:

```bash
docker images --digests ghcr.io/dospe/audiobookshelf
```

Nasazení konkrétního digestu:

```bash
sudo /opt/audiobookshelf/update-server.sh --tag "latest@sha256:<digest>"
```

Tag se uloží do `.env`, takže další běhy skriptu zůstanou na této verzi.
Návrat na průběžné aktualizace: `--tag latest`.

Verze označené tagem lze nasadit přímo: `--tag v2.36.0`.

### Obnova databáze ze zálohy

Zálohy configu jsou v `ABS_BACKUP_DIR` jako `config-<datum>.tar.gz`
(obsahují celou složku `config` včetně `absdatabase.sqlite`).

```bash
cd /opt/audiobookshelf
docker compose stop audiobookshelf
mv /srv/audiobookshelf/config /srv/audiobookshelf/config.broken
tar -xzf /srv/audiobookshelf/backups/config-20260905-060004.tar.gz -C /srv/audiobookshelf
docker compose start audiobookshelf
```

Zálohu obnovujte vždy se stejnou nebo starší verzí serveru, než se kterou
vznikla; novější server může databázi migrovat a starší verze ji pak
neotevře.

## Ověření po aktualizaci

- `http://<server>:13378/healthcheck` vrací HTTP 200.
- V UI v Nastavení → O aplikaci (nebo v patičce) je verze `2.36.0` nebo vyšší.
- `docker compose -f /opt/audiobookshelf/docker-compose.yml logs --tail 100`
  neobsahuje chyby při startu.
- Po první aktualizaci na tento fork spusťte sken knihovny; soubory
  `.doc/.docx/.rtf/.pdb` se objeví u knih jako e-knihy s tlačítkem Číst.

## Řešení potíží

| Příznak | Příčina a řešení |
| --- | --- |
| `pull failed` / `denied` / `unauthorized` | Balíček je veřejný, takže nejčastěji jde o výpadek sítě nebo ghcr.io; zkuste znovu. Pokud byl balíček přepnutý na private, přihlaste se podle poznámky v kapitole „Přístup k image a ke skriptu“. |
| `curl: (404)` při stahování skriptu | Repozitář je soukromý; přidejte hlavičku `Authorization: token <token>` (oprávnění `repo`) nebo skript zkopírujte přes `scp`. |
| `cannot talk to the Docker daemon` | Spusťte se `sudo`, nebo přidejte uživatele do skupiny `docker` a znovu se přihlaste. |
| `another update-server.sh is already running` | Běží jiná instance (cron). Počkejte, nebo smažte `.update.lock`, pokud proces prokazatelně neběží. |
| Server nenaběhne do 120 s | Podívejte se do vypsaného logu. Nejčastěji obsazený port (`ABS_PORT`) nebo práva k `config`/`metadata` (`ABS_PUID`/`ABS_PGID`). |
| Knihovna je prázdná po přechodu z oficiálního image | `ABS_CONFIG_DIR` míří jinam než původní config. Zkontrolujte cesty v `.env` a `--force`. |
| Nové formáty se v knihovně neukazují | Spusťte sken knihovny (Nastavení knihovny → Scan). Kontroluje se přípona souboru. |
| `--check` hlásí chybu manifestu | `docker manifest inspect` potřebuje síť; zkontrolujte připojení k ghcr.io. |

## Kde je co

| Cesta | Obsah |
| --- | --- |
| `/opt/audiobookshelf/update-server.sh` | tento skript |
| `/opt/audiobookshelf/.env` | konfigurace nasazení (jediný soubor k ruční editaci) |
| `/opt/audiobookshelf/docker-compose.yml` | generovaný compose soubor |
| `/opt/audiobookshelf/.update.lock` | zámek proti souběhu |
| `ABS_CONFIG_DIR` | databáze a nastavení serveru (zálohovat) |
| `ABS_METADATA_DIR` | obálky, cache, streamy (lze znovu vygenerovat) |
| `ABS_BACKUP_DIR` | zálohy configu z aktualizací |
