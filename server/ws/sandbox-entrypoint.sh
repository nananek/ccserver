#!/usr/bin/env bash
# Runs INSIDE the bwrap sandbox (which, when docker is enabled, itself runs
# inside a rootlesskit user namespace). Responsibilities:
#   1. Optionally bring up a rootless dockerd in the background, confined to
#      the sandbox's restricted filesystem view (so `docker run -v ...` cannot
#      escape to unexposed host paths).
#   2. Optionally provision opt-in tools (rtk / code-review-graph) into the
#      sandbox HOME (see sandbox-provision.sh). The provisioner echoes
#      "[sandbox] … をインストール中…" status lines to the terminal so the CLI
#      shows progress while it runs; its detailed output goes to provision.log.
#   3. exec the real target command (claude / shell), inheriting the pty.
#
# Environment (set via bwrap --setenv):
#   CCSANDBOX_DOCKER          "1" to start dockerd, else skip
#   CCSANDBOX_DOCKER_DATAROOT persistent data-root for images/layers
#   CCSANDBOX_DOCKERD_TAG     this launch's tag, recorded in the status file
#                             below iff it wins the flock (see sandbox.js's
#                             dockerdStatus/dockerAvailability)
#   CCSANDBOX_DOCKER_NO_IPTABLES "1" when network isolation is also active:
#                             starts dockerd with --iptables=false so it never
#                             inserts its own FORWARD/NAT rules on top of the
#                             netns firewall (see buildBwrapNetworkFilterScript
#                             in sandbox.js). Container port publishing
#                             (`docker run -p`) does not work in this mode.
#   CCSANDBOX_PROVISION_RTK / CCSANDBOX_PROVISION_CRG  "1" to provision
#   CCSANDBOX_RTK_VERSION / CCSANDBOX_RTK_URL / CCSANDBOX_RTK_SHA256 / CCSANDBOX_CRG_VERSION
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
  STATUS="$DATA_ROOT/.ccserver-dockerd.status"
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
      # Record which launch won the lock, so the host side (dockerdStatus in
      # sandbox.js) can tell "docker is available to ME" apart from "docker
      # is in use by another session of this project" without guessing from
      # startup order. Written just before exec (nothing after this
      # subshell's exec runs) and never blocks/affects the flock itself.
      echo "${CCSANDBOX_DOCKERD_TAG:-}" > "$STATUS" 2>/dev/null || true
      DOCKERD_IPTABLES_ARGS=""
      if [ "${CCSANDBOX_DOCKER_NO_IPTABLES:-0}" = "1" ]; then
        DOCKERD_IPTABLES_ARGS="--iptables=false"
      fi
      exec dockerd \
        --host="$DOCKER_HOST" \
        --data-root="$DATA_ROOT" \
        --exec-root="$XDG_RUNTIME_DIR/docker-exec" \
        $DOCKERD_IPTABLES_ARGS \
        >"$LOG" 2>&1
    fi
  ) &
fi

# Opt-in tool provisioning (rtk / code-review-graph, see sandbox-provision.sh).
# Runs after dockerd is up and before the target command so the agent finds
# the tools ready. Failures are logged (never aborts the session).
if [ "${CCSANDBOX_PROVISION_RTK:-0}" = "1" ] || [ "${CCSANDBOX_PROVISION_CRG:-0}" = "1" ]; then
  if ! /ccserver-sandbox-provision.sh; then
    echo "[sandbox] tool provisioning failed; see $HOME/.local/share/ccserver-tools/provision.log" >&2
  fi
fi

exec "$@"
