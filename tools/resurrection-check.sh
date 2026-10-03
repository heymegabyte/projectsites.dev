#!/usr/bin/env bash
# tools/resurrection-check.sh
# Resurrection Guard — fails if a homepage-ish file exists that isn't in
# .cleanup-allowlist. See v2 doctrine §22.
#
# Usage:
#   bash tools/resurrection-check.sh            # scan whole repo
#   bash tools/resurrection-check.sh --staged   # scan only staged changes
#
# Exit codes:
#   0 — clean
#   1 — offenders found
#   2 — misuse / config error

set -u
set -o pipefail

# ---- colors (only on TTY) -----------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_CYAN=$'\033[0;36m'
  C_BOLD=$'\033[1m'
  C_RESET=$'\033[0m'
else
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_CYAN=""
  C_BOLD=""
  C_RESET=""
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST_FILE="$REPO_ROOT/.cleanup-allowlist"
MODE="full"

for arg in "$@"; do
  case "$arg" in
    --staged) MODE="staged" ;;
    --help|-h)
      echo "Usage: $0 [--staged]"
      echo "  --staged  Only scan files staged for commit."
      exit 0
      ;;
    *)
      printf '%sError:%s unknown argument: %s\n' "$C_RED" "$C_RESET" "$arg" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ALLOWLIST_FILE" ]; then
  printf '%sError:%s .cleanup-allowlist not found at %s\n' "$C_RED" "$C_RESET" "$ALLOWLIST_FILE" >&2
  exit 2
fi

cd "$REPO_ROOT" || exit 2

# ---- load allowlist -----------------------------------------------------
ALLOWLIST_EXACT=()
ALLOWLIST_GLOBS=()
while IFS= read -r line || [ -n "$line" ]; do
  # strip CR, leading/trailing whitespace
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  case "$line" in
    \#*) continue ;;
    glob:*) ALLOWLIST_GLOBS+=("${line#glob:}") ;;
    *) ALLOWLIST_EXACT+=("$line") ;;
  esac
done < "$ALLOWLIST_FILE"

is_allowed() {
  local path="$1"
  local entry
  for entry in "${ALLOWLIST_EXACT[@]}"; do
    [ "$path" = "$entry" ] && return 0
  done
  # shellcheck disable=SC2053
  for entry in "${ALLOWLIST_GLOBS[@]}"; do
    case "$path" in
      $entry) return 0 ;;
    esac
  done
  return 1
}

# ---- candidate-file discovery -------------------------------------------
# Filename patterns considered "homepage-ish".
NAME_PATTERNS=(
  -iname 'home*.html'
  -o -iname 'home*.ts'
  -o -iname 'home*.tsx'
  -o -iname 'home*.scss'
  -o -iname 'home*.css'
  -o -iname 'home*.vue'
  -o -iname 'home*.svelte'
  -o -iname 'homepage*'
  -o -iname 'landing*.html'
  -o -iname 'landing*.ts'
  -o -iname 'landing*.tsx'
  -o -iname 'landing*.scss'
  -o -iname 'marketing-home*'
)

EXCLUDE_DIRS=(
  './node_modules'
  './.git'
  './.nx'
  './.next'
  './dist'
  './build'
  './out'
  './coverage'
  './.claude'
  './.turbo'
  './.cache'
)

build_prune_expr() {
  # Prune by directory BASENAME at ANY depth, not just the repo root. The old
  # `-path './coverage'` only matched a top-level ./coverage, so nested build
  # artifacts like ./apps/project-sites/coverage (from `jest --coverage`),
  # ./apps/project-sites/dist, or any nested node_modules were scanned — a
  # generated coverage HTML report (contains <!doctype html>) then false-flagged
  # as a "legacy homepage" and blocked `git push` via the pre-push hook.
  local first=1 name
  for d in "${EXCLUDE_DIRS[@]}"; do
    name="${d##*/}" # ./coverage -> coverage ; ./.claude/worktrees -> worktrees
    if [ $first -eq 1 ]; then
      printf -- '-type d -name %s' "$name"
      first=0
    else
      printf -- ' -o -type d -name %s' "$name"
    fi
  done
}

candidates_full() {
  # shellcheck disable=SC2046
  find . \( $(build_prune_expr) \) -prune -o \
    -type f \( "${NAME_PATTERNS[@]}" \) \
    -not -name '*.lock' \
    -not -name '*.test.*' \
    -not -name '*.spec.*' \
    -not -name '*.e2e.*' \
    -print 2>/dev/null \
    | sed 's|^\./||' \
    | sort -u
}

candidates_staged() {
  if ! command -v git >/dev/null 2>&1; then
    printf '%sError:%s git not available for --staged mode\n' "$C_RED" "$C_RESET" >&2
    exit 2
  fi
  git diff --cached --name-only --diff-filter=ACMR \
    | grep -iE '(home|homepage|landing|marketing-home).*\.(html|ts|tsx|scss|css|vue|svelte)$' \
    | grep -viE '\.(test|spec|e2e)\.' \
    | sort -u
}

# ---- content-string scan (existing files only) --------------------------
content_offenders() {
  local files
  # shellcheck disable=SC2046
  files=$(find . \( $(build_prune_expr) \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.html' -o -name '*.vue' -o -name '*.svelte' \) \
    -not -name '*.test.*' -not -name '*.spec.*' -not -name '*.e2e.*' \
    -print 2>/dev/null)
  if [ -z "$files" ]; then
    return 0
  fi
  printf '%s\n' $files \
    | xargs grep -lE 'class HomeComponent\b|class LandingPage\b|class MarketingHome\b|<homepage[ />]' 2>/dev/null \
    | sed 's|^\./||' \
    | sort -u
}

# ---- run scan -----------------------------------------------------------
printf '%s%sResurrection Guard%s scanning repo at %s (mode=%s)\n' "$C_BOLD" "$C_CYAN" "$C_RESET" "$REPO_ROOT" "$MODE"

if [ "$MODE" = "staged" ]; then
  CANDIDATES=$(candidates_staged)
else
  CANDIDATES=$(candidates_full)
  CONTENT_MATCHES=$(content_offenders)
  if [ -n "$CONTENT_MATCHES" ]; then
    CANDIDATES=$(printf '%s\n%s\n' "$CANDIDATES" "$CONTENT_MATCHES" | sort -u | sed '/^$/d')
  fi
fi

OFFENDERS=()
if [ -n "${CANDIDATES:-}" ]; then
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if ! is_allowed "$path"; then
      OFFENDERS+=("$path")
    fi
  done <<< "$CANDIDATES"
fi

# ---- report -------------------------------------------------------------
if [ ${#OFFENDERS[@]} -eq 0 ]; then
  printf '%s✓ Resurrection Guard: clean.%s No unauthorized homepage-ish files found.\n' "$C_GREEN" "$C_RESET"
  exit 0
fi

printf '%s✗ Resurrection Guard: %d offender(s) found.%s\n' "$C_RED" "${#OFFENDERS[@]}" "$C_RESET"
printf '\n%sOffenders (file:line:context):%s\n' "$C_YELLOW" "$C_RESET"
for path in "${OFFENDERS[@]}"; do
  if [ -f "$path" ]; then
    # surface the first 3 non-blank lines as "context"
    nl=1
    while IFS= read -r line && [ "$nl" -le 3 ]; do
      stripped="${line#"${line%%[![:space:]]*}"}"
      if [ -n "$stripped" ]; then
        printf '  %s%s%s:%d: %s\n' "$C_RED" "$path" "$C_RESET" "$nl" "$stripped"
      fi
      nl=$((nl + 1))
    done < "$path"
  else
    printf '  %s%s%s:0: (staged for add, not yet on disk)\n' "$C_RED" "$path" "$C_RESET"
  fi
done

cat <<EOF

${C_YELLOW}How to fix:${C_RESET}
  1. If the file is legitimate, add its path to ${C_CYAN}.cleanup-allowlist${C_RESET}.
  2. If it is a legacy resurrection, delete it and rerun the check.
  3. v2 doctrine §22: the canonical marketing home lives at
     ${C_CYAN}apps/web/src/app/pages/marketing-home/${C_RESET} — never elsewhere.

EOF
exit 1
