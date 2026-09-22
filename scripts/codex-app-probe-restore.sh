#!/usr/bin/env bash
set -euo pipefail

# Restore the exact Codex configuration saved by codex-app-probe-apply.sh.

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
codex_home="${CODEX_HOME:-${HOME}/.codex}"
state_path="$codex_home/.llm-auto-gateway-app-probe.state"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

app_is_running() {
  local app_executable="${CODEX_APP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}"
  ps -axo pid=,args= | awk -v app="$app_executable" '$2 == app { found = 1 } END { exit !found }'
}

[ -f "$state_path" ] || die "no active App probe state found: $state_path"

read_state() {
  local key="$1"
  awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$state_path"
}

config_path="$(read_state config_path)"
backup_path="$(read_state backup_path)"
catalog_path="$(read_state catalog_path)"
expected_hash="$(read_state config_hash)"
backup_hash="$(read_state backup_hash)"
catalog_hash="$(read_state catalog_hash)"
catalog_upgrade_backup="$(read_state catalog_upgrade_backup)"

[ -n "$config_path" ] || die "probe state is missing config_path"
[ -n "$backup_path" ] || die "probe state is missing backup_path"
[ -n "$catalog_path" ] || die "probe state is missing catalog_path"
[ -f "$config_path" ] || die "active config does not exist: $config_path"
[ -f "$backup_path" ] || die "probe backup does not exist: $backup_path"

if app_is_running; then
  die "Codex App main process is still running; quit the entire App with Cmd+Q before restoring the configuration"
fi

actual_hash="$(shasum -a 256 "$config_path" | awk '{print $1}')"
if [ "$actual_hash" != "$expected_hash" ] && [ "${CODEX_APP_PROBE_FORCE_RESTORE:-0}" != "1" ]; then
  die "active config changed after the probe; inspect it and set CODEX_APP_PROBE_FORCE_RESTORE=1 only if exact restoration is intended"
fi

if [ -n "$backup_hash" ] && [ "$(shasum -a 256 "$backup_path" | awk '{print $1}')" != "$backup_hash" ]; then
  die "backup changed since apply; no restoration performed"
fi

if [ -n "$catalog_hash" ] && [ -f "$catalog_path" ] && [ "$(shasum -a 256 "$catalog_path" | awk '{print $1}')" != "$catalog_hash" ] && [ "${CODEX_APP_PROBE_FORCE_RESTORE:-0}" != "1" ]; then
  die "active model catalog changed after upgrade; no restoration performed"
fi

tmp_restore="$(mktemp "$(dirname "$config_path")/.config.toml.llm-auto-gateway-restore.XXXXXX")"
cleanup() { [ -z "$tmp_restore" ] || rm -f "$tmp_restore"; }
trap cleanup EXIT
cp -p "$backup_path" "$tmp_restore"
backup_mode="$(stat -f '%Lp' "$backup_path")"
chmod "$backup_mode" "$tmp_restore"
mv "$tmp_restore" "$config_path"
tmp_restore=""

rm -f "$catalog_path" "$state_path" "$backup_path"
[ -z "$catalog_upgrade_backup" ] || rm -f "$catalog_upgrade_backup"

printf 'Codex App probe configuration restored.\n'
printf 'config: %s\n' "$config_path"
printf 'Run from repository: %s\n' "$repo_root"
