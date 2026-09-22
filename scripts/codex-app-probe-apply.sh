#!/usr/bin/env bash
set -euo pipefail

# Apply a reversible Codex App model-catalog probe.
# The script never touches auth.json or the running App process.

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
codex_home="${CODEX_HOME:-${HOME}/.codex}"
config_path="${CODEX_CONFIG_PATH:-$codex_home/config.toml}"
base_url="${CODEX_APP_PROBE_BASE_URL:-http://127.0.0.1:8788/subscription/v1}"
custom_model="${CODEX_APP_PROBE_MODEL:-deepseek-v4.1-flash}"
custom_display_name="${CODEX_APP_PROBE_DISPLAY_NAME:-DeepSeek V4.1 Flash (custom)}"
gateway_config="${GATEWAY_CONFIG:-$repo_root/config/gateway.subscription.local.json}"
state_path="$codex_home/.llm-auto-gateway-app-probe.state"
backup_path="${CODEX_APP_PROBE_BACKUP_PATH:-$config_path.llm-auto-gateway-app-probe.bak}"
catalog_dir="$codex_home/model-catalogs"
catalog_path="$catalog_dir/llm-auto-gateway-app-probe.json"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

app_is_running() {
  local app_executable="${CODEX_APP_EXECUTABLE:-/Applications/ChatGPT.app/Contents/MacOS/ChatGPT}"
  ps -axo pid=,args= | awk -v app="$app_executable" '$2 == app { found = 1 } END { exit !found }'
}

case "$custom_model" in
  ''|*[!A-Za-z0-9._:-]*) die "CODEX_APP_PROBE_MODEL contains unsupported characters" ;;
esac
case "$custom_display_name" in
  *'"'*|*$'\n'*) die "CODEX_APP_PROBE_DISPLAY_NAME contains unsupported characters" ;;
esac

case "$base_url" in
  http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*) ;;
  *) die "CODEX_APP_PROBE_BASE_URL must point to a local endpoint (got $base_url)" ;;
esac

[ -d "$codex_home" ] || die "Codex home does not exist: $codex_home"
[ -f "$config_path" ] || die "Codex config does not exist: $config_path"
[ ! -e "$state_path" ] || die "an App probe is already active; run scripts/codex-app-probe-restore.sh first"
[ ! -e "$backup_path" ] || die "backup already exists: $backup_path; restore it or move it aside before retrying"
[ ! -e "$catalog_path" ] || die "probe catalog already exists: $catalog_path; restore the previous probe before retrying"
marker_count="$(rg -c '^# BEGIN llm-auto-gateway Codex App probe$' "$config_path" 2>/dev/null || printf '0')"
[ "$marker_count" = "0" ] || die "config already contains the App probe marker"

if app_is_running; then
  die "Codex App main process is still running; quit the entire App with Cmd+Q before applying the probe"
fi

# Verify the production endpoint before making any backup or configuration change.
node --input-type=module - "$base_url" "$custom_model" <<'NODE'
const base = process.argv[2];
const customModel = process.argv[3];
const health = await fetch(new URL('/healthz', base), {signal:AbortSignal.timeout(5000)});
const state = await health.json();
if (!health.ok || state.service !== 'llm-auto-gateway' || !state.subscription) throw Error('A production Gateway with subscription support is required');
const models = await fetch(base.replace(/\/$/, '') + '/models', {signal:AbortSignal.timeout(5000)});
if (!models.ok || !(await models.json()).data.some(x => x.id === customModel)) throw Error(`Custom model is missing from Gateway: ${customModel}`);
NODE

source_catalog="${CODEX_APP_PROBE_CATALOG_SOURCE:-$codex_home/models_cache.json}"
[ -f "$source_catalog" ] || die "model catalog source does not exist: $source_catalog"

mkdir -p "$catalog_dir"
umask 077
tmp_config=""
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$backup_path" ] && [ ! -f "$state_path" ]; then
    cp -p "$backup_path" "$config_path" 2>/dev/null || true
    [ -f "$catalog_path" ] && rm -f "$catalog_path" || true
    rm -f "$backup_path" || true
  fi
  [ -z "$tmp_config" ] || rm -f "$tmp_config"
  exit "$status"
}
trap cleanup EXIT
cp -p "$config_path" "$backup_path"

CODEX_APP_PROBE_REPO_ROOT="$repo_root" \
CODEX_APP_PROBE_CATALOG_SOURCE="$source_catalog" \
CODEX_APP_PROBE_CATALOG_PATH="$catalog_path" \
CODEX_APP_PROBE_MODEL="$custom_model" \
CODEX_APP_PROBE_DISPLAY_NAME="$custom_display_name" \
GATEWAY_CONFIG="$gateway_config" \
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const source = process.env.CODEX_APP_PROBE_CATALOG_SOURCE;
const output = process.env.CODEX_APP_PROBE_CATALOG_PATH;
const catalog = JSON.parse(await readFile(source, "utf8"));
if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
  throw new Error("catalog source must contain a non-empty models array");
}

const { pathToFileURL } = await import("node:url");
const { buildModelCatalog } = await import(pathToFileURL(process.env.CODEX_APP_PROBE_REPO_ROOT + "/src/model-catalog.mjs"));
const { loadConfig } = await import(pathToFileURL(process.env.CODEX_APP_PROBE_REPO_ROOT + "/src/config.mjs"));
const config = await loadConfig(process.env.GATEWAY_CONFIG);
if (!config.subscription.customModels[process.env.CODEX_APP_PROBE_MODEL]) {
  throw new Error(`Selected custom model is not enabled for the App: ${process.env.CODEX_APP_PROBE_MODEL}`);
}
const updated = buildModelCatalog(catalog, config);
await writeFile(output, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
NODE

tmp_config="$(mktemp "$(dirname "$config_path")/.config.toml.llm-auto-gateway-app-probe.XXXXXX")"

awk -v base_url="$base_url" -v catalog_path="$catalog_path" -v custom_model="$custom_model" '
  function emit_probe() {
    print "# BEGIN llm-auto-gateway Codex App probe"
    print "model_provider = \"openai\""
    print "model = \"" custom_model "\""
    print "openai_base_url = \"" base_url "\""
    print "model_catalog_json = \"" catalog_path "\""
    print "# END llm-auto-gateway Codex App probe"
  }
  BEGIN { in_table = 0; emitted = 0 }
  /^[[:space:]]*\[/ {
    if (!emitted) { emit_probe(); emitted = 1 }
    in_table = 1
  }
  !in_table && $0 ~ /^[[:space:]]*(model_provider|model|openai_base_url|model_catalog_json)[[:space:]]*=/ { next }
  { print }
  END { if (!emitted) emit_probe() }
' "$config_path" > "$tmp_config"

config_mode="$(stat -f '%Lp' "$config_path")"
chmod "$config_mode" "$tmp_config"
mv "$tmp_config" "$config_path"
tmp_config=""

config_hash="$(shasum -a 256 "$config_path" | awk '{print $1}')"
cat > "$state_path" <<EOF
version=2
backup_hash=$(shasum -a 256 "$backup_path" | awk '{print $1}')
config_path=$config_path
backup_path=$backup_path
catalog_path=$catalog_path
config_hash=$config_hash
base_url=$base_url
custom_model=$custom_model
EOF
chmod 600 "$state_path"

printf 'Codex App probe configuration applied.\n'
printf 'config: %s\n' "$config_path"
printf 'backup: %s\n' "$backup_path"
printf 'catalog: %s\n' "$catalog_path"
printf 'model: %s\n' "$custom_model"
printf 'base URL: %s\n' "$base_url"
printf 'Restore with: %s/scripts/codex-app-probe-restore.sh\n' "$repo_root"
