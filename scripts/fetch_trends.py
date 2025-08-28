import os, requests, time
from datetime import datetime
from pytrends.request import TrendReq

INGEST_URL = os.environ['INGEST_URL']  # e.g., https://pokequant.<you>.workers.dev/ingest/trends
INGEST_TOKEN = os.environ['INGEST_TOKEN']

def get_cards():
    try:
        # Pull whatever the API currently has (latest signals or empty)
        url = INGEST_URL.replace('/ingest/trends','/api/cards')
        r = requests.get(url, timeout=30)
        return r.json()
    except Exception:
        return []

def make_query(card):
    parts = []
    if card.get('name'): parts.append(card['name'])
    if card.get('number'): parts.append(card['number'])
    if card.get('set_name'): parts.append(card['set_name'])
    parts.append("pokemon card")
    q = " ".join(parts)
    return q[:70]  # keep term short for Trends

def chunked(lst, k):
    for i in range(0, len(lst), k):
        yield lst[i:i+k]

def main():
    cards = get_cards()
    if not cards:
        print("No cards yet; Trends will retry next run.")
        return

    rows = []
    pytrends = TrendReq(hl='en-US', tz=0)
    terms = [(c['id'], make_query(c)) for c in cards[:60]]  # be gentle

    for batch in chunked(terms, 5):  # PyTrends supports up to 5 terms per payload
        kw_list = [t[1] for t in batch]
        try:
            pytrends.build_payload(kw_list, timeframe='today 3-m')  # ~90 days
            df = pytrends.interest_over_time()
            if df.empty:
                time.sleep(2)
                continue
            as_ofs = [d.strftime('%Y-%m-%d') for d in df.index.to_pydatetime()]
            for (card_id, term) in batch:
                if term not in df.columns:
                    continue
                series = df[term].tolist()
                for i, svi in enumerate(series):
                    rows.append({ "card_id": card_id, "as_of": as_ofs[i], "svi": int(svi) })
            time.sleep(2)
        except Exception as e:
            print("Batch error:", e)
            time.sleep(5)

    if not rows:
        print("No rows to ingest.")
        return

    r = requests.post(INGEST_URL, json={ "rows": rows }, headers={ "x-ingest-token": INGEST_TOKEN }, timeout=60)
    print("Ingest status:", r.status_code, r.text)

if __name__ == "__main__":
    main()
