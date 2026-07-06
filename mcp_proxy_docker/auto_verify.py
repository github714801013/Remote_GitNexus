import time
import sys
import json
import os
from urllib import request
from urllib.error import URLError, HTTPError

# 配置
API_URL = "http://localhost:1347/api/repos"

LOCAL_REPOS = "repos.json"
REMOTE_REPOS = "/home/ji99/gitnexus/repos.json"

repos_dict = {}

# 加载远端运行环境现有的项目配置（来自真实 Webhook 更新或历史记录）
if os.path.exists(REMOTE_REPOS):
    try:
        with open(REMOTE_REPOS, "r", encoding="utf-8") as f:
            for r in json.load(f):
                if r.get("full_name"):
                    repos_dict[r["full_name"]] = r
    except Exception as e:
        print(f"读取远程 repos.json 失败: {e}")

# 加载本地部署包带过来的配置，如果存在相同项目，则跳过不覆盖，只追加新项目
if os.path.exists(LOCAL_REPOS):
    try:
        with open(LOCAL_REPOS, "r", encoding="utf-8") as f:
            for r in json.load(f):
                if r.get("full_name") and r["full_name"] not in repos_dict:
                    repos_dict[r["full_name"]] = r
    except Exception as e:
        print(f"读取本地 repos.json 失败: {e}")

REPOS = list(repos_dict.values())

# 将合并后的配置写回远程文件，作为源配置
try:
    with open(REMOTE_REPOS, "w", encoding="utf-8") as f:
        json.dump(REPOS, f, indent=2, ensure_ascii=False)
except Exception as e:
    print(f"同步写入 {REMOTE_REPOS} 失败: {e}")

def wait_for_ready(url, name, timeout=60):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with request.urlopen(url, timeout=2) as r:
                if r.status < 500:
                    print(f"服务 {name} 已就绪 ({url})")
                    return True
        except HTTPError as e:
            if e.code < 500:
                print(f"服务 {name} 已就绪 ({url})")
                return True
        except (ConnectionResetError, TimeoutError, OSError, URLError):
            pass
        time.sleep(2)
    print(f"错误: 服务 {name} 启动超时")
    return False

def print_indexing_snapshot():
    print("--- 索引快照 ---")
    target_names = [r['full_name'].split('/')[-1] for r in REPOS]
    try:
        with request.urlopen(API_URL, timeout=10) as r:
            status_code = r.status
            body = r.read().decode("utf-8")
        if status_code != 200:
            print(f"API 返回异常: {status_code}")
            return False

        repos = json.loads(body)
        indexed_names = {res['name']: res.get('stats', {}).get('nodes', 0) for res in repos}
        for name in target_names:
            nodes = indexed_names.get(name, 0)
            status = "完成" if nodes > 0 else "后台处理中或未索引"
            print(f"  - {name}: {nodes} 节点 {status}")
        return True
    except Exception as e:
        print(f"读取索引快照失败: {e}")
        return False

if __name__ == "__main__":
    if not wait_for_ready("http://localhost:1347/health", "API", 60):
        sys.exit(1)

    if not print_indexing_snapshot():
        sys.exit(1)
    sys.exit(0)
