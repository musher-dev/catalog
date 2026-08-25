#!/usr/bin/env bash
# base-setup.sh — Reusable setup orchestrator for musher dev containers.
#
# This file is intended to be sourced, not executed directly.
# Source it and call base_setup, or call individual functions to customize.
#
# Usage:
#   source "path/to/base-setup.sh"
#   base_setup
set -euo pipefail

# Guard against direct execution — this file must be sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Error: source this file, don't execute it" >&2
  exit 1
fi

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly _LIB_DIR
readonly _HOME="/home/${REMOTE_USER:-vscode}"

# shellcheck source=common.sh
source "${_LIB_DIR}/common.sh"

# --- Config directories ---

# Creates standard config directories for dev tools.
#
# Globals:
#   _HOME — read, user home directory
# Outputs:
#   Writes progress to stderr via log()
base_setup_config_dirs() {
  setup_config_dirs \
    "gh config:${_HOME}/.config/gh" \
    "claude:${_HOME}/.claude"
}

# --- Cache directories ---

# Creates cache directories so caches land under a single tree instead of
# scattering across the filesystem.
#
# Only the caches this repository can actually produce are created. The
# template's uv, ruff, pip, mypy, deno, go and bun entries are absent because
# none of those runtimes is installed — a directory for a tool that does not
# exist is a claim the container does not honour.
#
# Globals:
#   _HOME — read, user home directory
# Outputs:
#   Writes progress to stderr via log()
base_setup_cache_dirs() {
  setup_config_dirs \
    "xdg cache:${_HOME}/.cache" \
    "npm cache:${_HOME}/.cache/npm"
}

# --- NVM ---

# The Node feature installs Node via nvm; fix nvm's ownership so global npm
# installs work. Delegates to fix_nvm_permissions from common.sh.
base_fix_nvm_permissions() {
  fix_nvm_permissions
}

# --- mise (pins the CLIs that have no devcontainer Feature) ---

readonly _MISE_BIN="${_HOME}/.local/bin/mise"
readonly _MISE_SHIMS="${_HOME}/.local/share/mise/shims"

# Puts the mise shims and ~/.local/bin on PATH for the rest of this script, so
# mise-managed CLIs and Claude are visible to base_verify_tools (lifecycle
# hooks don't always inherit devcontainer.json remoteEnv).
#
# Globals:
#   PATH — modified (export)
base_setup_path() {
  export PATH="${_MISE_SHIMS}:${_HOME}/.local/bin:${PATH}"
}

# Installs mise via the official installer if not already present.
#
# Outputs:
#   Writes progress to stderr via log()
# Returns:
#   0 on success, non-zero on failure
base_install_mise() {
  if has_cmd mise; then
    log "mise already installed, skipping"
    return 0
  fi
  log "Installing mise (https://mise.run)..."
  retry 3 5 bash -c 'curl -fsSL https://mise.run | sh'
}

# Installs the CLIs pinned in .devcontainer/mise.toml (tools with no Feature),
# then regenerates shims. MISE_GLOBAL_CONFIG_FILE (devcontainer.json →
# containerEnv) points mise at that manifest.
#
# Globals:
#   MISE_GLOBAL_CONFIG_FILE — read, path to the tool manifest
# Outputs:
#   Writes progress to stderr via log()
# Returns:
#   0 on success, non-zero on failure
base_install_tools() {
  local mise
  mise="$(command -v mise || echo "${_MISE_BIN}")"
  local config="${MISE_GLOBAL_CONFIG_FILE:-${_LIB_DIR}/../../mise.toml}"
  log "Installing pinned CLIs from ${config}..."
  "${mise}" trust "${config}" >/dev/null 2>&1 || true
  retry 3 5 "${mise}" install
  "${mise}" reshim >/dev/null 2>&1 || true
}

# --- Claude Code ---

# Installs Claude Code via the native installer if not already present.
#
# MUSHER_INSTALL_CLAUDE=0 skips it. The flag is read here rather than only
# documented: .env.example offers it as the escape hatch for a slow connection,
# and an advertised switch that nothing honours is worse than no switch.
#
# Globals:
#   MUSHER_INSTALL_CLAUDE — read, "0" to skip (default: install)
# Outputs:
#   Writes progress to stderr via log()
# Returns:
#   0 on success, non-zero on failure
base_install_claude() {
  if [[ "${MUSHER_INSTALL_CLAUDE:-1}" == "0" ]]; then
    log "MUSHER_INSTALL_CLAUDE=0, skipping Claude Code install"
    return 0
  fi
  if has_cmd claude; then
    log "Claude Code already installed, skipping"
    return 0
  fi
  log "Installing Claude Code (native installer)..."
  retry 3 5 bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
}

# --- Verify ---

# Verifies the CLIs this script installs (plus a couple of key Feature tools)
# are on PATH. Runtimes are validated by the container build itself.
#
# actionlint and shellcheck are here because `task check` runs both, and a tool
# that is absent or built for the wrong CPU architecture should fail loudly at
# container build rather than at the first push.
#
# Claude is checked only when it was meant to be installed, so a container
# built with MUSHER_INSTALL_CLAUDE=0 does not fail its own verification.
#
# Globals:
#   MUSHER_INSTALL_CLAUDE — read, "0" drops claude from the checked set
# Outputs:
#   Writes tool status to stderr via log()
# Returns:
#   0 if all tools found, 1 if any are missing
base_verify_tools() {
  local tools=(gh task node npm lefthook actionlint shellcheck)
  [[ "${MUSHER_INSTALL_CLAUDE:-1}" == "0" ]] || tools+=(claude)
  verify_tools "${tools[@]}"
}

# --- Orchestrator ---

# Runs the complete base setup sequence.
#
# Outputs:
#   Writes progress to stderr via log()
base_setup() {
  log "Running base setup..."
  base_setup_config_dirs
  base_setup_cache_dirs
  base_fix_nvm_permissions
  base_setup_path
  base_install_mise
  base_install_tools
  base_install_claude
  base_verify_tools
  log "Base setup complete"
}
