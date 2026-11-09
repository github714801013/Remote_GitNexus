import requests
import json
import sys
import time

# Ensure UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

url = "http://localhost:1347/api/search"
headers = {"Content-Type": "application/json"}
payload = {
    "query": "配送",
    "repo": "oa-stock",
    "mode": "semantic",
    "limit": 5
}

print(f"Searching for: {payload['query']} in {payload['repo']} (Mode: {payload['mode']})...")
print("Note: First semantic search will trigger model loading (10-20s)...")

start = time.time()
try:
    r = requests.post(url, headers=headers, json=payload, timeout=60)
    elapsed = time.time() - start
    if r.status_code == 200:
        results = r.json().get("results", [])
        print(f"Found {len(results)} results in {elapsed:.2f}s:")
        for i, res in enumerate(results):
            print(f"{i+1}. [{res.get('sources', [])}] {res.get('nodeId')} - {res.get('filePath')}")
    else:
        print(f"Error: {r.status_code}, {r.text}")
except Exception as e:
    print(f"Failed: {e}")
