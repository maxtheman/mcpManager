#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_NAME="$(basename "$SKILL_DIR")"
SCRIPT_REL="${1:-scripts/read_file.py}"

if [[ $# -gt 0 ]]; then
  shift
fi

ENV_ROOT="${MX_SKILL_ENVS_DIR:-"$HOME/.Mx/skill-envs"}"
ENV_DIR="${ENV_ROOT}/${SKILL_NAME}"

if command -v uv >/dev/null 2>&1 && [[ -f "$SKILL_DIR/pyproject.toml" ]]; then
  export UV_PROJECT_ENVIRONMENT="$ENV_DIR"
  if [[ ! -f "$ENV_DIR/pyvenv.cfg" ]]; then
    uv --project "$SKILL_DIR" sync
  fi
  uv --project "$SKILL_DIR" run python "$SKILL_DIR/$SCRIPT_REL" "$@"
  exit $?
fi

python3 "$SKILL_DIR/$SCRIPT_REL" "$@"
