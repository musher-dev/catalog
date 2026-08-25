#!/usr/bin/env bash
# startup.sh — Runs on every container start.
#
# The template's version brings up a compose stack and waits for health checks.
# This repository has no services to start — it holds YAML and validates it —
# so all that remains is the MOTD. The file is kept rather than dropped so the
# postStartCommand hook has somewhere to grow, and so the lifecycle matches
# musher-dev/spec's.
#
# Usage: Called automatically by devcontainer.json postStartCommand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
DEVCONTAINER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly DEVCONTAINER_DIR

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/motd.sh
source "${SCRIPT_DIR}/lib/motd.sh"

# Logs the failing command and line number on ERR.
#
# Arguments:
#   $1 — line number
#   $2 — failed command string
# Outputs:
#   Writes error details to stderr via log()
on_error() {
  local line="${1}"
  local cmd="${2}"
  log "ERROR: command '${cmd}' failed at line ${line}"
}
trap 'on_error ${LINENO} "${BASH_COMMAND}"' ERR

# Entry point.
#
# Outputs:
#   MOTD to stdout
main() {
  show_motd "${DEVCONTAINER_DIR}"
}

main "$@"
