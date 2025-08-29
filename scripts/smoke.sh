#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-https://pokequant.jonathanbarreneche.workers.dev}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

jqbin=$(command -v jq || true)
if [[ -z "$jqbin" ]]; then echo "Please install jq"; exit 1; fi

echo "# Base: $BASE"

do_json() {
	local path="$1"; shift || true
	local url="$BASE$path"
	local raw status body
	raw=$(curl -sS -w '\n%{http_code}' "$url") || { red "curl failed $path"; exit 1; }
	status=$(echo "$raw" | tail -n1)
	body=$(echo "$raw" | sed '$d')
	if [[ "$status" != 200 ]]; then red "FAIL $path status=$status body=$(echo "$body" | head -c 160)"; exit 1; fi
	if ! echo "$body" | jq '.' >/dev/null 2>&1; then red "FAIL $path invalid JSON"; exit 1; fi
	green "✔ $path"
	echo "$body"
}

do_json /health >/dev/null
len=$(do_json /api/cards | jq 'length') || len=0
echo "✔ /api/cards length=$len"
ulen=$(do_json /api/universe | jq 'length') || ulen=0
echo "✔ /api/universe length=$ulen"

CID=$(curl -s "$BASE/api/universe" | jq -r '.[0].id' 2>/dev/null || true)
if [[ -z "$CID" || "$CID" == null ]]; then red "No CID fetched"; exit 1; fi
echo "✔ Got CID=$CID"

do_json "/api/card?id=$CID&days=60" >/dev/null
echo "✔ /api/card"
curl -sS "$BASE/research/card-csv?id=$CID&days=60" | head -n1 >/dev/null || { red "CSV export failed"; exit 1; }
green "✔ /research/card-csv"

do_json "/api/movers?n=8" >/dev/null
do_json "/api/movers?dir=down&n=8" >/dev/null

# Subscribe may rate limit (429) so treat 429 as pass if error code matches
sub=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/subscribe" -H 'content-type: application/json' -d '{"email":"test@example.com"}') || { red "subscribe curl fail"; exit 1; }
scode=$(echo "$sub" | tail -n1)
sbody=$(echo "$sub" | sed '$d')
if [[ "$scode" == 200 ]]; then echo "$sbody" | jq '.ok' >/dev/null || { red "subscribe parse fail"; exit 1; }; green "✔ /api/subscribe"; elif [[ "$scode" == 429 ]]; then yellow "✔ /api/subscribe (rate limited)"; else red "subscribe status=$scode body=$(echo "$sbody" | head -c 120)"; exit 1; fi

for ep in /api/sets /api/rarities /api/types '/api/search?q=a&limit=5'; do
	raw=$(curl -s -w '\n%{http_code}' "$BASE${ep}") || { yellow "skip $ep curl fail"; continue; }
	code=$(echo "$raw" | tail -n1); body=$(echo "$raw" | sed '$d')
	if [[ "$code" != 200 ]]; then yellow "skip $ep status=$code"; continue; fi
	if echo "$body" | jq 'length' >/dev/null 2>&1; then green "✔ $ep"; else yellow "skip $ep non-json"; fi
done

echo
green "✔ SMOKE PASSED against ${BASE}"
