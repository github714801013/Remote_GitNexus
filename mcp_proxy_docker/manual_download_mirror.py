import os
import sys
import requests
from tqdm import tqdm

# Ensure UTF-8 output
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8')

# Target model
repo_id = "twright8/gte-Qwen2-1.5B-instruct-onnx-fp16"
# Use mirror
base_url = f"https://hf-mirror.com/{repo_id}/resolve/main/"
local_dir = "mcp_proxy_docker/models/twright8/gte-Qwen2-1.5B-instruct-onnx-fp16"

files = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "model.onnx",
    "model.onnx_data"
]

def download_file(url, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Important: follow redirects for LFS files
    response = requests.get(url, stream=True, allow_redirects=True)
    response.raise_for_status()

    total_size = int(response.headers.get('content-length', 0))

    print(f"Downloading {url} to {path}")
    print(f"Total size: {total_size / 1024 / 1024:.2f} MB")

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
        # Map some files to onnx/ subfolder for transformers.js compatibility
        target_f = f
        if f.startswith("model.onnx"):
            target_f = "onnx/" + f

        path = os.path.join(local_dir, target_f.replace("/", os.sep))

        if os.path.exists(path) and os.path.getsize(path) > 1000:
            if "model.onnx" not in f:
                print(f"Skipping {f}, already exists.")
                continue

        print(f"\nChecking {f}...")
        try:
            download_file(url, path)
        except Exception as e:
            print(f"Failed to download {f}: {e}")
