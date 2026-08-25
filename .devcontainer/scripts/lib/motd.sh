#!/usr/bin/env bash
# motd.sh — Renders a startup MOTD summarizing the dev container state.
#
# This is a library file meant to be sourced, not executed directly.
# Requires common.sh (has_cmd, log) to be sourced first.
#
# Usage: source "path/to/motd.sh"; show_motd "/path/to/.devcontainer"
#
# Trimmed from musher-dev/spec's: the services block is gone with the compose
# stack, and the runtime rows list what this container actually installs rather
# than every runtime the template could have installed.

if [[ -z "${_MOTD_SH_LOADED:-}" ]]; then
readonly _MOTD_SH_LOADED=1

# --- Color setup ---

_motd_setup_colors() {
  if [[ -t 1 ]] && has_cmd tput; then
    _BOLD="$(tput bold)"
    _DIM="$(tput dim)"
    _GREEN="$(tput setaf 2)"
    _YELLOW="$(tput setaf 3)"
    _CYAN="$(tput setaf 6)"
    _RESET="$(tput sgr0)"
  else
    _BOLD="" _DIM="" _GREEN="" _YELLOW="" _CYAN="" _RESET=""
  fi
}

# --- Sub-functions ---

_motd_header() {
  local line
  line="$(printf '═%.0s' {1..58})"
  echo "${_BOLD}${line}${_RESET}"
  echo "${_BOLD}  Musher Catalog Dev Container${_RESET}"
  echo "${_BOLD}${line}${_RESET}"
}

# Prints a detected tool version, or a dash if it is not on PATH.
#
# Arguments:
#   $1 — command name
#   $2 — display label
#   $3 — version extraction command (eval'd)
_motd_tool_entry() {
  local cmd="$1" label="$2" version_cmd="$3"
  # ASCII, not an em dash: printf pads %-16s by bytes, and a 3-byte dash
  # displaying as one character knocks the second column out by two.
  local ver="-" color="${_YELLOW}"
  if has_cmd "$cmd"; then
    ver="$(eval "$version_cmd" 2>/dev/null || echo '?')"
    color="${_GREEN}"
  fi
  printf "  ${_CYAN}%-11s${_RESET} ${color}%-16s${_RESET}" "$label" "$ver"
}

_motd_tools() {
  local sep
  sep="$(printf '─%.0s' {1..54})"
  echo ""
  echo "  ${_BOLD}Tooling${_RESET}"
  echo "  ${_DIM}${sep}${_RESET}"

  _motd_tool_entry node "node" "node -v"
  _motd_tool_entry npm "npm" "npm -v"
  echo ""

  _motd_tool_entry task "task" "task --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+'"
  _motd_tool_entry gh "gh" "gh --version | head -1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+'"
  echo ""

  _motd_tool_entry shellcheck "shellcheck" "shellcheck --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1"
  _motd_tool_entry actionlint "actionlint" "actionlint --version | head -1"
  echo ""

  _motd_tool_entry lefthook "lefthook" "lefthook version"
  _motd_tool_entry claude "claude" "claude --version | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1"
  echo ""
}

# Names where the test suite reads the contract from. Constant by design — the
# line is here so it is never a question what a run was judged against.
_motd_spec_source() {
  local sep
  sep="$(printf '─%.0s' {1..54})"
  echo ""
  echo "  ${_BOLD}Validating against${_RESET}"
  echo "  ${_DIM}${sep}${_RESET}"
  echo "  musher-dev/spec @ main"
  echo "  ${_DIM}public repo, fetched at run time; no token, no cache, no fallback${_RESET}"
}

_motd_quickref() {
  local sep
  sep="$(printf '─%.0s' {1..54})"
  echo ""
  echo "  ${_BOLD}Quick Reference${_RESET}"
  echo "  ${_DIM}${sep}${_RESET}"
  echo "  task                             List tasks"
  echo "  task check                       Everything CI runs"
  echo "  task test                        Validate the catalog corpus"
  echo "  task test:item -- <slug>         Validate one item"
  echo "  claude                           Claude Code"
}

# Warns when .env is missing keys from .env.example, or has empty
# required values. Silent when env is healthy.
#
# Globals:
#   _BOLD, _DIM, _YELLOW, _RESET — color codes set by _motd_setup_colors
# Arguments:
#   $1 — .devcontainer directory (where .env / .env.example live)
_motd_env_warnings() {
  local devcontainer_dir="${1:-}"
  [[ -d "${devcontainer_dir}" ]] || return 0

  local env_file="${devcontainer_dir}/.env"
  local example_file="${devcontainer_dir}/.env.example"
  local lib_file="${devcontainer_dir}/scripts/lib/env-check.sh"
  [[ -f "${lib_file}" ]] || return 0

  # shellcheck source=./env-check.sh
  source "${lib_file}"

  local missing="" required=""
  if [[ -f "${example_file}" ]]; then
    missing="$(env_check_drift "${env_file}" "${example_file}" 2>&1 || true)"
  fi
  required="$(env_check_required "${env_file}" 2>/dev/null || true)"

  if [[ -z "${missing}" && -z "${required}" ]]; then
    return 0
  fi

  local sep
  sep="$(printf '─%.0s' {1..54})"
  echo ""
  echo "  ${_BOLD}${_YELLOW}Environment${_RESET}"
  echo "  ${_DIM}${sep}${_RESET}"
  if [[ -n "${missing}" ]]; then
    echo "  ${_YELLOW}Missing keys in .env (run 'task env:reset' to sync):${_RESET}"
    awk '{print "    - " $0}' <<< "${missing}"
  fi
  if [[ -n "${required}" ]]; then
    echo "  ${_YELLOW}Required keys with empty values:${_RESET}"
    awk '{print "    - " $0}' <<< "${required}"
  fi
}

_motd_tips() {
  local sep
  sep="$(printf '─%.0s' {1..54})"
  echo ""
  echo "  ${_BOLD}Tips${_RESET}"
  echo "  ${_DIM}${sep}${_RESET}"
  echo "  * Add an item:             README.md (Adding an item)"
  echo "  * How validation works:    tests/README.md"
  echo "  * Item contracts:          README.md (Item contracts)"
  echo "  * Tool versions:           .devcontainer/{devcontainer.json,mise.toml}"
}

# Renders the full MOTD to stdout.
#
# Arguments:
#   $1 — path to .devcontainer/ directory (may be empty to skip env warnings)
# Outputs:
#   MOTD text to stdout
show_motd() {
  local devcontainer_dir="${1:-}"
  _motd_setup_colors

  local border
  border="$(printf '═%.0s' {1..58})"

  echo ""
  _motd_header
  _motd_tools
  _motd_spec_source
  _motd_env_warnings "$devcontainer_dir"
  _motd_quickref
  _motd_tips
  echo "${_BOLD}${border}${_RESET}"
  echo ""
}

fi
