import requests
import json
import sys
import time

# Ensure UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

url = "http://localhost:1347/api/search"
headers = {"Content-Type": "application/json"}

query = "配送经纬度上报"
repos = ["oa-stock"]

for repo in repos:
    payload = {
        "query": query,
        "repo": repo,
        "mode": "semantic",
        "limit": 5
    }

    print(f"\n--- Searching in {repo} for: '{query}' ---")
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=300)
        if r.status_code == 200:
            results = r.json().get("results", [])
            if not results:
                print("No results found.")
            for i, res in enumerate(results):
                print(f"{i+1}. [{res.get('sources', [])}] {res.get('nodeId')}")
                print(f"   Path: {res.get('filePath')}")
                snippet = res.get('snippet', '')
                if snippet:
                    print(f"   Snippet: {snippet[:200]}...")
        else:
            print(f"Error: {r.status_code}, {r.text}")
    except Exception as e:
        print(f"Failed: {e}")
