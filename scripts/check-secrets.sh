#!/usr/bin/env bash
# Refuses to continue when tracked files, or commits not yet on origin, contain something that looks like a secret.
# Run before every push:  bun run check:secrets && git push
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PATTERN='gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|postgres(ql)?://[^:/ "]+:[^@ "$]{6,}@[a-z]|-----BEGIN [A-Z ]*PRIVATE KEY-----'
# Obvious placeholders used in tests and docs.
ALLOW=':(secret|password|postgres|changeme)@'
EXCL=(-- . ':!scripts/check-secrets.sh' ':!*.lock')
found=0
hits=$(git grep -nIE "$PATTERN" "${EXCL[@]}" | grep -vE "$ALLOW" | cut -d: -f1 | sort -u || true)
if [ -n "$hits" ]; then echo "Secret-like text in tracked files (values hidden):"; echo "$hits"; found=1; fi
base=$(git rev-parse --verify -q '@{upstream}' 2>/dev/null || true)
range=${base:+$base..HEAD}
commits=$(git log ${range:-HEAD} -p --format='commit %h' "${EXCL[@]}" | grep -E "^(commit |\+)" | grep -vE "$ALLOW" \
  | awk -v p="$PATTERN" '/^commit /{c=$2; next} $0 ~ p {print c}' | sort -u || true)
if [ -n "$commits" ]; then echo "Secret-like text in commits not yet pushed (${range:-all history}):"; echo "$commits"; found=1; fi
for f in $(git ls-files); do case "$(basename "$f")" in .env|.env.*) [ "$(basename "$f")" = .env.example ] || { echo "Tracked env file: $f"; found=1; };; esac; done
if [ "$found" = 1 ]; then echo "Not safe to push. Remove the secret (and rewrite unpushed commits), then rotate the key."; exit 1; fi
echo "No secrets found in tracked files or unpushed commits."
