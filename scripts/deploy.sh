#!/usr/bin/env bash
#
# Install (or re-deploy) the Audiobookshelf stack in /opt/audio:
#   - audiobookshelf  (ghcr.io/dospe/audiobookshelf, this fork)
#   - provider        (ghcr.io/stecik/audiobookshelf_czech_metadata, Czech metadata provider)
#   - caddy           (caddy:2, HTTPS reverse proxy with automatic Let's Encrypt certificates)
#
# What it does (idempotent, safe to re-run):
#   1. creates /opt/audio and installs deploy.sh + update-server.sh into it
#   2. on the first run migrates an existing installation: an old
#      "audiobookshelf" container (or /opt/audiobookshelf/{config,metadata}),
#      an old provider deployment (~/abs-czech-metadata/.env) and an old
#      "caddy" container (Caddyfile + certificates) are taken over, their
#      data copied into /opt/audio and the old containers removed
#   3. creates /opt/audio/.env (never overwritten later; edit it by hand)
#      and /opt/audio/caddy/Caddyfile (migrated, or generated from --domain)
#   4. runs update-server.sh --force: writes docker-compose.yml, pulls the
#      images, starts the containers and waits for their health checks
#
# Usage:
#   deploy.sh [options]
#   deploy.sh --remote user@host [options]   # copy both scripts over SSH and run there
#
# Options:
#   --dir DIR             Deployment directory (default: /opt/audio)
#   --audiobooks PATH     Host directory with the audiobook library (default: detected
#                         from the old container, else DIR/audiobooks)
#   --port N              Audiobookshelf host port (default: 13378)
#   --provider-port N     Provider host port (default: 8000)
#   --domain HOST         Public host name served over HTTPS by Caddy (default: taken
#                         from the old Caddyfile; without a domain Caddy is not deployed)
#   --email ADDRESS       Contact e-mail for Let's Encrypt (default: from the old Caddyfile)
#   --tag TAG             Audiobookshelf image tag (default: latest)
#   --provider-tag TAG    Provider image tag (default: latest)
#   --caddy-tag TAG       Caddy image tag (default: 2)
#   --no-provider         Do not deploy the metadata provider
#   --no-caddy            Do not deploy Caddy (CADDY_ENABLED=false)
#   --no-migrate          Do not look for / take over an old installation
#   -h, --help            Show this help
#
# Needs root (it re-runs itself with sudo when necessary).

set -euo pipefail

SCRIPT_PATH="$(readlink -f "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

REMOTE=""
ABS_DIR="/opt/audio"
AUDIOBOOKS_OVERRIDE=""
PORT_OVERRIDE=""
PROVIDER_PORT_OVERRIDE=""
DOMAIN_OVERRIDE=""
EMAIL_OVERRIDE=""
TAG_OVERRIDE=""
PROVIDER_TAG_OVERRIDE=""
CADDY_TAG_OVERRIDE=""
PROVIDER_ENABLED="true"
CADDY_DISABLED=0
MIGRATE=1
ARGS=("$@")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) [[ $# -ge 2 ]] || die "--remote needs user@host"; REMOTE="$2"; shift ;;
    --remote=*) REMOTE="${1#--remote=}" ;;
    --dir) [[ $# -ge 2 ]] || die "--dir needs a value"; ABS_DIR="$2"; shift ;;
    --dir=*) ABS_DIR="${1#--dir=}" ;;
    --audiobooks) [[ $# -ge 2 ]] || die "--audiobooks needs a value"; AUDIOBOOKS_OVERRIDE="$2"; shift ;;
    --audiobooks=*) AUDIOBOOKS_OVERRIDE="${1#--audiobooks=}" ;;
    --port) [[ $# -ge 2 ]] || die "--port needs a value"; PORT_OVERRIDE="$2"; shift ;;
    --port=*) PORT_OVERRIDE="${1#--port=}" ;;
    --provider-port) [[ $# -ge 2 ]] || die "--provider-port needs a value"; PROVIDER_PORT_OVERRIDE="$2"; shift ;;
    --provider-port=*) PROVIDER_PORT_OVERRIDE="${1#--provider-port=}" ;;
    --tag) [[ $# -ge 2 ]] || die "--tag needs a value"; TAG_OVERRIDE="$2"; shift ;;
    --tag=*) TAG_OVERRIDE="${1#--tag=}" ;;
    --provider-tag) [[ $# -ge 2 ]] || die "--provider-tag needs a value"; PROVIDER_TAG_OVERRIDE="$2"; shift ;;
    --provider-tag=*) PROVIDER_TAG_OVERRIDE="${1#--provider-tag=}" ;;
    --caddy-tag) [[ $# -ge 2 ]] || die "--caddy-tag needs a value"; CADDY_TAG_OVERRIDE="$2"; shift ;;
    --caddy-tag=*) CADDY_TAG_OVERRIDE="${1#--caddy-tag=}" ;;
    --domain) [[ $# -ge 2 ]] || die "--domain needs a value"; DOMAIN_OVERRIDE="$2"; shift ;;
    --domain=*) DOMAIN_OVERRIDE="${1#--domain=}" ;;
    --email) [[ $# -ge 2 ]] || die "--email needs a value"; EMAIL_OVERRIDE="$2"; shift ;;
    --email=*) EMAIL_OVERRIDE="${1#--email=}" ;;
    --no-provider) PROVIDER_ENABLED="false" ;;
    --no-caddy) CADDY_DISABLED=1 ;;
    --no-migrate) MIGRATE=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

for v in "$TAG_OVERRIDE" "$PROVIDER_TAG_OVERRIDE" "$CADDY_TAG_OVERRIDE"; do
  [[ -z "$v" || "$v" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "invalid tag: $v"
done
for v in "$PORT_OVERRIDE" "$PROVIDER_PORT_OVERRIDE"; do
  [[ -z "$v" || "$v" =~ ^[0-9]+$ ]] || die "invalid port: $v"
done
[[ -z "$DOMAIN_OVERRIDE" || "$DOMAIN_OVERRIDE" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid domain: $DOMAIN_OVERRIDE"
[[ -z "$EMAIL_OVERRIDE" || "$EMAIL_OVERRIDE" =~ ^[^[:space:]]+@[^[:space:]]+$ ]] || die "invalid e-mail: $EMAIL_OVERRIDE"

# ---------------------------------------------------------------------------
# Remote mode: copy both scripts to the host and run deploy there
# ---------------------------------------------------------------------------
if [[ -n "$REMOTE" ]]; then
  [[ -f "$SCRIPT_DIR/update-server.sh" ]] || die "update-server.sh must be next to deploy.sh for --remote"
  REMOTE_ARGS=()
  skip=0
  for a in "${ARGS[@]}"; do
    if [[ $skip -eq 1 ]]; then skip=0; continue; fi
    case "$a" in
      --remote) skip=1 ;;
      --remote=*) ;;
      *) REMOTE_ARGS+=("$a") ;;
    esac
  done
  STAMP="$(date +%s)"
  log "Copying scripts to $REMOTE"
  scp -q "$SCRIPT_PATH" "$REMOTE:/tmp/deploy-$STAMP.sh"
  scp -q "$SCRIPT_DIR/update-server.sh" "$REMOTE:/tmp/update-server-$STAMP.sh"
  log "Running deploy on $REMOTE"
  # shellcheck disable=SC2029
  ssh -t "$REMOTE" "set -e; d=/tmp/deploy-$STAMP; mkdir -p \$d && mv /tmp/deploy-$STAMP.sh \$d/deploy.sh && mv /tmp/update-server-$STAMP.sh \$d/update-server.sh && chmod +x \$d/*.sh; if [ \"\$(id -u)\" -eq 0 ]; then \$d/deploy.sh $(printf '%q ' "${REMOTE_ARGS[@]}"); else sudo \$d/deploy.sh $(printf '%q ' "${REMOTE_ARGS[@]}"); fi; rm -rf \$d"
  exit $?
fi

# ---------------------------------------------------------------------------
# Local mode
# ---------------------------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "run as root (sudo is not available)"
  log "Re-running with sudo"
  exec sudo -E "$SCRIPT_PATH" "${ARGS[@]}"
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed (https://docs.docker.com/compose/install/)"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running?)"
command -v curl >/dev/null 2>&1 || die "curl is required"

ENV_FILE="$ABS_DIR/.env"
mkdir -p "$ABS_DIR"

# Install the scripts into the deployment directory so cron and later updates use them
for f in deploy.sh update-server.sh; do
  src="$SCRIPT_DIR/$f"
  dst="$ABS_DIR/$f"
  [[ -f "$src" ]] || die "$src not found (deploy.sh and update-server.sh must be in the same directory)"
  if [[ "$(readlink -f "$src")" != "$(readlink -f "$dst")" ]]; then
    install -m 755 "$src" "$dst"
    log "Installed $dst"
  fi
done

# ---------------------------------------------------------------------------
# Migration of an existing installation (first run only)
# ---------------------------------------------------------------------------
DETECTED_AUDIOBOOKS=""
DETECTED_CONFIG_SRC=""
DETECTED_METADATA_SRC=""
OLD_CONTAINER=""
OLD_PROVIDER_DIR=""
OLD_CADDY=""
OLD_CADDY_PROJECT_DIR=""
OLD_CADDYFILE_SRC=""
OLD_CADDY_DATA_SRC=""
OLD_CADDY_CONFIG_SRC=""
DETECTED_DOMAIN=""
DETECTED_EMAIL=""
PROVIDER_IMPORT=()

home_dirs() {
  echo "$HOME"
  [[ -n "${SUDO_USER:-}" ]] && getent passwd "$SUDO_USER" | cut -d: -f6
  echo /root
}

mount_source() {
  # $1 container, $2 destination inside the container -> "bind:/path" or "volume:name" or ""
  docker inspect --format '{{range .Mounts}}{{.Destination}} {{.Type}} {{if eq .Type "bind"}}{{.Source}}{{else}}{{.Name}}{{end}}{{"\n"}}{{end}}' "$1" 2>/dev/null |
    awk -v d="$2" '$1 == d { print $2 ":" $3; exit }'
}

copy_tree() {
  # $1 source dir, $2 target dir (only when the target is empty)
  if [[ -d "$2" ]] && [[ -n "$(ls -A "$2" 2>/dev/null)" ]]; then
    log "Keeping existing $2 (not empty), skipping copy from $1"
    return 0
  fi
  mkdir -p "$2"
  log "Copying $1 -> $2"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$1/" "$2/"
  else
    cp -a "$1/." "$2/"
  fi
}

if [[ $MIGRATE -eq 1 && ! -f "$ENV_FILE" ]]; then
  # 1. an old Audiobookshelf container not managed by this stack
  cid="$(docker ps -aq --filter 'name=^audiobookshelf$' || true)"
  if [[ -n "$cid" ]]; then
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null || true)"
    if [[ "$project" != "$(basename "$ABS_DIR")" ]]; then
      OLD_CONTAINER="$cid"
      log "Found an existing audiobookshelf container (${cid:0:12}, compose project '${project:-none}')"
      for dest in /audiobooks /config /metadata; do
        m="$(mount_source "$cid" "$dest")"
        [[ -n "$m" ]] || continue
        kind="${m%%:*}"; src="${m#*:}"
        log "  $dest is a $kind mount: $src"
        case "$dest" in
          /audiobooks) [[ "$kind" == "bind" ]] && DETECTED_AUDIOBOOKS="$src" ;;
          /config) DETECTED_CONFIG_SRC="$m" ;;
          /metadata) DETECTED_METADATA_SRC="$m" ;;
        esac
      done
    fi
  fi
  # 2. an old bind-mount layout without a container
  if [[ -z "$OLD_CONTAINER" && -d /opt/audiobookshelf/config && "$ABS_DIR" != "/opt/audiobookshelf" ]]; then
    log "Found /opt/audiobookshelf/config from an older installation"
    DETECTED_CONFIG_SRC="bind:/opt/audiobookshelf/config"
    [[ -d /opt/audiobookshelf/metadata ]] && DETECTED_METADATA_SRC="bind:/opt/audiobookshelf/metadata"
  fi
  # 3. the old provider deployment (deploy.sh v1: ~/abs-czech-metadata)
  while read -r h; do
    [[ -n "$h" && -f "$h/abs-czech-metadata/.env" ]] || continue
    OLD_PROVIDER_DIR="$h/abs-czech-metadata"
    break
  done < <(home_dirs)
  if [[ -n "$OLD_PROVIDER_DIR" ]]; then
    log "Found the old provider deployment in $OLD_PROVIDER_DIR, importing its .env"
    while IFS='=' read -r k v; do
      [[ "$k" =~ ^[A-Z_]+$ ]] || continue
      case "$k" in
        HOST_PORT) PROVIDER_IMPORT+=("PROVIDER_PORT=$v") ;;
        APP_HOST|APP_PORT) ;;
        *) PROVIDER_IMPORT+=("$k=$v") ;;
      esac
    done <"$OLD_PROVIDER_DIR/.env"
  fi
fi

# 4. an old Caddy container (also when .env already exists but Caddy was never configured in it)
caddyfile_domain() { grep -m1 -oE '^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?[[:space:]]*\{' "$1" 2>/dev/null | sed -E 's/[[:space:]]*\{$//; s/:[0-9]+$//' || true; }
caddyfile_email() { grep -m1 -oE '^[[:space:]]*email[[:space:]]+[^[:space:]]+' "$1" 2>/dev/null | awk '{print $2}' || true; }

if [[ $MIGRATE -eq 1 && $CADDY_DISABLED -eq 0 ]] && ! { [[ -f "$ENV_FILE" ]] && grep -q '^CADDY_ENABLED=' "$ENV_FILE"; }; then
  while read -r cid cname cimage; do
    [[ -n "$cid" ]] || continue
    [[ "$cname" == "caddy" || "$cimage" =~ ^(docker\.io/)?(library/)?caddy(:|@|$) ]] || continue
    project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null || true)"
    [[ "$project" != "$(basename "$ABS_DIR")" ]] || continue
    OLD_CADDY="$cid"
    OLD_CADDY_PROJECT_DIR="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid" 2>/dev/null || true)"
    log "Found an existing Caddy container '$cname' (${cid:0:12}, compose project '${project:-none}')"
    OLD_CADDYFILE_SRC="$(mount_source "$cid" /etc/caddy/Caddyfile)"
    OLD_CADDY_DATA_SRC="$(mount_source "$cid" /data)"
    OLD_CADDY_CONFIG_SRC="$(mount_source "$cid" /config)"
    for m in "/etc/caddy/Caddyfile $OLD_CADDYFILE_SRC" "/data $OLD_CADDY_DATA_SRC" "/config $OLD_CADDY_CONFIG_SRC"; do
      [[ "$m" == *" " ]] || log "  ${m%% *} is a ${m#* }"
    done
    tmp_caddyfile="$(mktemp)"
    if [[ "${OLD_CADDYFILE_SRC%%:*}" == "bind" && -f "${OLD_CADDYFILE_SRC#*:}" ]]; then
      cp "${OLD_CADDYFILE_SRC#*:}" "$tmp_caddyfile"
    else
      docker cp "$cid:/etc/caddy/Caddyfile" "$tmp_caddyfile" >/dev/null 2>&1 || true
    fi
    DETECTED_DOMAIN="$(caddyfile_domain "$tmp_caddyfile")"
    DETECTED_EMAIL="$(caddyfile_email "$tmp_caddyfile")"
    rm -f "$tmp_caddyfile"
    [[ -n "$DETECTED_DOMAIN" ]] && log "  Caddyfile serves $DETECTED_DOMAIN${DETECTED_EMAIL:+ (ACME e-mail $DETECTED_EMAIL)}"
    break
  done < <(docker ps -a --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null || true)
fi

# ---------------------------------------------------------------------------
# Configuration (.env is created once and never overwritten)
# ---------------------------------------------------------------------------
CADDY_DOMAIN_NEW="${DOMAIN_OVERRIDE:-$DETECTED_DOMAIN}"
CADDY_EMAIL_NEW="${EMAIL_OVERRIDE:-$DETECTED_EMAIL}"
CADDY_ENABLED_NEW="false"
[[ $CADDY_DISABLED -eq 0 && -n "$CADDY_DOMAIN_NEW" ]] && CADDY_ENABLED_NEW="true"

caddy_env_block() {
  cat <<EOF

# --- Caddy: HTTPS reverse proxy (Let's Encrypt) ---
# Set CADDY_DOMAIN to the public host name (DNS must point to this server, ports 80 and 443
# must be reachable) and CADDY_ENABLED=true; the site config is in caddy/Caddyfile.
CADDY_ENABLED=${CADDY_ENABLED_NEW}
CADDY_DOMAIN=${CADDY_DOMAIN_NEW}
CADDY_EMAIL=${CADDY_EMAIL_NEW}
CADDY_IMAGE=caddy
CADDY_TAG=${CADDY_TAG_OVERRIDE:-2}
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443
EOF
}

if [[ ! -f "$ENV_FILE" ]]; then
  AUDIOBOOKS="${AUDIOBOOKS_OVERRIDE:-${DETECTED_AUDIOBOOKS:-$ABS_DIR/audiobooks}}"
  ABS_PORT="${PORT_OVERRIDE:-13378}"
  PROVIDER_PORT="${PROVIDER_PORT_OVERRIDE:-8000}"
  {
    cat <<EOF
# Audiobookshelf stack configuration (read by deploy.sh, update-server.sh and docker compose)
# Created by deploy.sh on $(date '+%Y-%m-%d'); edit by hand, it is never overwritten.

# --- Audiobookshelf server (fork image) ---
ABS_IMAGE=ghcr.io/dospe/audiobookshelf
# latest (master), edge, vX.Y.Z, or latest@sha256:<digest> for a pinned rollback
ABS_TAG=${TAG_OVERRIDE:-latest}
ABS_PORT=${ABS_PORT}
ABS_AUDIOBOOKS_DIR=${AUDIOBOOKS}
ABS_CONFIG_DIR=${ABS_DIR}/config
ABS_METADATA_DIR=${ABS_DIR}/metadata
ABS_BACKUP_DIR=${ABS_DIR}/backups
ABS_BACKUP_KEEP=7
ABS_TZ=Europe/Prague
# User/group the server runs as (must read the audiobooks and write config/metadata)
ABS_PUID=1000
ABS_PGID=1000

# --- Czech metadata provider ---
PROVIDER_ENABLED=${PROVIDER_ENABLED}
PROVIDER_IMAGE=ghcr.io/stecik/audiobookshelf_czech_metadata
PROVIDER_TAG=${PROVIDER_TAG_OVERRIDE:-latest}
PROVIDER_PORT=${PROVIDER_PORT}
LOG_LEVEL=INFO
REQUEST_TIMEOUT_SECONDS=5
SCRAPER_TIMEOUT_SECONDS=5
# If set, Audiobookshelf must send the same value in the Authorization header of the provider
AUDIOBOOKSHELF_AUTH_TOKEN=
SCRAPER_USER_AGENT=
ENABLE_ALZA=true
ENABLE_ALBATROSMEDIA=true
ENABLE_AUDIOLIBRIX=true
ENABLE_AUDIOTEKA=true
ENABLE_DATABAZEKNIH=false
ENABLE_KANOPA=true
ENABLE_KNIHYDOBROVSKY=true
ENABLE_KOSMAS=true
ENABLE_LUXOR=true
ENABLE_MEGAKNIHY=true
ENABLE_NAPOSLECH=true
ENABLE_ONEHOTBOOK=true
ENABLE_O2KNIHOVNA=true
ENABLE_PALMKNIHY=true
ENABLE_PROGRESGURU=true
ENABLE_RADIOTEKA=true
ENABLE_ROZHLAS=true
EOF
    caddy_env_block
  } >"$ENV_FILE"
  # Values imported from the old provider .env override the defaults above
  for kv in "${PROVIDER_IMPORT[@]}"; do
    k="${kv%%=*}"; v="${kv#*=}"
    [[ "$k" == "PROVIDER_PORT" && -n "$PROVIDER_PORT_OVERRIDE" ]] && continue
    if grep -q "^${k}=" "$ENV_FILE"; then
      sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
    else
      printf '%s=%s\n' "$k" "$v" >>"$ENV_FILE"
    fi
  done
  chmod 600 "$ENV_FILE"
  log "Created $ENV_FILE"
else
  log "Using existing $ENV_FILE"
  set_env_value() {
    if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"; fi
  }
  [[ -n "$AUDIOBOOKS_OVERRIDE" ]] && set_env_value ABS_AUDIOBOOKS_DIR "$AUDIOBOOKS_OVERRIDE"
  [[ -n "$PORT_OVERRIDE" ]] && set_env_value ABS_PORT "$PORT_OVERRIDE"
  [[ -n "$PROVIDER_PORT_OVERRIDE" ]] && set_env_value PROVIDER_PORT "$PROVIDER_PORT_OVERRIDE"
  [[ -n "$TAG_OVERRIDE" ]] && set_env_value ABS_TAG "$TAG_OVERRIDE"
  [[ -n "$PROVIDER_TAG_OVERRIDE" ]] && set_env_value PROVIDER_TAG "$PROVIDER_TAG_OVERRIDE"
  [[ "$PROVIDER_ENABLED" == "false" ]] && set_env_value PROVIDER_ENABLED false
  if ! grep -q '^CADDY_ENABLED=' "$ENV_FILE"; then
    # Installed before Caddy support existed: add the section (enabled only when a domain is known)
    caddy_env_block >>"$ENV_FILE"
    log "Added the Caddy section to $ENV_FILE (CADDY_ENABLED=$CADDY_ENABLED_NEW${CADDY_DOMAIN_NEW:+, domain $CADDY_DOMAIN_NEW})"
  else
    [[ -n "$DOMAIN_OVERRIDE" ]] && set_env_value CADDY_DOMAIN "$DOMAIN_OVERRIDE" && set_env_value CADDY_ENABLED true
    [[ -n "$EMAIL_OVERRIDE" ]] && set_env_value CADDY_EMAIL "$EMAIL_OVERRIDE"
    [[ -n "$CADDY_TAG_OVERRIDE" ]] && set_env_value CADDY_TAG "$CADDY_TAG_OVERRIDE"
    [[ $CADDY_DISABLED -eq 1 ]] && set_env_value CADDY_ENABLED false
  fi
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
ABS_CONFIG_DIR="${ABS_CONFIG_DIR:-$ABS_DIR/config}"
ABS_METADATA_DIR="${ABS_METADATA_DIR:-$ABS_DIR/metadata}"
ABS_AUDIOBOOKS_DIR="${ABS_AUDIOBOOKS_DIR:-$ABS_DIR/audiobooks}"
mkdir -p "$ABS_CONFIG_DIR" "$ABS_METADATA_DIR" "$ABS_AUDIOBOOKS_DIR" "${ABS_BACKUP_DIR:-$ABS_DIR/backups}"

# ---------------------------------------------------------------------------
# Take over the data of the old installation and remove the old containers
# ---------------------------------------------------------------------------
migrate_mount() {
  # $1 "bind:/path" | "volume:name", $2 target dir, $3 container path (for volumes)
  local kind="${1%%:*}" src="${1#*:}"
  if [[ "$kind" == "bind" ]]; then
    [[ "$(readlink -f "$src")" == "$(readlink -f "$2")" ]] && return 0
    [[ -d "$src" ]] || return 0
    copy_tree "$src" "$2"
  else
    if [[ -d "$2" ]] && [[ -n "$(ls -A "$2" 2>/dev/null)" ]]; then
      log "Keeping existing $2 (not empty), skipping copy from volume $src"
      return 0
    fi
    log "Copying volume $src ($3) -> $2"
    docker cp "$OLD_CONTAINER:$3/." "$2/"
  fi
}

if [[ -n "$OLD_CONTAINER" || -n "$DETECTED_CONFIG_SRC" ]]; then
  if [[ -n "$OLD_CONTAINER" ]]; then
    log "Stopping the old audiobookshelf container"
    docker stop "$OLD_CONTAINER" >/dev/null || true
  fi
  [[ -n "$DETECTED_CONFIG_SRC" ]] && migrate_mount "$DETECTED_CONFIG_SRC" "$ABS_CONFIG_DIR" /config
  [[ -n "$DETECTED_METADATA_SRC" ]] && migrate_mount "$DETECTED_METADATA_SRC" "$ABS_METADATA_DIR" /metadata
  if [[ -n "$OLD_CONTAINER" ]]; then
    log "Removing the old audiobookshelf container (its data is now in $ABS_DIR; volumes are not deleted)"
    docker rm -f "$OLD_CONTAINER" >/dev/null
  fi
fi

if [[ -n "$OLD_PROVIDER_DIR" && -f "$OLD_PROVIDER_DIR/docker-compose.yml" ]]; then
  log "Stopping the old provider deployment in $OLD_PROVIDER_DIR"
  docker compose --project-directory "$OLD_PROVIDER_DIR" -f "$OLD_PROVIDER_DIR/docker-compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  mv "$OLD_PROVIDER_DIR" "$OLD_PROVIDER_DIR.migrated-$(date +%Y%m%d)" 2>/dev/null || true
fi

if [[ -n "$OLD_CADDY" ]]; then
  CADDY_DIR="$ABS_DIR/caddy"
  mkdir -p "$CADDY_DIR/data" "$CADDY_DIR/config"
  log "Stopping the old Caddy container"
  docker stop "$OLD_CADDY" >/dev/null 2>&1 || true
  if [[ -f "$CADDY_DIR/Caddyfile" ]]; then
    log "Keeping existing $CADDY_DIR/Caddyfile"
  elif [[ "${OLD_CADDYFILE_SRC%%:*}" == "bind" && -f "${OLD_CADDYFILE_SRC#*:}" ]]; then
    log "Copying ${OLD_CADDYFILE_SRC#*:} -> $CADDY_DIR/Caddyfile"
    cp "${OLD_CADDYFILE_SRC#*:}" "$CADDY_DIR/Caddyfile"
  elif docker cp "$OLD_CADDY:/etc/caddy/Caddyfile" "$CADDY_DIR/Caddyfile" >/dev/null 2>&1; then
    log "Copied the Caddyfile from the old container -> $CADDY_DIR/Caddyfile"
  fi
  # Certificates and ACME account (/data) - reusing them avoids new Let's Encrypt issuances
  OLD_CONTAINER_SAVE="$OLD_CONTAINER"; OLD_CONTAINER="$OLD_CADDY"
  [[ -n "$OLD_CADDY_DATA_SRC" ]] && migrate_mount "$OLD_CADDY_DATA_SRC" "$CADDY_DIR/data" /data
  [[ -n "$OLD_CADDY_CONFIG_SRC" ]] && migrate_mount "$OLD_CADDY_CONFIG_SRC" "$CADDY_DIR/config" /config
  OLD_CONTAINER="$OLD_CONTAINER_SAVE"
  if [[ "${CADDY_ENABLED:-false}" == "true" ]]; then
    log "Removing the old Caddy container (its Caddyfile and certificates are now in $CADDY_DIR)"
    docker rm -f "$OLD_CADDY" >/dev/null
    if [[ -n "$OLD_CADDY_PROJECT_DIR" && -d "$OLD_CADDY_PROJECT_DIR" && "$OLD_CADDY_PROJECT_DIR" != "$ABS_DIR" ]]; then
      proj_name="$(basename "$OLD_CADDY_PROJECT_DIR")"
      if [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$proj_name" 2>/dev/null)" ]]; then
        log "The old compose project in $OLD_CADDY_PROJECT_DIR has no containers left, renaming it to $(basename "$OLD_CADDY_PROJECT_DIR").migrated-$(date +%Y%m%d)"
        mv "$OLD_CADDY_PROJECT_DIR" "$OLD_CADDY_PROJECT_DIR.migrated-$(date +%Y%m%d)" 2>/dev/null || true
      else
        log "Other containers of the old compose project in $OLD_CADDY_PROJECT_DIR still exist, leaving the directory alone"
      fi
    fi
  else
    log "Caddy stays disabled (no domain known); the old container was only stopped. Re-run with --domain <host> to take it over."
  fi
fi

# ---------------------------------------------------------------------------
# Pull, start, verify
# ---------------------------------------------------------------------------
log "Starting the stack (update-server.sh --force)"
"$ABS_DIR/update-server.sh" --dir "$ABS_DIR" --force --no-backup

cat <<EOF

Deployment finished.
  Directory:      $ABS_DIR
  Configuration:  $ENV_FILE
  Audiobookshelf: http://<server>:${ABS_PORT:-13378}/   (library path inside the container: /audiobooks)
EOF
if [[ "${CADDY_ENABLED:-false}" == "true" ]]; then
  cat <<EOF
  HTTPS:          https://${CADDY_DOMAIN}/   (Caddy; site config $ABS_DIR/caddy/Caddyfile, certificates $ABS_DIR/caddy/data)
                  DNS for ${CADDY_DOMAIN} must point here and ports ${CADDY_HTTP_PORT:-80}/${CADDY_HTTPS_PORT:-443} must be open;
                  the first certificate is issued within about a minute: docker logs audiobookshelf-caddy
EOF
else
  cat <<EOF
  HTTPS:          not configured. Re-run with --domain <host> [--email <address>] to add Caddy.
EOF
fi
if [[ "${PROVIDER_ENABLED:-true}" == "true" ]]; then
  cat <<EOF
  Provider:       http://<server>:${PROVIDER_PORT:-8000}/health
                  In Audiobookshelf: Settings -> Metadata Tools -> Custom Metadata Providers -> Add,
                  URL http://provider:8000 (Authorization header only if AUDIOBOOKSHELF_AUTH_TOKEN is set)
EOF
fi
cat <<EOF
  Update later:   $ABS_DIR/update-server.sh   (or --check to only look for updates)
EOF
