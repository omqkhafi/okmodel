#!/usr/bin/env bash
# Plan comment and optional preview apply (D278).
# The target name is the action input. This script never picks a name.
# It never creates or drops a database.
set -euo pipefail

target="$(printf '%s' "${INPUT_TARGET:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$target" ]; then
  printf '%s\n' "error OKM1853: --target needs a name." "Pass --target <name>." >&2
  exit 1
fi

if [ -n "${INPUT_DATABASE_URL:-}" ]; then
  export DATABASE_URL="$INPUT_DATABASE_URL"
fi
if [ -n "${DATABASE_URL:-}" ]; then
  echo "::add-mask::${DATABASE_URL}"
fi

repo="$(cd "${GITHUB_ACTION_PATH}/../../.." && pwd)"
version="${INPUT_VERSION:-}"
if [ -n "$version" ]; then
  okm_home="${RUNNER_TEMP:-/tmp}/okmodel-action"
  mkdir -p "$okm_home"
  if [ ! -x "$okm_home/node_modules/.bin/okm" ]; then
    (
      cd "$okm_home"
      bun add "okmodel@${version}"
    )
  fi
fi

run_okm() {
  if [ -n "$version" ]; then
    (
      cd "$okm_home"
      bunx --bun okm "$@"
    )
  else
    if [ ! -d "$repo/node_modules" ]; then
      (
        cd "$repo"
        bun install --frozen-lockfile
      )
    fi
    bun "$repo/src/tooling/cli.ts" "$@"
  fi
}

wd="${INPUT_WORKING_DIRECTORY:-.}"
case "$wd" in
  /*) ;;
  *) wd="${GITHUB_WORKSPACE:?}/${wd}" ;;
esac
cd "$wd"

echo "okm migrate check --target ${target}"
plan_file="${RUNNER_TEMP:-/tmp}/okm-plan.json"
rm -f "$plan_file"
set +e
run_okm migrate check --target "$target"
check_status=$?
run_okm migrate plan github --target "$target" --json >"$plan_file"
plan_status=$?
set -e

comment="${INPUT_COMMENT:-true}"
if [ "$comment" = "true" ]; then
  if [ "${EVENT_NAME:-}" = "pull_request" ] && [ -n "${PR_NUMBER:-}" ]; then
    bun "$repo/src/tooling/github/post-comment.ts" "$plan_file" "$check_status" "$plan_status"
  else
    echo "comment skipped: not a pull request"
  fi
fi

if [ "$check_status" -ne 0 ]; then
  exit "$check_status"
fi
if [ "$plan_status" -ne 0 ]; then
  exit "$plan_status"
fi

preview="${INPUT_PREVIEW:-false}"
if [ "$preview" != "true" ]; then
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "preview needs DATABASE_URL or the database-url input." >&2
  exit 1
fi

echo "okm migrate apply --target ${target}"
run_okm migrate apply --target "$target"
seed="${INPUT_SEED:-}"
if [ -n "$seed" ]; then
  echo "okm seed ${seed} --target ${target}"
  run_okm seed "$seed" --target "$target"
fi
