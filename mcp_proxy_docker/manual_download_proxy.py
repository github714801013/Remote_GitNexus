import os
import sys
import requests
from tqdm import tqdm

# Ensure UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

# Proxy configuration
proxies = {
    "http": "http://10.1.14.185:10808",
    "https": "http://10.1.14.185:10808",
}

# Target model
repo_id = "twright8/gte-Qwen2-1.5B-instruct-onnx-fp16"
# Use original HF since we have a proxy
base_url = f"https://huggingface.co/{repo_id}/resolve/main/"
local_dir = "mcp_proxy_docker/models/twright8/gte-Qwen2-1.5B-instruct-onnx-fp16"

files = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "onnx/model.onnx",
    "onnx/model.onnx_data"
]

def download_file(url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Using verify=False if there are SSL issues with the proxy,
    # but let's try standard first.
    response = requests.get(url, stream=True, proxies=proxies)
    response.raise_for_status() # Check for HTTP errors

    total_size = int(response.headers.get('content-length', 0))

    print(f"Downloading {url} to {path}")
    with open(path, "wb") as f, tqdm(
        total=total_size,
        unit='iB',
        unit_scale=True,
        desc=os.path.basename(path)
    ) as pbar:
        for data in response.iter_content(chunk_size=1024*1024):
            size = f.write(data)
            pbar.update(size)

if __name__ == "__main__":
    for f in files:
        url = base_url + f
        path = os.path.join(local_dir, f.replace("/", os.sep))
        print(f"Checking {f}...")
        try:
            download_file(url, path)
        except Exception as e:
            print(f"Failed to download {f}: {e}")
