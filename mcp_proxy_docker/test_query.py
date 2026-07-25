import requests
import json
import sys

# Ensure UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

url = "http://localhost:1347/api/query"
headers = {"Content-Type": "application/json"}
payload = {
    "cypher": 'MATCH (n) WHERE n.name CONTAINS "JiujiPeisongController" RETURN n.name, labels(n) LIMIT 5',
    "repo": "oa-stock"
}

print(f"Querying {payload['repo']}...")
try:
    r = requests.post(url, headers=headers, json=payload)
    if r.status_code == 200:
        results = r.json().get("result", [])
        print(f"Found {len(results)} files:")
        for res in results:
            print(f"- {res}")
    else:
        print(f"Error: {r.status_code}, {r.text}")
except Exception as e:
    print(f"Failed: {e}")
