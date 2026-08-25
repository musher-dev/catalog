#!/usr/bin/env bash
# post-create.sh — DevContainer post-create command hook.
#
# Runs once after the container is created. Sets up config and cache
# directories, installs the pinned CLIs and Claude Code, then installs this
# repository's own dependencies.
#
# Usage: Called automatically by devcontainer.json postCreateCommand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT

# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=lib/base-setup.sh
source "${SCRIPT_DIR}/lib/base-setup.sh"

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

# Installs lefthook git hooks for this repo. Best-effort: silently
# skips if lefthook isn't on PATH yet or no .config/lefthook.yml exists.
#
# Outputs:
#   Writes progress to stderr via log()
install_lefthook_hooks() {
  command -v lefthook >/dev/null 2>&1 || return 0
  [[ -f "${REPO_ROOT}/.config/lefthook.yml" ]] || return 0
  log "Installing lefthook git hooks..."
  (cd "${REPO_ROOT}" && lefthook install >/dev/null 2>&1) || true
}

# Installs the validation suite's dependencies.
#
# Best-effort: a failure here leaves the container usable, and `task setup`
# recovers. `npm ci` rather than `npm install` so the lockfile decides — a
# container that silently resolved different versions than CI is a container
# that reproduces nothing.
#
# Outputs:
#   Writes progress to stderr via log()
install_test_dependencies() {
  command -v npm >/dev/null 2>&1 || return 0
  [[ -f "${REPO_ROOT}/package.json" ]] || return 0
  log "Installing validation dependencies (npm ci)..."
  (cd "${REPO_ROOT}" && npm ci) || {
    log "WARNING: npm ci failed; run 'task setup' once the container is up"
    return 0
  }
}

# Entry point: runs the full post-create setup sequence.
#
# Arguments:
#   $@ — passed through (unused, reserved for future use)
# Outputs:
#   Writes progress to stderr via log()
main() {
  log "Starting post-create setup..."
  base_setup
  install_lefthook_hooks
  # --- Repo-specific setup ---
  install_test_dependencies
  log "Post-create setup completed"
}

main "$@"
