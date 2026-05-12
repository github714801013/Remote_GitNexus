import json
import os
import sys
from types import SimpleNamespace

from mcp_proxy_docker.app import executor
from mcp_proxy_docker.app import embedding_phase


def test_run_analyze_runs_structure_first_then_starts_embedding_phase(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    git_dir = repo / ".git"
    gitnexus_dir = repo / ".gitnexus"
    git_dir.mkdir(parents=True)
    gitnexus_dir.mkdir()
    (gitnexus_dir / "meta.json").write_text(
        json.dumps({"lastCommit": "old", "stats": {"embeddings": 0}}),
        encoding="utf-8",
    )

    commands = []
    started_embedding = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout="new\n", stderr="")
        if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd:
            return SimpleNamespace(returncode=0, stdout="indexed", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(executor.subprocess, "run", fake_run)
    monkeypatch.setattr(executor, "_probe_lbug", lambda _path, _env: (True, ""))
    monkeypatch.setattr(executor, "_start_embedding_phase", lambda *args: started_embedding.append(args))

    assert executor.run_analyze(str(repo), branch="main") is True

    analyze_commands = [cmd for cmd in commands if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd]
    assert analyze_commands == [["node", executor.GITNEXUS_BIN, "analyze", str(repo)]]
    assert started_embedding


def test_run_analyze_sets_configurable_node_heap(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".gitnexus").mkdir()

    analyze_env = {}

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout="new\n", stderr="")
        if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd:
            analyze_env.update(kwargs["env"])
            return SimpleNamespace(returncode=0, stdout="indexed", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setenv("GITNEXUS_ANALYZE_MAX_OLD_SPACE_MB", "24576")
    monkeypatch.setattr(executor.subprocess, "run", fake_run)
    monkeypatch.setattr(executor, "_start_embedding_phase", lambda *_args: None)

    assert executor.run_analyze(str(repo), branch="main") is True
    assert "--max-old-space-size=24576" in analyze_env["NODE_OPTIONS"]


def test_node_heap_env_preserves_existing_heap_setting():
    env = {"NODE_OPTIONS": "--trace-warnings --max-old-space-size=32768"}

    assert executor._with_node_heap_env(env)["NODE_OPTIONS"] == "--trace-warnings --max-old-space-size=32768"


def test_run_analyze_does_not_start_embedding_phase_when_structure_fails(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".gitnexus").mkdir()

    started_embedding = []

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout="new\n", stderr="")
        if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd:
            return SimpleNamespace(returncode=1, stdout="", stderr="boom")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(executor.subprocess, "run", fake_run)
    monkeypatch.setattr(executor, "_restore_latest_backup", lambda *_args: (False, "no backup"))
    monkeypatch.setattr(executor, "_start_embedding_phase", lambda *args: started_embedding.append(args))

    assert executor.run_analyze(str(repo), branch="main") is False
    assert started_embedding == []


def test_run_analyze_skips_duplicate_structure_when_embedding_is_running(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir()
    (gitnexus_dir / "meta.json").write_text(
        json.dumps({"lastCommit": "same", "stats": {"embeddings": 0}}),
        encoding="utf-8",
    )
    (gitnexus_dir / "embedding.pid").write_text("123", encoding="utf-8")
    (gitnexus_dir / "lbug.shadow.wal").write_text("leftover", encoding="utf-8")

    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout="same\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(executor.subprocess, "run", fake_run)
    monkeypatch.setattr(executor, "_probe_lbug", lambda _path, _env: (False, "Could not set lock"))
    monkeypatch.setattr(executor, "_process_is_running", lambda pid: pid == 123)
    monkeypatch.setattr(executor, "_process_is_embedding_phase", lambda pid: pid == 123)

    assert executor.run_analyze(str(repo), branch="main") == executor.DEFER_ANALYZE

    analyze_commands = [cmd for cmd in commands if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd]
    assert analyze_commands == []
    assert ["git", "fetch", "origin", "--depth", "1"] not in commands


def test_run_analyze_defers_structure_for_new_commit_when_embedding_is_running(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir()
    (gitnexus_dir / "meta.json").write_text(
        json.dumps({"lastCommit": "old", "stats": {"embeddings": 0}}),
        encoding="utf-8",
    )

    commands = []

    def fake_run(cmd, **kwargs):
        commands.append(cmd)
        if cmd[:2] == ["git", "rev-parse"]:
            return SimpleNamespace(returncode=0, stdout="new\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(executor.subprocess, "run", fake_run)
    monkeypatch.setattr(executor, "_embedding_phase_is_running", lambda _repo: True)

    assert executor.run_analyze(str(repo), branch="main") == executor.DEFER_ANALYZE

    analyze_commands = [cmd for cmd in commands if cmd[:2] == ["node", executor.GITNEXUS_BIN] and "analyze" in cmd]
    assert analyze_commands == []
    assert ["git", "fetch", "origin", "--depth", "1"] not in commands


def test_embedding_phase_is_running_when_lock_is_held(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setattr(executor.portalocker, "Lock", lambda *_args, **_kwargs: (_ for _ in ()).throw(executor.portalocker.exceptions.AlreadyLocked()))

    assert executor._embedding_phase_is_running(str(repo)) is True


def test_embedding_phase_marker_blocks_duplicate_running_process(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir(parents=True)
    (gitnexus_dir / "embedding.pid").write_text("123", encoding="utf-8")
    monkeypatch.setattr(executor, "_process_is_running", lambda pid: pid == 123)
    monkeypatch.setattr(executor, "_process_is_embedding_phase", lambda pid: pid == 123)

    assert executor._try_mark_embedding_phase(str(repo)) is False


def test_embedding_phase_marker_replaces_stale_pid(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir(parents=True)
    pid_file = gitnexus_dir / "embedding.pid"
    pid_file.write_text("123", encoding="utf-8")
    monkeypatch.setattr(executor, "_process_is_running", lambda _pid: False)

    assert executor._try_mark_embedding_phase(str(repo)) is True
    assert pid_file.read_text(encoding="utf-8")


def test_start_embedding_phase_records_child_pid(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir(parents=True)
    pid_file = gitnexus_dir / "embedding.pid"

    class FakeProcess:
        pid = 456

    monkeypatch.setattr(executor, "_try_mark_embedding_phase", lambda _repo: True)
    monkeypatch.setattr(executor.subprocess, "Popen", lambda *_args, **_kwargs: FakeProcess())
    monkeypatch.setenv("GITNEXUS_EMBEDDING_PHASE_LOG", str(tmp_path / "embedding.log"))

    executor._start_embedding_phase(str(repo), "/app/gitnexus.js", {})

    assert pid_file.read_text(encoding="utf-8") == "456"


def test_embedding_phase_marker_replaces_live_non_embedding_pid(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    gitnexus_dir = repo / ".gitnexus"
    gitnexus_dir.mkdir(parents=True)
    pid_file = gitnexus_dir / "embedding.pid"
    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    monkeypatch.setattr(executor, "_process_is_running", lambda _pid: True)
    monkeypatch.setattr(executor, "_process_is_embedding_phase", lambda _pid: False)

    assert executor._try_mark_embedding_phase(str(repo)) is True
    assert pid_file.read_text(encoding="utf-8")


def test_embedding_phase_uses_embeddings_only_command(monkeypatch, tmp_path):
    repo = tmp_path / "repo"
    (repo / ".gitnexus").mkdir(parents=True)
    captured = {}

    class DummyLock:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_run(cmd, **_kwargs):
        captured["cmd"] = cmd
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(sys, "argv", ["embedding_phase", str(repo), "/app/gitnexus.js"])
    monkeypatch.setattr(embedding_phase.portalocker, "Lock", DummyLock)
    monkeypatch.setattr(embedding_phase.subprocess, "run", fake_run)

    assert embedding_phase.main() == 0
    assert captured["cmd"] == [
        "node",
        "/app/gitnexus.js",
        "analyze",
        str(repo),
        "--embeddings-only",
        "--skip-agents-md",
    ]
