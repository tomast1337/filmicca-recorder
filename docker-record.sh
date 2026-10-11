#!/usr/bin/env bash
# Usage: ./docker-record.sh <watch-url> [<watch-url> ...] [--file urls.txt] [--test seconds]
#
# Records each film inside Docker (private screen + sound: nothing on your
# computer can leak in, and you can keep using the machine). With several
# URLs they are recorded one after another; a failure does not stop the rest,
# and a summary is printed at the end.
#
# urls.txt: one watch URL per line; blank lines and lines starting with # are ignored.
set -uo pipefail
cd "$(dirname "$0")"

usage() { echo "usage: $0 <watch-url> [<watch-url> ...] [--file urls.txt] [--test seconds]"; exit 1; }

urls=()
test_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      [[ $# -ge 2 && -f "$2" ]] || { echo "--file needs an existing file"; exit 1; }
      while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"; line="$(echo "$line" | xargs)"
        [[ -n "$line" ]] && urls+=("$line")
      done < "$2"
      shift 2 ;;
    --test)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { echo "--test needs a number of seconds"; exit 1; }
      test_args=(--test "$2"); shift 2 ;;
    http*) urls+=("$1"); shift ;;
    *) echo "unknown argument: $1"; usage ;;
  esac
done

[[ ${#urls[@]} -ge 1 ]] || usage
[[ -f .env ]] || { echo "missing .env (FILMICCA_EMAIL, FILMICCA_PASSWORD)"; exit 1; }
mkdir -p downloads

# Drop duplicate URLs, keep order.
declare -A seen
unique=()
for u in "${urls[@]}"; do
  [[ -n "${seen[$u]:-}" ]] && { echo "skipping duplicate: $u"; continue; }
  seen[$u]=1; unique+=("$u")
done
urls=("${unique[@]}")

if [[ -z "$(docker images -q filmicca-rec 2>/dev/null)" || "${REBUILD:-}" == 1 ]]; then
  echo "building image (first time only, a few minutes)..."
  docker build -f docker/Dockerfile --build-arg UID="$(id -u)" -t filmicca-rec . || exit 1
fi

ok=(); failed=()
total=${#urls[@]}
trap 'echo; echo "interrupted"; break_all=1' INT

i=0
for url in "${urls[@]}"; do
  i=$((i + 1))
  [[ -n "${break_all:-}" ]] && break
  echo
  echo "=============================================================="
  echo " Film $i of $total: $url"
  echo "=============================================================="
  # Named volume keeps the Chrome profile (login, Widevine) between runs.
  if docker run --rm --shm-size=2g \
      --env-file .env \
      -v filmicca-profile:/home/rec/profile \
      -v "$PWD/downloads:/out" \
      filmicca-rec "$url" "${test_args[@]}"; then
    ok+=("$url")
  else
    failed+=("$url")
    echo "!! failed: $url (continuing with the next one)"
  fi
done

echo
echo "=============================================================="
echo " Summary: ${#ok[@]} ok, ${#failed[@]} failed, $((total - ${#ok[@]} - ${#failed[@]})) not run"
for u in "${ok[@]}"; do echo "  ✓ $u"; done
for u in "${failed[@]}"; do echo "  ✗ $u"; done
echo "=============================================================="
[[ ${#failed[@]} -eq 0 && -z "${break_all:-}" ]]
