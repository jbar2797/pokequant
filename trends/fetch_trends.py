import os, time, json, random, math
from datetime import datetime
import requests
from pytrends.request import TrendReq

# ---- Config from env (required) ----
INGEST_URL   = os.environ['INGEST_URL']   # e.g. https://pokequant.<you>.workers.dev/ingest/trends
INGEST_TOKEN = os.environ['INGEST_TOKEN'] # set in GitHub secrets

# Optional knobs (safe defaults)
MAX_CARDS      = int(os.getenv('MAX_CARDS', '250'))   # how many cards to process
BATCH_SIZE     = int(os.getenv('BATCH_SIZE', '5'))    # pytrends supports up to 5 per call
SLEEP_BASE_SEC = float(os.getenv('SLEEP_BASE_SEC', '3.5'))  # base delay between pytrends calls
TIMEFRAME      = os.getenv('TIMEFRAME', 'today 12-m') # backfill 12 months

# Derive universe URL from ingest URL (works across envs)
UNIVERSE_URL = os.getenv('UNIVERSE_URL',
                         INGEST_URL.replace('/ingest/trends', '/api/universe'))

def make_query(card):
    """
    Build a short, specific query for Google Trends.
    Keep it deterministic so backfills are consistent.
    """
    parts = []
    if card.get('name'): parts.append(card['name'])
    if card.get('number'): parts.append(str(card['number']))
    if card.get('set_name'): parts.append(card['set_name'])
    parts.append("pokemon card")
    q = " ".join(parts)
    return q[:70]

def chunked(lst, k):
    for i in range(0, len(lst), k):
        yield lst[i:i+k]

def backoff_sleep(base=SLEEP_BASE_SEC, factor=1.0):
    # add jitter to avoid rate limit patterns
    jitter = random.uniform(0.6, 1.4)
    time.sleep(base * factor * jitter)

def post_rows(rows):
    if not rows:
        return
    # POST a small batch to avoid large payloads; Cloudflare Worker limit ~10MB req body
    r = requests.post(
        INGEST_URL,
        json={ "rows": rows },
        headers={ "x-ingest-token": INGEST_TOKEN, "content-type": "application/json" },
        timeout=60
    )
    if r.status_code >= 300:
        raise RuntimeError(f"ingest failed {r.status_code} {r.text[:200]}")

def main():
    # 1) Pull universe
    print(f"[info] Fetching universe from {UNIVERSE_URL}")
    u = requests.get(UNIVERSE_URL, timeout=60).json()
    cards = u if isinstance(u, list) else []
    if not cards:
        print("[warn] No cards from /api/universe; exiting.")
        return
    cards = cards[:MAX_CARDS]
    print(f"[info] Will process {len(cards)} cards")

    # 2) Build term list
    terms = [(c['id'], make_query(c)) for c in cards]

    # 3) PyTrends session
    pytrends = TrendReq(hl='en-US', tz=0)

    # 4) Process in batches of 5; POST each batch's rows immediately
    total_rows = 0
    batches = list(chunked(terms, BATCH_SIZE))
    for bi, batch in enumerate(batches, 1):
        kw_list = [t[1] for t in batch]
        # retry loop for transient errors
        for attempt in range(4):
            try:
                pytrends.build_payload(kw_list, timeframe=TIMEFRAME)
                df = pytrends.interest_over_time()
                if df is None or df.empty:
                    print(f"[warn] empty Trends for batch {bi}/{len(batches)}; continuing")
                    break
                as_ofs = [d.strftime('%Y-%m-%d') for d in df.index.to_pydatetime()]
                rows = []
                for (card_id, term) in batch:
                    if term not in df.columns:
                        continue
                    series = df[term].tolist()
                    for i, svi in enumerate(series):
                        rows.append({ "card_id": card_id, "as_of": as_ofs[i], "svi": int(svi) })
                if rows:
                    post_rows(rows)
                    total_rows += len(rows)
                print(f"[info] batch {bi}/{len(batches)} → rows={len(rows)}, total={total_rows}")
                break  # success; exit retry loop
            except Exception as e:
                wait = (attempt + 1)
                print(f"[warn] batch {bi} attempt {attempt+1} failed: {e}; sleeping {wait}s")
                backoff_sleep(base=wait)
        # polite pause before next batch
        backoff_sleep()
    print(f"[done] ingested rows (approx): {total_rows}")

if __name__ == "__main__":
    main()
