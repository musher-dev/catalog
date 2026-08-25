#!/usr/bin/env bash
# env-check.sh — CLI wrapper around the env-check library.
#
# Reports keys present in .devcontainer/.env.example but missing from the
# developer's .devcontainer/.env, and keys left at the empty "please fill this
# in" state.
#
# The logic lives in lib/env-check.sh so the MOTD can reuse it. This file
# exists so `task env:check` has something to invoke that is a real script —
# Task runs commands through its own shell, and `source` is not something to
# rely on there.
#
# Usage: bash .devcontainer/scripts/env-check.sh
# Returns: 0 when the local .env matches the template, 1 on drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly DEVCONTAINER_DIR="${SCRIPT_DIR}/.."
readonly ENV_FILE="${DEVCONTAINER_DIR}/.env"
readonly ENV_EXAMPLE="${DEVCONTAINER_DIR}/.env.example"

# shellcheck source=lib/env-check.sh
source "${SCRIPT_DIR}/lib/env-check.sh"

main() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    echo "env: no .devcontainer/.env — run 'task env:reset' to create one" >&2
    return 1
  fi

  local status=0

  local missing
  missing="$(env_check_drift "${ENV_FILE}" "${ENV_EXAMPLE}" 2>&1 || true)"
  if [[ -n "${missing}" ]]; then
    echo "env: keys in .env.example missing from .env:" >&2
    awk '{print "  - " $0}' <<< "${missing}" >&2
    echo "env: run 'task env:reset' to sync" >&2
    status=1
  fi

  local required
  required="$(env_check_required "${ENV_FILE}" || true)"
  if [[ -n "${required}" ]]; then
    # Informational, not a failure: the three-state grammar in .env.example
    # uses an empty value to mean "you must fill this in", and this repository
    # ships none — but a developer may add one.
    echo "env: keys awaiting a value:" >&2
    awk '{print "  - " $0}' <<< "${required}" >&2
  fi

  ((status == 0)) && echo "env: .env matches .env.example"
  return "${status}"
}

main "$@"
