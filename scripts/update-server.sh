#!/usr/bin/env bash
#
# Idempotent install/update script for an Audiobookshelf server running from
# the fork image ghcr.io/dospe/audiobookshelf with Docker Compose.
#
# Running it repeatedly is safe: it only creates what is missing, only
# rewrites the compose file when its content changed, backs up the config
# directory only when an update is actually going to be applied, and only
# recreates the container when a new image was pulled (or --force is given).
#
# Usage:
#   scripts/update-server.sh [--check] [--force] [--no-backup] [--tag TAG] [--dir DIR]
#
# Options:
#   --check       Only report whether a newer image is available, change nothing
#   --force       Recreate the container even when the image did not change
#   --no-backup   Skip the config backup for this run
#   --tag TAG     Image tag to deploy (default: latest; e.g. edge, v2.36.0,
#                 or latest@sha256:<digest> for a pinned rollback)
#   --dir DIR     Deployment directory (default: $ABS_DIR or /opt/audiobookshelf)
#   -h, --help    Show this help
#
# Configuration lives in DIR/.env (created with defaults on the first run):
#   ABS_IMAGE, ABS_TAG, ABS_PORT, ABS_AUDIOBOOKS_DIR, ABS_CONFIG_DIR,
#   ABS_METADATA_DIR, ABS_BACKUP_DIR, ABS_BACKUP_KEEP, ABS_TZ, ABS_PUID, ABS_PGID
#
# Exit codes: 0 ok / up to date, 1 error, 2 update available (only with --check)

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
CHECK_ONLY=0
FORCE=0
DO_BACKUP=1
TAG_OVERRIDE=""
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
    --tag) [[ $# -ge 2 ]] || die "--tag needs a value"; TAG_OVERRIDE="$2"; shift ;;
    --tag=*) TAG_OVERRIDE="${1#--tag=}" ;;
    --dir) [[ $# -ge 2 ]] || die "--dir needs a value"; DIR_OVERRIDE="$2"; shift ;;
    --dir=*) DIR_OVERRIDE="${1#--dir=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed (https://docs.docker.com/compose/install/)"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? do you need sudo or the docker group?)"
command -v curl >/dev/null 2>&1 || die "curl is required for the health check"

ABS_DIR="${DIR_OVERRIDE:-${ABS_DIR:-/opt/audiobookshelf}}"
ENV_FILE="$ABS_DIR/.env"
COMPOSE_FILE="$ABS_DIR/docker-compose.yml"
LOCK_FILE="$ABS_DIR/.update.lock"

mkdir -p "$ABS_DIR"

# One update at a time
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  die "another $SCRIPT_NAME is already running (lock: $LOCK_FILE)"
fi

# ---------------------------------------------------------------------------
# Configuration (.env is created once with defaults and never overwritten)
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating default configuration $ENV_FILE"
  cat >"$ENV_FILE" <<'EOF'
# Audiobookshelf deployment configuration (read by update-server.sh and docker compose)
# Image built from the fork, see .github/workflows/docker-build.yml
ABS_IMAGE=ghcr.io/dospe/audiobookshelf
# Tag to deploy: latest (master), edge, a version tag, or latest@sha256:<digest> for a pinned rollback
ABS_TAG=latest
# Host port the web UI listens on
ABS_PORT=13378
# Host directories (created when missing)
ABS_AUDIOBOOKS_DIR=/srv/audiobookshelf/audiobooks
ABS_CONFIG_DIR=/srv/audiobookshelf/config
ABS_METADATA_DIR=/srv/audiobookshelf/metadata
# Config backups made before each update
ABS_BACKUP_DIR=/srv/audiobookshelf/backups
ABS_BACKUP_KEEP=7
# Timezone inside the container
ABS_TZ=Europe/Prague
# User/group the server runs as (must be able to read the audiobooks and write config/metadata)
ABS_PUID=1000
ABS_PGID=1000
EOF
  log "Edit $ENV_FILE so the paths, port and user match your setup, then run $SCRIPT_NAME again to install."
  exit 0
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ABS_IMAGE="${ABS_IMAGE:-ghcr.io/dospe/audiobookshelf}"
ABS_TAG="${TAG_OVERRIDE:-${ABS_TAG:-latest}}"
ABS_PORT="${ABS_PORT:-13378}"
ABS_AUDIOBOOKS_DIR="${ABS_AUDIOBOOKS_DIR:-/srv/audiobookshelf/audiobooks}"
ABS_CONFIG_DIR="${ABS_CONFIG_DIR:-/srv/audiobookshelf/config}"
ABS_METADATA_DIR="${ABS_METADATA_DIR:-/srv/audiobookshelf/metadata}"
ABS_BACKUP_DIR="${ABS_BACKUP_DIR:-/srv/audiobookshelf/backups}"
ABS_BACKUP_KEEP="${ABS_BACKUP_KEEP:-7}"
ABS_TZ="${ABS_TZ:-Europe/Prague}"
ABS_PUID="${ABS_PUID:-1000}"
ABS_PGID="${ABS_PGID:-1000}"

IMAGE_REF="${ABS_IMAGE}:${ABS_TAG}"

# Persist a --tag override so later runs without --tag keep deploying it
if [[ -n "$TAG_OVERRIDE" && $CHECK_ONLY -eq 0 ]]; then
  if grep -q '^ABS_TAG=' "$ENV_FILE"; then
    sed -i "s|^ABS_TAG=.*|ABS_TAG=${TAG_OVERRIDE}|" "$ENV_FILE"
  else
    printf 'ABS_TAG=%s\n' "$TAG_OVERRIDE" >>"$ENV_FILE"
  fi
fi

for d in "$ABS_AUDIOBOOKS_DIR" "$ABS_CONFIG_DIR" "$ABS_METADATA_DIR" "$ABS_BACKUP_DIR"; do
  [[ -d "$d" ]] || { log "Creating directory $d"; mkdir -p "$d"; }
done

# ---------------------------------------------------------------------------
# Compose file (managed by this script; rewritten only when content changed)
# ---------------------------------------------------------------------------
COMPOSE_CONTENT=$(cat <<'EOF'
# Managed by scripts/update-server.sh - edit .env instead of this file.
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
)

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
# What is running, what is available
# ---------------------------------------------------------------------------
image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
image_digest() { docker image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null || true; }

CONTAINER_ID="$(docker ps -aq --filter "name=^audiobookshelf$" || true)"
RUNNING_IMAGE_ID=""
CONTAINER_STATE="absent"
if [[ -n "$CONTAINER_ID" ]]; then
  RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_ID")"
  CONTAINER_STATE="$(docker inspect --format '{{.State.Status}}' "$CONTAINER_ID")"
fi
LOCAL_IMAGE_ID_BEFORE="$(image_id "$IMAGE_REF")"

log "Deployment directory: $ABS_DIR"
log "Image: $IMAGE_REF"
log "Container: ${CONTAINER_STATE}${RUNNING_IMAGE_ID:+ (image ${RUNNING_IMAGE_ID:7:12})}"

if [[ $CHECK_ONLY -eq 1 ]]; then
  # Compare the remote manifest digest with the local image without pulling
  REMOTE_DIGEST="$(docker manifest inspect "$IMAGE_REF" 2>/dev/null | grep -m1 -o '"digest": *"sha256:[0-9a-f]*"' | grep -o 'sha256:[0-9a-f]*' || true)"
  LOCAL_DIGEST="$(image_digest "$IMAGE_REF" | grep -o 'sha256:[0-9a-f]*' || true)"
  if [[ -z "$REMOTE_DIGEST" ]]; then
    die "cannot read the remote manifest of $IMAGE_REF (private package: run 'docker login ghcr.io -u <github user>' as the user running this script with a token that has read:packages; or no network)"
  fi
  if [[ -z "$LOCAL_IMAGE_ID_BEFORE" || -z "$CONTAINER_ID" ]]; then
    log "Not installed yet, run without --check to install"
    exit 2
  fi
  if [[ "$REMOTE_DIGEST" != "$LOCAL_DIGEST" || "$RUNNING_IMAGE_ID" != "$LOCAL_IMAGE_ID_BEFORE" ]]; then
    log "Update available (remote ${REMOTE_DIGEST:7:12}, local ${LOCAL_DIGEST:7:12})"
    exit 2
  fi
  log "Up to date"
  exit 0
fi

# ---------------------------------------------------------------------------
# Pull
# ---------------------------------------------------------------------------
log "Pulling $IMAGE_REF"
if ! compose pull --quiet 2>/dev/null; then
  compose pull || die "pull failed (the package is private: run 'docker login ghcr.io -u <github user>' as the user running this script, e.g. root under sudo/cron, with a token that has read:packages)"
fi
LOCAL_IMAGE_ID_AFTER="$(image_id "$IMAGE_REF")"
[[ -n "$LOCAL_IMAGE_ID_AFTER" ]] || die "image $IMAGE_REF is not available after pull"

NEEDS_RECREATE=0
if [[ -z "$CONTAINER_ID" ]]; then
  NEEDS_RECREATE=1; REASON="container does not exist"
elif [[ "$RUNNING_IMAGE_ID" != "$LOCAL_IMAGE_ID_AFTER" ]]; then
  NEEDS_RECREATE=1; REASON="new image ${LOCAL_IMAGE_ID_AFTER:7:12} (running ${RUNNING_IMAGE_ID:7:12})"
elif [[ "$CONTAINER_STATE" != "running" ]]; then
  NEEDS_RECREATE=1; REASON="container is $CONTAINER_STATE"
elif [[ $FORCE -eq 1 ]]; then
  NEEDS_RECREATE=1; REASON="--force"
fi

if [[ $NEEDS_RECREATE -eq 0 ]]; then
  # `up -d` is still run so that compose/env changes (port, volumes) are applied;
  # it is a no-op when nothing changed
  compose up -d --remove-orphans >/dev/null
  log "Already up to date, nothing to do"
  exit 0
fi

log "Update needed: $REASON"

# ---------------------------------------------------------------------------
# Backup of the config directory (database, settings) before changing anything
# ---------------------------------------------------------------------------
if [[ $DO_BACKUP -eq 1 && -n "$CONTAINER_ID" ]]; then
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  BACKUP_FILE="$ABS_BACKUP_DIR/config-${STAMP}.tar.gz"
  log "Backing up $ABS_CONFIG_DIR to $BACKUP_FILE"
  # Stop the server first so the SQLite database is consistent
  compose stop audiobookshelf >/dev/null
  tar -czf "$BACKUP_FILE" -C "$(dirname "$ABS_CONFIG_DIR")" "$(basename "$ABS_CONFIG_DIR")"
  # Rotate: keep the newest ABS_BACKUP_KEEP backups
  if [[ "$ABS_BACKUP_KEEP" =~ ^[0-9]+$ ]] && [[ "$ABS_BACKUP_KEEP" -gt 0 ]]; then
    find "$ABS_BACKUP_DIR" -maxdepth 1 -name 'config-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n +$((ABS_BACKUP_KEEP + 1)) | cut -d' ' -f2- | while read -r old; do
      log "Removing old backup $old"
      rm -f "$old"
    done
  fi
fi

# ---------------------------------------------------------------------------
# Recreate and verify
# ---------------------------------------------------------------------------
log "Starting container"
compose up -d --remove-orphans --force-recreate

HEALTH_URL="http://127.0.0.1:${ABS_PORT}/healthcheck"
log "Waiting for $HEALTH_URL"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL"; then
    NEW_CONTAINER_ID="$(docker ps -q --filter "name=^audiobookshelf$")"
    log "Audiobookshelf is up (container ${NEW_CONTAINER_ID:0:12}, image ${LOCAL_IMAGE_ID_AFTER:7:12})"
    # Remove dangling old images of this repository to save disk space
    docker image prune -f --filter "label=org.opencontainers.image.source=https://github.com/dospe/audiobookshelf" >/dev/null 2>&1 || true
    log "Done. Open http://<server>:${ABS_PORT}/ and run a library scan if new ebook formats should be picked up."
    exit 0
  fi
  sleep 2
done

log "ERROR: the server did not become healthy within 120 s. Recent logs:" >&2
compose logs --tail 50 audiobookshelf >&2 || true
log "To roll back: $SCRIPT_NAME --tag <previous tag or latest@sha256:<digest>>; config backups are in $ABS_BACKUP_DIR" >&2
exit 1
