#!/usr/bin/env bash
# Runs INSIDE the bwrap sandbox (which, when docker is enabled, itself runs
# inside a rootlesskit user namespace). Responsibilities:
#   1. Optionally bring up a rootless dockerd in the background, confined to
#      the sandbox's restricted filesystem view (so `docker run -v ...` cannot
#      escape to unexposed host paths).
#   2. exec the real target command (claude / shell), inheriting the pty.
#
# Environment (set via bwrap --setenv):
#   CCSANDBOX_DOCKER          "1" to start dockerd, else skip
#   CCSANDBOX_DOCKER_DATAROOT persistent data-root for images/layers
#   HOME, XDG_RUNTIME_DIR, PATH, DOCKER_HOST
set -u

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

if [ "${CCSANDBOX_DOCKER:-0}" = "1" ]; then
  export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/docker.sock"
  DATA_ROOT="${CCSANDBOX_DOCKER_DATAROOT:-$HOME/.local/share/docker}"
  LOG="$XDG_RUNTIME_DIR/dockerd.log"
  LOCK="$DATA_ROOT/.ccserver-dockerd.lock"
  mkdir -p "$DATA_ROOT" 2>/dev/null || true

  # RootlessKit's copy-up leaves stale symlinks for these in the child; remove
  # them so dockerd can create its own.
  rm -f /run/docker /run/containerd /run/xtables.lock 2>/dev/null || true

  # dockerd auto-detects rootless mode from ROOTLESSKIT_STATE_DIR (set by
  # rootlesskit). The flock guard prevents two daemons from sharing one
  # data-root (e.g. the same project opened in two sandboxes at once); the
  # second session simply runs without docker rather than corrupting state.
  (
    exec 9>"$LOCK" || exit 0
    if flock -n 9; then
      exec dockerd \
        --host="$DOCKER_HOST" \
        --data-root="$DATA_ROOT" \
        --exec-root="$XDG_RUNTIME_DIR/docker-exec" \
        >"$LOG" 2>&1
    fi
  ) &
fi

exec "$@"
