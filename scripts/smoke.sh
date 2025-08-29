#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-https://pokequant.jonathanbarreneche.workers.dev}"

jqbin=$(command -v jq || true)
if [[ -z "$jqbin" ]]; then echo "Please install jq"; exit 1; fi

echo "✔ /health"; curl -s "$BASE/health" | jq . >/dev/null
len=$(curl -s "$BASE/api/cards" | jq 'length')
echo "✔ /api/cards length=$len"
ulen=$(curl -s "$BASE/api/universe" | jq 'length')
echo "✔ /api/universe length=$ulen"

CID=$(curl -s "$BASE/api/universe" | jq -r '.[0].id')
echo "✔ Got CID=$CID"

echo "✔ /api/card"; curl -s "$BASE/api/card?id=$CID&days=60" | jq '.ok' >/dev/null
echo "✔ /research/card-csv"; curl -s "$BASE/research/card-csv?id=$CID&days=60" | head -n 1 >/dev/null
echo "✔ /api/movers"; curl -s "$BASE/api/movers?n=8" | jq 'length' >/dev/null
echo "✔ /api/movers?dir=down"; curl -s "$BASE/api/movers?dir=down&n=8" | jq 'length' >/dev/null
echo "✔ /api/subscribe"; curl -s -X POST "$BASE/api/subscribe" -H 'content-type: application/json' -d '{"email":"test@example.com"}' | jq '.ok' >/dev/null

echo "✔ /api/sets"; curl -s "$BASE/api/sets" | jq 'length' >/dev/null
echo "✔ /api/rarities"; curl -s "$BASE/api/rarities" | jq 'length' >/dev/null
echo "✔ /api/types"; curl -s "$BASE/api/types" | jq 'length' >/dev/null
echo "✔ /api/search?q=a"; curl -s "$BASE/api/search?q=a&limit=5" | jq 'length' >/dev/null

echo
echo "✔ SMOKE PASSED against ${BASE}"
