#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE:-${1:-}}"
if [[ -z "$BASE" ]]; then
  echo "Usage: BASE=https://pokequant.<you>.workers.dev scripts/smoke.sh"
  exit 2
fi

err() { echo "✖ $*" >&2; exit 1; }
ok()  { echo "✔ $*"; }

# 1) Health
h=$(curl -fsS "$BASE/health" | jq -r '.ok'); [[ "$h" == "true" ]] || err "/health not ok"
ok "/health"

# 2) Cards with signals (or 0 if very early)
cards_json=$(curl -fsS "$BASE/api/cards")
cards_len=$(echo "$cards_json" | jq 'length')
ok "/api/cards length=$cards_len"

# 3) Universe fallback always non-empty
u_json=$(curl -fsS "$BASE/api/universe")
u_len=$(echo "$u_json" | jq 'length')
[[ "$u_len" -ge 1 ]] || err "/api/universe empty"
ok "/api/universe length=$u_len"

# 4) Pick a CID from cards if available, else from universe
CID=$(echo "$cards_json" | jq -r '.[0].id // empty')
if [[ -z "$CID" ]]; then
  CID=$(echo "$u_json" | jq -r '.[0].id')
fi
[[ -n "$CID" ]] || err "Could not determine a card id"
ok "Got CID=$CID"

# 5) Single card details
det_ok=$(curl -fsS "$BASE/api/card?id=$CID&days=60" | jq -r '.ok')
[[ "$det_ok" == "true" ]] || err "/api/card not ok"
ok "/api/card"

# 6) CSV export returns header row
csv_head=$(curl -fsS "$BASE/research/card-csv?id=$CID&days=60" | head -n 1)
echo "$csv_head" | grep -q '^date,price_usd,price_eur' || err "CSV header mismatch"
ok "/research/card-csv"

# 7) Movers (may be empty early; not fatal if length==0 but endpoint must 200)
curl -fsS "$BASE/api/movers?n=12" >/dev/null
ok "/api/movers"

# 8) Subscribe (ok even if email duplicate)
ts=$(date +%s)
curl -fsS -X POST "$BASE/api/subscribe" \
  -H 'content-type: application/json' \
  -d '{"email":"smoke+'"$ts"'@example.com"}' >/dev/null
ok "/api/subscribe"

# 9) Portfolio create and read empty
pf=$(curl -fsS -X POST "$BASE/portfolio/create")
PID=$(echo "$pf" | jq -r .id)
PKEY=$(echo "$pf" | jq -r .secret)
[[ -n "$PID" && -n "$PKEY" ]] || err "/portfolio/create missing id or secret"

curl -fsS "$BASE/portfolio" \
  -H "x-portfolio-id: $PID" \
  -H "x-portfolio-secret: $PKEY" >/dev/null
ok "Portfolio create & read"

echo
ok "SMOKE PASSED against $BASE"
