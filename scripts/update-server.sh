#!/usr/bin/env bash
#
# Idempotent update script for the Audiobookshelf stack in /opt/audio:
#   - audiobookshelf  (ghcr.io/dospe/audiobookshelf, this fork)
#   - provider        (ghcr.io/stecik/audiobookshelf_czech_metadata, Czech metadata provider)
#
# Running it repeatedly is safe: it only creates what is missing, rewrites the
# compose file only when its content changed, backs up the Audiobookshelf
# config directory only when Audiobookshelf is actually going to be updated,
# and recreates a container only when its image changed (or --force is given).
#
# Usage:
#   update-server.sh [--check] [--force] [--no-backup] [--service NAME]
#                    [--tag TAG] [--provider-tag TAG] [--dir DIR]
#
# Options:
#   --check           Only report whether newer images are available, change nothing
#   --force           Recreate the containers even when the images did not change
#   --no-backup       Skip the config backup for this run
#   --service NAME    Limit the update to one service: audiobookshelf, provider (default: all)
#   --tag TAG         Audiobookshelf image tag (default: latest; e.g. edge, v2.36.0,
#                     or latest@sha256:<digest> for a pinned rollback), saved to .env
#   --provider-tag T  Provider image tag (default: latest), saved to .env
#   --dir DIR         Deployment directory (default: $ABS_DIR or /opt/audio)
#   -h, --help        Show this help
#
# Configuration lives in DIR/.env (created by deploy.sh; see docs/UPDATE.cs.md).
#
# Exit codes: 0 ok / up to date, 1 error, 2 update available (only with --check)

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
CHECK_ONLY=0
FORCE=0
DO_BACKUP=1
SERVICE_FILTER="all"
TAG_OVERRIDE=""
PROVIDER_TAG_OVERRIDE=""
DIR_OVERRIDE=""

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    --service) [[ $# -ge 2 ]] || die "--service needs a value"; SERVICE_FILTER="$2"; shift ;;
    --service=*) SERVICE_FILTER="${1#--service=}" ;;
    --tag) [[ $# -ge 2 ]] || die "--tag needs a value"; TAG_OVERRIDE="$2"; shift ;;
    --tag=*) TAG_OVERRIDE="${1#--tag=}" ;;
    --provider-tag) [[ $# -ge 2 ]] || die "--provider-tag needs a value"; PROVIDER_TAG_OVERRIDE="$2"; shift ;;
    --provider-tag=*) PROVIDER_TAG_OVERRIDE="${1#--provider-tag=}" ;;
    --dir) [[ $# -ge 2 ]] || die "--dir needs a value"; DIR_OVERRIDE="$2"; shift ;;
    --dir=*) DIR_OVERRIDE="${1#--dir=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

case "$SERVICE_FILTER" in
  all|audiobookshelf|provider) ;;
  *) die "--service must be audiobookshelf, provider or all" ;;
esac

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed (https://docs.docker.com/compose/install/)"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? do you need sudo or the docker group?)"
command -v curl >/dev/null 2>&1 || die "curl is required for the health checks"

ABS_DIR="${DIR_OVERRIDE:-${ABS_DIR:-/opt/audio}}"
ENV_FILE="$ABS_DIR/.env"
COMPOSE_FILE="$ABS_DIR/docker-compose.yml"
LOCK_FILE="$ABS_DIR/.update.lock"

[[ -d "$ABS_DIR" ]] || die "$ABS_DIR does not exist; run deploy.sh first"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE does not exist; run deploy.sh first"

# One update at a time
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another $SCRIPT_NAME is already running (lock: $LOCK_FILE)"
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ABS_IMAGE="${ABS_IMAGE:-ghcr.io/dospe/audiobookshelf}"
ABS_TAG="${TAG_OVERRIDE:-${ABS_TAG:-latest}}"
ABS_PORT="${ABS_PORT:-13378}"
ABS_AUDIOBOOKS_DIR="${ABS_AUDIOBOOKS_DIR:-$ABS_DIR/audiobooks}"
ABS_CONFIG_DIR="${ABS_CONFIG_DIR:-$ABS_DIR/config}"
ABS_METADATA_DIR="${ABS_METADATA_DIR:-$ABS_DIR/metadata}"
ABS_BACKUP_DIR="${ABS_BACKUP_DIR:-$ABS_DIR/backups}"
ABS_BACKUP_KEEP="${ABS_BACKUP_KEEP:-7}"
ABS_TZ="${ABS_TZ:-Europe/Prague}"
ABS_PUID="${ABS_PUID:-1000}"
ABS_PGID="${ABS_PGID:-1000}"
PROVIDER_IMAGE="${PROVIDER_IMAGE:-ghcr.io/stecik/audiobookshelf_czech_metadata}"
PROVIDER_TAG="${PROVIDER_TAG_OVERRIDE:-${PROVIDER_TAG:-latest}}"
PROVIDER_PORT="${PROVIDER_PORT:-8000}"
PROVIDER_ENABLED="${PROVIDER_ENABLED:-true}"

ABS_REF="${ABS_IMAGE}:${ABS_TAG}"
PROVIDER_REF="${PROVIDER_IMAGE}:${PROVIDER_TAG}"

# Persist tag overrides so later runs keep deploying them
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
if [[ $CHECK_ONLY -eq 0 ]]; then
  [[ -n "$TAG_OVERRIDE" ]] && set_env_value ABS_TAG "$TAG_OVERRIDE"
  [[ -n "$PROVIDER_TAG_OVERRIDE" ]] && set_env_value PROVIDER_TAG "$PROVIDER_TAG_OVERRIDE"
fi

for d in "$ABS_AUDIOBOOKS_DIR" "$ABS_CONFIG_DIR" "$ABS_METADATA_DIR" "$ABS_BACKUP_DIR"; do
  [[ -d "$d" ]] || { log "Creating directory $d"; mkdir -p "$d"; }
done

SERVICES=(audiobookshelf)
[[ "$PROVIDER_ENABLED" == "true" ]] && SERVICES+=(provider)
if [[ "$SERVICE_FILTER" != "all" ]]; then
  if [[ "$SERVICE_FILTER" == "provider" && "$PROVIDER_ENABLED" != "true" ]]; then
    die "the provider is disabled in $ENV_FILE (PROVIDER_ENABLED=false)"
  fi
  SERVICES=("$SERVICE_FILTER")
fi

# ---------------------------------------------------------------------------
# Compose file (managed by this script; rewritten only when content changed)
# ---------------------------------------------------------------------------
build_compose() {
  cat <<'EOF'
# Managed by update-server.sh - edit .env instead of this file.
services:
  audiobookshelf:
    image: ${ABS_IMAGE}:${ABS_TAG}
    container_name: audiobookshelf
    restart: unless-stopped
    ports:
      - "${ABS_PORT}:80"
    volumes:
      - ${ABS_AUDIOBOOKS_DIR}:/audiobooks
      - ${ABS_CONFIG_DIR}:/config
      - ${ABS_METADATA_DIR}:/metadata
    environment:
      - TZ=${ABS_TZ}
      - PUID=${ABS_PUID}
      - PGID=${ABS_PGID}
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:80/healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
EOF
  if [[ "$PROVIDER_ENABLED" == "true" ]]; then
    cat <<'EOF'

  # Czech metadata provider; in Audiobookshelf use the URL http://provider:8000
  provider:
    image: ${PROVIDER_IMAGE}:${PROVIDER_TAG}
    container_name: audiobookshelf-provider
    restart: unless-stopped
    ports:
      - "${PROVIDER_PORT}:8000"
    environment:
      - APP_HOST=0.0.0.0
      - APP_PORT=8000
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - REQUEST_TIMEOUT_SECONDS=${REQUEST_TIMEOUT_SECONDS:-5}
      - SCRAPER_TIMEOUT_SECONDS=${SCRAPER_TIMEOUT_SECONDS:-5}
      - AUDIOBOOKSHELF_AUTH_TOKEN=${AUDIOBOOKSHELF_AUTH_TOKEN:-}
      - SCRAPER_USER_AGENT=${SCRAPER_USER_AGENT:-}
      - ENABLE_ALZA=${ENABLE_ALZA:-true}
      - ENABLE_ALBATROSMEDIA=${ENABLE_ALBATROSMEDIA:-true}
      - ENABLE_AUDIOLIBRIX=${ENABLE_AUDIOLIBRIX:-true}
      - ENABLE_AUDIOTEKA=${ENABLE_AUDIOTEKA:-true}
      - ENABLE_DATABAZEKNIH=${ENABLE_DATABAZEKNIH:-false}
      - ENABLE_KANOPA=${ENABLE_KANOPA:-true}
      - ENABLE_KNIHYDOBROVSKY=${ENABLE_KNIHYDOBROVSKY:-true}
      - ENABLE_KOSMAS=${ENABLE_KOSMAS:-true}
      - ENABLE_LUXOR=${ENABLE_LUXOR:-true}
      - ENABLE_MEGAKNIHY=${ENABLE_MEGAKNIHY:-true}
      - ENABLE_NAPOSLECH=${ENABLE_NAPOSLECH:-true}
      - ENABLE_ONEHOTBOOK=${ENABLE_ONEHOTBOOK:-true}
      - ENABLE_O2KNIHOVNA=${ENABLE_O2KNIHOVNA:-true}
      - ENABLE_PALMKNIHY=${ENABLE_PALMKNIHY:-true}
      - ENABLE_PROGRESGURU=${ENABLE_PROGRESGURU:-true}
      - ENABLE_RADIOTEKA=${ENABLE_RADIOTEKA:-true}
      - ENABLE_ROZHLAS=${ENABLE_ROZHLAS:-true}
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
EOF
  fi
}

COMPOSE_CONTENT="$(build_compose)"
if [[ ! -f "$COMPOSE_FILE" ]] || ! diff -q <(printf '%s\n' "$COMPOSE_CONTENT") "$COMPOSE_FILE" >/dev/null; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    log "Compose file $COMPOSE_FILE is missing or outdated (would be written)"
  else
    log "Writing $COMPOSE_FILE"
    printf '%s\n' "$COMPOSE_CONTENT" >"$COMPOSE_FILE"
  fi
fi

compose() { docker compose --project-directory "$ABS_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
image_digest() { docker image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null | grep -o 'sha256:[0-9a-f]*' || true; }
remote_digest() { docker manifest inspect "$1" 2>/dev/null | grep -m1 -o '"digest": *"sha256:[0-9a-f]*"' | grep -o 'sha256:[0-9a-f]*' || true; }

container_name() { [[ "$1" == "provider" ]] && echo "audiobookshelf-provider" || echo "audiobookshelf"; }
service_ref() { [[ "$1" == "provider" ]] && echo "$PROVIDER_REF" || echo "$ABS_REF"; }
service_health_url() { [[ "$1" == "provider" ]] && echo "http://127.0.0.1:${PROVIDER_PORT}/health" || echo "http://127.0.0.1:${ABS_PORT}/healthcheck"; }

container_id_of() { docker ps -aq --filter "name=^$(container_name "$1")$" || true; }
container_state_of() {
  local id; id="$(container_id_of "$1")"
  [[ -n "$id" ]] && docker inspect --format '{{.State.Status}}' "$id" || echo "absent"
}
container_image_of() {
  local id; id="$(container_id_of "$1")"
  [[ -n "$id" ]] && docker inspect --format '{{.Image}}' "$id" || true
}

wait_healthy() {
  local url="$1" name="$2"
  log "Waiting for $url"
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then
      log "$name is up"
      return 0
    fi
    sleep 2
  done
  return 1
}

log "Deployment directory: $ABS_DIR"
for svc in "${SERVICES[@]}"; do
  img="$(container_image_of "$svc")"
  log "$svc: image $(service_ref "$svc"), container $(container_state_of "$svc")${img:+ (image ${img:7:12})}"
done

# ---------------------------------------------------------------------------
# --check: compare remote manifests with what is running, change nothing
# ---------------------------------------------------------------------------
if [[ $CHECK_ONLY -eq 1 ]]; then
  UPDATES=0
  for svc in "${SERVICES[@]}"; do
    ref="$(service_ref "$svc")"
    remote="$(remote_digest "$ref")"
    [[ -n "$remote" ]] || die "cannot read the remote manifest of $ref (no network, or the package is private: docker login ghcr.io)"
    local_digest="$(image_digest "$ref")"
    if [[ -z "$(container_id_of "$svc")" || -z "$local_digest" ]]; then
      log "$svc: not installed yet"
      UPDATES=1
    elif [[ "$remote" != "$local_digest" || "$(container_image_of "$svc")" != "$(image_id "$ref")" ]]; then
      log "$svc: update available (remote ${remote:7:12}, local ${local_digest:7:12})"
      UPDATES=1
    else
      log "$svc: up to date"
    fi
  done
  [[ $UPDATES -eq 1 ]] && exit 2
  exit 0
fi

# ---------------------------------------------------------------------------
# Pull and decide per service
# ---------------------------------------------------------------------------
declare -A NEEDS
declare -A REASON
for svc in "${SERVICES[@]}"; do
  ref="$(service_ref "$svc")"
  log "Pulling $ref"
  if ! compose pull --quiet "$svc" 2>/dev/null; then
    compose pull "$svc" || die "pull of $ref failed (network? private package? run: docker login ghcr.io)"
  fi
  new_id="$(image_id "$ref")"
  [[ -n "$new_id" ]] || die "image $ref is not available after pull"
  running_id="$(container_image_of "$svc")"
  state="$(container_state_of "$svc")"
  NEEDS[$svc]=0
  if [[ "$state" == "absent" ]]; then
    NEEDS[$svc]=1; REASON[$svc]="container does not exist"
  elif [[ "$running_id" != "$new_id" ]]; then
    NEEDS[$svc]=1; REASON[$svc]="new image ${new_id:7:12} (running ${running_id:7:12})"
  elif [[ "$state" != "running" ]]; then
    NEEDS[$svc]=1; REASON[$svc]="container is $state"
  elif [[ $FORCE -eq 1 ]]; then
    NEEDS[$svc]=1; REASON[$svc]="--force"
  fi
done

ANY=0
for svc in "${SERVICES[@]}"; do [[ "${NEEDS[$svc]}" -eq 1 ]] && ANY=1; done

if [[ $ANY -eq 0 ]]; then
  # `up -d` still applies compose/env changes (port, volumes); it is a no-op otherwise
  compose up -d --remove-orphans "${SERVICES[@]}" >/dev/null
  log "Already up to date, nothing to do"
  exit 0
fi

for svc in "${SERVICES[@]}"; do
  [[ "${NEEDS[$svc]}" -eq 1 ]] && log "$svc: update needed: ${REASON[$svc]}"
done

# ---------------------------------------------------------------------------
# Backup of the Audiobookshelf config (database, settings) before changing it
# ---------------------------------------------------------------------------
if [[ $DO_BACKUP -eq 1 && "${NEEDS[audiobookshelf]:-0}" -eq 1 && -n "$(container_id_of audiobookshelf)" ]]; then
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  BACKUP_FILE="$ABS_BACKUP_DIR/config-${STAMP}.tar.gz"
  log "Backing up $ABS_CONFIG_DIR to $BACKUP_FILE"
  # Stop the server first so the SQLite database is consistent
  compose stop audiobookshelf >/dev/null
  tar -czf "$BACKUP_FILE" -C "$(dirname "$ABS_CONFIG_DIR")" "$(basename "$ABS_CONFIG_DIR")"
  if [[ "$ABS_BACKUP_KEEP" =~ ^[0-9]+$ ]] && [[ "$ABS_BACKUP_KEEP" -gt 0 ]]; then
    find "$ABS_BACKUP_DIR" -maxdepth 1 -name 'config-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n +$((ABS_BACKUP_KEEP + 1)) | cut -d' ' -f2- | while read -r old; do
      log "Removing old backup $old"
      rm -f "$old"
    done
  fi
fi

# ---------------------------------------------------------------------------
# Recreate what changed and verify
# ---------------------------------------------------------------------------
RECREATE=()
for svc in "${SERVICES[@]}"; do [[ "${NEEDS[$svc]}" -eq 1 ]] && RECREATE+=("$svc"); done
log "Starting: ${RECREATE[*]}"
compose up -d --remove-orphans --force-recreate "${RECREATE[@]}"

FAILED=0
for svc in "${RECREATE[@]}"; do
  if ! wait_healthy "$(service_health_url "$svc")" "$svc"; then
    log "ERROR: $svc did not become healthy within 120 s. Recent logs:" >&2
    compose logs --tail 50 "$svc" >&2 || true
    FAILED=1
  fi
done

if [[ $FAILED -eq 1 ]]; then
  log "To roll back: $SCRIPT_NAME --tag <previous tag or latest@sha256:<digest>> (or --provider-tag); config backups are in $ABS_BACKUP_DIR" >&2
  exit 1
fi

docker image prune -f >/dev/null 2>&1 || true
log "Done. Audiobookshelf: http://<server>:${ABS_PORT}/"
[[ "$PROVIDER_ENABLED" == "true" ]] && log "Metadata provider: http://<server>:${PROVIDER_PORT}/ (in Audiobookshelf use http://provider:8000)"
exit 0
