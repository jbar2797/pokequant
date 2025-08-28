"""
Fetch Google Trends (SVI) for your card universe and POST it to the Worker.

Key change for bootstrap:
- Use /api/universe (raw cards) instead of /api/cards (which only shows cards with signals).
  This ensures we start populating SVI on day one.

Environment variables (set by GitHub Actions workflow):
- INGEST_URL    -> https://<your-worker>.workers.dev/ingest/trends
- INGEST_TOKEN  -> the same secret you set in Cloudflare (x-ingest-token)
"""

import os
import time
import requests
from pytrends.request import TrendReq

INGEST_URL = os.environ["INGEST_URL"]
INGEST_TOKEN = os.environ["INGEST_TOKEN"]

def get_universe():
    """
    Return a list of card dicts from the Worker. Prefer /api/universe.
    If (unexpectedly) empty, fall back to /api/cards.
    """
    try:
        url = INGEST_URL.replace("/ingest/trends", "/api/universe")
        r = requests.get(url, timeout=30)
        data = r.json() if r.ok else []
        if isinstance(data, list) and len(data) > 0:
            return data
    except Exception as e:
        print("universe fetch error:", e)

    # Fallback (shouldn't be needed after bootstrap, but harmless)
    try:
        url = INGEST_URL.replace("/ingest/trends", "/api/cards")
        r = requests.get(url, timeout=30)
        data = r.json() if r.ok else []
        if isinstance(data, list):
            return data
    except Exception as e:
        print("cards fallback fetch error:", e)

    return []

def make_query(card: dict) -> str:
    """
    Build a Trends term for the card, capped to ~70 chars.
    Note: /api/universe does NOT include `number` by default, so we guard it.
    """
    parts = []
    name = card.get("name")
    number = card.get("number")         # may be missing in /api/universe response
    set_name = card.get("set_name")

    if name: parts.append(str(name))
    if number: parts.append(str(number))
    if set_name: parts.append(str(set_name))

    # Anchor to the right concept:
    parts.append("pokemon card")

    q = " ".join(parts)
    return q[:70]

def chunked(lst, k):
    for i in range(0, len(lst), k):
        yield lst[i:i+k]

def main():
    # 1) Get the card universe
    cards = get_universe()
    if not cards:
        print("No cards available from API (/api/universe and fallback /api/cards empty). Exiting.")
        return

    # 2) Build up to ~60 queries/day (be gentle)
    #    Trends allows up to 5 terms per request payload.
    terms = []
    seen_ids = set()
    for c in cards:
        cid = c.get("id")
        if not cid or cid in seen_ids:
            continue
        seen_ids.add(cid)
        terms.append((cid, make_query(c)))
        if len(terms) >= 60:
            break

    if not terms:
        print("No usable terms constructed. Exiting.")
        return

    print(f"Prepared {len(terms)} card terms for Trends.")

    # 3) Pull SVI via PyTrends
    pytrends = TrendReq(hl="en-US", tz=0)
    rows = []

    for batch in chunked(terms, 5):  # 5 terms per request
        kw_list = [t[1] for t in batch]
        try:
            # 'today 3-m' => last ~90 days; returns a daily indexed DataFrame
            pytrends.build_payload(kw_list, timeframe="today 3-m")
            df = pytrends.interest_over_time()
            if df.empty:
                print("Empty Trends frame for batch; sleeping briefly and continuing.")
                time.sleep(2)
                continue

            as_ofs = [d.strftime("%Y-%m-%d") for d in df.index.to_pydatetime()]

            for (card_id, term) in batch:
                if term not in df.columns:
                    continue
                series = df[term].tolist()
                for i, svi in enumerate(series):
                    # SVI is 0..100 normalized integer values
                    try:
                        svi_val = int(svi)
                    except Exception:
                        continue
                    rows.append({"card_id": card_id, "as_of": as_ofs[i], "svi": svi_val})

            # Be polite to Trends
            time.sleep(2)

        except Exception as e:
            print("Batch error:", e)
            time.sleep(5)

    if not rows:
        print("No rows to ingest (no SVI points collected). Exiting.")
        return

    # 4) POST to the Worker ingest endpoint
    try:
        r = requests.post(
            INGEST_URL,
            json={"rows": rows},
            headers={"x-ingest-token": INGEST_TOKEN},
            timeout=60
        )
        print("Ingest status:", r.status_code, r.text)
    except Exception as e:
        print("Ingest POST error:", e)

if __name__ == "__main__":
    main()
