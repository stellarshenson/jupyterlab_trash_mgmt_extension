"""Tests for trash management routes and helper functions."""

import errno
import json
import os
import shutil
import threading
from datetime import datetime
from pathlib import Path

import pytest

from jupyterlab_trash_mgmt_extension import routes
from jupyterlab_trash_mgmt_extension.routes import (
    clear_dir_sizes,
    collect_sources,
    delete_item,
    empty_trash,
    format_size,
    get_dir_size,
    get_dir_size_cached,
    get_item_size,
    get_trash_dir,
    invalidate_dir_size,
    parse_trashinfo,
)

NAMESPACE = "jupyterlab-trash-mgmt-extension"


def make_trash(root: Path) -> Path:
    """Create a trash directory with its files and info folders."""
    (root / "files").mkdir(parents=True)
    (root / "info").mkdir()
    return root


def add_trash_item(trash: Path, name: str, original_path: str, content: str = "x") -> None:
    """Add one top-level entry and its trashinfo to a trash directory."""
    (trash / "files" / name).write_text(content)
    (trash / "info" / f"{name}.trashinfo").write_text(
        f"[Trash Info]\nPath={original_path}\nDeletionDate=2024-01-15T10:30:00\n"
    )


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_get_trash_dir_default(self, monkeypatch):
        """Test get_trash_dir returns correct path with default XDG_DATA_HOME."""
        monkeypatch.delenv("XDG_DATA_HOME", raising=False)
        trash_dir = get_trash_dir()
        expected = Path.home() / ".local" / "share" / "Trash"
        assert trash_dir == expected

    def test_get_trash_dir_custom(self, monkeypatch):
        """Test get_trash_dir respects XDG_DATA_HOME."""
        monkeypatch.setenv("XDG_DATA_HOME", "/custom/data")
        trash_dir = get_trash_dir()
        assert trash_dir == Path("/custom/data/Trash")

    def test_format_size_bytes(self):
        """Test format_size for small byte values."""
        assert format_size(0) == "0 B"
        assert format_size(100) == "100 B"
        assert format_size(1023) == "1023 B"

    def test_format_size_kilobytes(self):
        """Test format_size for kilobyte values."""
        assert format_size(1024) == "1.0 KB"
        assert format_size(1536) == "1.5 KB"

    def test_format_size_megabytes(self):
        """Test format_size for megabyte values."""
        assert format_size(1024 * 1024) == "1.0 MB"
        assert format_size(1024 * 1024 * 2.5) == "2.5 MB"

    def test_format_size_gigabytes(self):
        """Test format_size for gigabyte values."""
        assert format_size(1024 * 1024 * 1024) == "1.0 GB"

    def test_get_item_size_file(self, tmp_path):
        """Test get_item_size for a regular file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")
        size = get_item_size(test_file)
        assert size == 13  # "Hello, World!" is 13 bytes

    def test_get_item_size_directory(self, tmp_path):
        """Test get_item_size for a directory."""
        test_dir = tmp_path / "test_dir"
        test_dir.mkdir()
        (test_dir / "file1.txt").write_text("Hello")
        (test_dir / "file2.txt").write_text("World")
        size = get_item_size(test_dir)
        assert size == 10  # 5 + 5 bytes

    def test_get_item_size_directory_counts_symlinks_as_links(self, tmp_path):
        """Test get_item_size does not follow a symlink inside a directory."""
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "big.bin").write_bytes(b"x" * 100000)
        test_dir = tmp_path / "test_dir"
        test_dir.mkdir()
        (test_dir / "file.txt").write_text("Hello")
        file_link = test_dir / "file_link"
        dir_link = test_dir / "dir_link"
        file_link.symlink_to(outside / "big.bin")
        dir_link.symlink_to(outside)
        expected = 5 + file_link.lstat().st_size + dir_link.lstat().st_size
        assert get_item_size(test_dir) == expected

    def test_get_item_size_nonexistent(self, tmp_path):
        """Test get_item_size for non-existent path."""
        nonexistent = tmp_path / "nonexistent.txt"
        size = get_item_size(nonexistent)
        assert size == 0

    def test_cached_directory_size_equals_a_fresh_walk_with_a_symlink(self, tmp_path):
        """The cached size matches a fresh walk of the same folder, symlink included."""
        clear_dir_sizes()
        outside = tmp_path / "outside.bin"
        outside.write_bytes(b"x" * 100_000)
        folder = tmp_path / "folder"
        (folder / "sub").mkdir(parents=True)
        (folder / "sub" / "file.txt").write_bytes(b"12345")
        os.symlink(outside, folder / "link")

        get_dir_size_cached(folder)  # fill the cache
        cached = get_dir_size_cached(folder)  # served from the cache
        fresh = get_dir_size(folder)  # walk the folder now

        assert cached == fresh
        assert cached < outside.stat().st_size

    def test_walk_started_before_invalidation_is_not_cached(self, tmp_path, monkeypatch):
        """A walk that saw a nested file must not cache its size after that file is deleted."""
        clear_dir_sizes()
        folder = tmp_path / "folder"
        (folder / "sub" / "later").mkdir(parents=True)
        (folder / "sub" / "doomed.txt").write_bytes(b"x" * 1000)

        walk_blocked = threading.Event()
        release_walk = threading.Event()
        real_scandir = os.scandir

        def blocking_scandir(path):
            if Path(path).name == "later":
                walk_blocked.set()
                assert release_walk.wait(timeout=10)
            return real_scandir(path)

        monkeypatch.setattr(os, "scandir", blocking_scandir)
        sizes = []
        walker = threading.Thread(target=lambda: sizes.append(get_dir_size_cached(folder)))
        walker.start()
        assert walk_blocked.wait(timeout=10)

        (folder / "sub" / "doomed.txt").unlink()
        invalidate_dir_size(folder / "sub" / "doomed.txt")
        release_walk.set()
        walker.join(timeout=10)
        assert not walker.is_alive()
        assert sizes == [1000]

        assert get_dir_size_cached(folder) == get_dir_size(folder)

    def test_parse_trashinfo_valid(self, tmp_path):
        """Test parse_trashinfo with valid trashinfo file."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("""[Trash Info]
Path=/home/user/documents/important.txt
DeletionDate=2024-01-15T10:30:00
""")
        result = parse_trashinfo(info_file)
        assert result["original_path"] == "/home/user/documents/important.txt"
        converted = datetime.fromisoformat(result["deletion_date"])
        assert converted.utcoffset() is not None
        assert converted.replace(tzinfo=None) == datetime(2024, 1, 15, 10, 30)

    def test_parse_trashinfo_unparseable_deletion_date(self, tmp_path):
        """Test an unparseable DeletionDate comes back unchanged."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("[Trash Info]\nPath=/home/user/test.txt\nDeletionDate=not-a-date\n")
        result = parse_trashinfo(info_file)
        assert result["deletion_date"] == "not-a-date"

    def test_parse_trashinfo_missing_deletion_date(self, tmp_path):
        """Test a missing DeletionDate stays empty."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("[Trash Info]\nPath=/home/user/test.txt\n")
        result = parse_trashinfo(info_file)
        assert result["deletion_date"] == ""

    def test_parse_trashinfo_url_encoded(self, tmp_path):
        """Test parse_trashinfo handles URL-encoded paths."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("[Trash Info]\nPath=/home/user/my%20documents/file%20name.txt\nDeletionDate=2024-01-15T10:30:00\n")
        result = parse_trashinfo(info_file)
        assert result["original_path"] == "/home/user/my documents/file name.txt"

    def test_parse_trashinfo_missing_section(self, tmp_path):
        """Test parse_trashinfo with missing Trash Info section."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("""[Wrong Section]
Path=/home/user/test.txt
""")
        result = parse_trashinfo(info_file)
        assert result["original_path"] == ""
        assert result["deletion_date"] == ""

    def test_parse_trashinfo_nonexistent(self, tmp_path):
        """Test parse_trashinfo with non-existent file."""
        info_file = tmp_path / "nonexistent.trashinfo"
        result = parse_trashinfo(info_file)
        assert result["original_path"] == ""
        assert result["deletion_date"] == ""


class TestTrashOperations:
    """Tests for trash operations using fixtures."""

    def test_trash_dir_structure(self, trash_dir):
        """Test that trash directory structure is created correctly."""
        assert (trash_dir / "files").exists()
        assert (trash_dir / "info").exists()

    def test_sample_file_in_trash(self, sample_trash_file):
        """Test that sample file fixture creates file correctly."""
        assert sample_trash_file["file_path"].exists()
        assert sample_trash_file["info_path"].exists()
        assert sample_trash_file["file_path"].read_text() == "Test content for trash file"

    def test_sample_directory_in_trash(self, sample_trash_directory):
        """Test that sample directory fixture creates directory correctly."""
        assert sample_trash_directory["dir_path"].exists()
        assert sample_trash_directory["dir_path"].is_dir()
        assert (sample_trash_directory["dir_path"] / "file1.txt").exists()
        assert (sample_trash_directory["dir_path"] / "file2.txt").exists()

    def test_delete_file_from_trash(self, sample_trash_file):
        """Test permanently deleting a file from trash."""
        file_path = sample_trash_file["file_path"]
        info_path = sample_trash_file["info_path"]
        
        # Verify file exists
        assert file_path.exists()
        assert info_path.exists()
        
        # Delete file
        file_path.unlink()
        info_path.unlink()
        
        # Verify deletion
        assert not file_path.exists()
        assert not info_path.exists()

    def test_delete_directory_from_trash(self, sample_trash_directory):
        """Test permanently deleting a directory from trash."""
        dir_path = sample_trash_directory["dir_path"]
        info_path = sample_trash_directory["info_path"]
        
        # Verify directory exists
        assert dir_path.exists()
        assert info_path.exists()
        
        # Delete directory
        shutil.rmtree(str(dir_path))
        info_path.unlink()
        
        # Verify deletion
        assert not dir_path.exists()
        assert not info_path.exists()

    def test_restore_file_from_trash(self, sample_trash_file, tmp_path):
        """Test restoring a file from trash."""
        file_path = sample_trash_file["file_path"]
        info_path = sample_trash_file["info_path"]
        
        # Use tmp_path for restore destination
        restore_path = tmp_path / "restored" / "test_file.txt"
        restore_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Move file to restore location
        shutil.move(str(file_path), str(restore_path))
        info_path.unlink()
        
        # Verify restoration
        assert restore_path.exists()
        assert restore_path.read_text() == "Test content for trash file"
        assert not file_path.exists()
        assert not info_path.exists()

    def test_restore_directory_from_trash(self, sample_trash_directory, tmp_path):
        """Test restoring a directory from trash."""
        dir_path = sample_trash_directory["dir_path"]
        info_path = sample_trash_directory["info_path"]
        
        # Use tmp_path for restore destination
        restore_path = tmp_path / "restored" / "test_folder"
        restore_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Move directory to restore location
        shutil.move(str(dir_path), str(restore_path))
        info_path.unlink()
        
        # Verify restoration
        assert restore_path.exists()
        assert restore_path.is_dir()
        assert (restore_path / "file1.txt").read_text() == "File 1 content"
        assert (restore_path / "file2.txt").read_text() == "File 2 content"
        assert not dir_path.exists()
        assert not info_path.exists()

    def test_empty_trash(self, trash_dir, sample_trash_file, sample_trash_directory):
        """Test emptying the entire trash."""
        files_dir = trash_dir / "files"
        info_dir = trash_dir / "info"
        
        # Verify items exist
        assert len(list(files_dir.iterdir())) == 2
        assert len(list(info_dir.iterdir())) == 2
        
        # Empty trash
        for entry in list(files_dir.iterdir()):
            if entry.is_dir():
                shutil.rmtree(str(entry))
            else:
                entry.unlink()
        
        for entry in list(info_dir.iterdir()):
            entry.unlink()
        
        # Verify trash is empty
        assert len(list(files_dir.iterdir())) == 0
        assert len(list(info_dir.iterdir())) == 0

    def test_list_trash_contents(self, trash_dir, sample_trash_file, sample_trash_directory):
        """Test listing trash contents."""
        files_dir = trash_dir / "files"
        info_dir = trash_dir / "info"
        
        items = []
        for entry in files_dir.iterdir():
            info_file = info_dir / f"{entry.name}.trashinfo"
            metadata = parse_trashinfo(info_file) if info_file.exists() else {}
            items.append({
                "name": entry.name,
                "original_path": metadata.get("original_path", ""),
                "deletion_date": metadata.get("deletion_date", ""),
                "size": get_item_size(entry),
                "is_dir": entry.is_dir()
            })
        
        assert len(items) == 2
        
        # Find file and directory items
        file_item = next((i for i in items if i["name"] == "test_file.txt"), None)
        dir_item = next((i for i in items if i["name"] == "test_folder"), None)
        
        assert file_item is not None
        assert file_item["original_path"] == "/home/user/original/test_file.txt"
        assert file_item["is_dir"] is False
        
        assert dir_item is not None
        assert dir_item["original_path"] == "/home/user/original/test_folder"
        assert dir_item["is_dir"] is True


class TestRemoveTree:
    """A directory refilled while rmtree walks it must not fail the whole empty."""

    def test_empty_trash_retries_a_directory_not_empty(self, trash_dir, monkeypatch):
        """The first ENOTEMPTY is retried, so the entry is still removed."""
        folder = trash_dir / "files" / "refilled"
        folder.mkdir()
        (folder / "late.txt").write_text("x")

        real_rmtree = shutil.rmtree
        calls = []

        def flaky_rmtree(path, *args, **kwargs):
            calls.append(path)
            if len(calls) == 1:
                raise OSError(errno.ENOTEMPTY, "Directory not empty", str(path))
            return real_rmtree(path, *args, **kwargs)

        monkeypatch.setattr(routes.shutil, "rmtree", flaky_rmtree)

        status, body = empty_trash()

        assert status is None
        assert body == {"success": True, "deleted_count": 1}
        assert len(calls) == 2
        assert not folder.exists()

    def test_empty_trash_reports_a_persistent_directory_not_empty(
        self, trash_dir, monkeypatch
    ):
        """A directory that stays refilled is reported after three attempts."""
        folder = trash_dir / "files" / "busy"
        folder.mkdir()

        calls = []

        def always_not_empty(path, *args, **kwargs):
            calls.append(path)
            raise OSError(errno.ENOTEMPTY, "Directory not empty", str(path))

        monkeypatch.setattr(routes.shutil, "rmtree", always_not_empty)

        status, body = empty_trash()

        assert status is None
        assert body["success"] is False
        assert body["deleted_count"] == 0
        assert len(calls) == 3
        assert len(body["errors"]) == 1
        assert body["errors"][0].startswith("busy: ")

    def test_delete_retries_a_directory_not_empty(self, trash_dir, monkeypatch):
        """The first ENOTEMPTY is retried, so the single item is still removed."""
        folder = trash_dir / "files" / "refilled"
        folder.mkdir()
        (folder / "late.txt").write_text("x")

        real_rmtree = shutil.rmtree
        calls = []

        def flaky_rmtree(path, *args, **kwargs):
            calls.append(path)
            if len(calls) == 1:
                raise OSError(errno.ENOTEMPTY, "Directory not empty", str(path))
            return real_rmtree(path, *args, **kwargs)

        monkeypatch.setattr(routes.shutil, "rmtree", flaky_rmtree)

        status, body = delete_item("refilled")

        assert status is None
        assert body == {"success": True}
        assert len(calls) == 2
        assert not folder.exists()


class TestTrashSources:
    """The source model: which sources exist and what each one reports."""

    def test_absent_cache_is_not_a_source(self, trash_dir, tmp_path, monkeypatch):
        """Without /home/cache only the XDG source is listed."""
        homes = tmp_path / "homes"
        homes.mkdir()
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        add_trash_item(trash_dir, "kept.txt", "/home/user/kept.txt", "12345")

        sources = collect_sources()

        assert [source["id"] for source in sources] == ["xdg"]
        assert sources[0]["label"] == "Trash"
        assert sources[0]["item_count"] == 1
        assert sources[0]["total_size"] == "5 B"
        assert sources[0]["error"] == ""

    def test_home_trash_resolving_to_the_xdg_trash_is_listed_once(
        self, tmp_path, monkeypatch
    ):
        """The current user's home trash is the XDG trash, so it is listed once."""
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        data_home = homes / "alice" / ".local" / "share"
        monkeypatch.setenv("XDG_DATA_HOME", str(data_home))
        make_trash(data_home / "Trash")

        sources = routes.existing_sources()

        assert [source["id"] for source in sources] == ["xdg"]

    def test_home_trash_under_a_temporary_home_root_is_discovered(
        self, trash_dir, tmp_path, monkeypatch
    ):
        """A home whose .local/share/Trash exists becomes a source."""
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        home_trash = make_trash(homes / "alice" / ".local" / "share" / "Trash")
        add_trash_item(home_trash, "note.txt", "/home/alice/note.txt", "hello")

        sources = collect_sources()

        assert [source["id"] for source in sources] == ["xdg", "home:alice"]
        assert sources[1]["label"] == "/home/alice"
        assert sources[1]["item_count"] == 1
        assert sources[1]["total_size"] == "5 B"


class TestSourceListing:
    """GET list names one source and defaults to the XDG trash."""

    async def test_list_source_cache_and_default_xdg(
        self, jp_fetch, trash_dir, tmp_path, monkeypatch
    ):
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        cache = make_trash(homes / "cache")
        add_trash_item(cache, "cached.bin", "/home/cache/cached.bin", "1234567890")
        add_trash_item(trash_dir, "xdg.txt", "/home/user/xdg.txt", "abc")

        response = await jp_fetch(NAMESPACE, "list", params={"source": "cache"})
        data = json.loads(response.body)
        assert [item["name"] for item in data["items"]] == ["cached.bin"]

        response = await jp_fetch(NAMESPACE, "list")
        data = json.loads(response.body)
        assert [item["name"] for item in data["items"]] == ["xdg.txt"]

        response = await jp_fetch(NAMESPACE, "sources")
        sources = json.loads(response.body)
        assert [source["id"] for source in sources] == ["xdg", "cache"]
        assert sources[1]["item_count"] == 1
        assert sources[1]["total_size"] == "10 B"


class TestEmptyScopes:
    """Empty keeps its single-trash default and adds all and workspace scopes."""

    def test_scope_all_counts_each_source_and_survives_a_failure(
        self, trash_dir, tmp_path, monkeypatch
    ):
        """A source that cannot be read is reported, and the next source is emptied."""
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        cache = make_trash(homes / "cache")
        add_trash_item(cache, "cached.txt", "/home/cache/cached.txt", "abc")

        # The XDG trash holds a plain file where its files folder belongs
        (trash_dir / "files").rmdir()
        (trash_dir / "files").write_text("not a directory")

        status, body = empty_trash("all")

        assert status is None
        assert [source["id"] for source in body["sources"]] == ["xdg", "cache"]
        by_id = {source["id"]: source for source in body["sources"]}
        assert by_id["xdg"]["deleted_count"] == 0
        assert by_id["xdg"]["errors"]
        assert by_id["cache"]["deleted_count"] == 1
        assert by_id["cache"]["errors"] == []
        assert body["deleted_count"] == 1
        assert body["success"] is False
        assert not (cache / "files" / "cached.txt").exists()

    def test_scope_workspace_removes_only_entries_under_the_root(
        self, trash_dir, tmp_path, monkeypatch
    ):
        """Entries outside the root, including a prefix match, are left behind."""
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        workspace = tmp_path / "workspace"
        add_trash_item(trash_dir, "inside.txt", str(workspace / "inside.txt"), "in")
        add_trash_item(
            trash_dir,
            "outside.txt",
            str(tmp_path / "workspace-other" / "outside.txt"),
            "out",
        )

        cache = make_trash(homes / "cache")
        add_trash_item(cache, "kept.txt", str(workspace / "kept.txt"), "keep")
        add_trash_item(cache, "elsewhere.txt", str(tmp_path / "elsewhere.txt"), "else")

        status, body = empty_trash("workspace", str(workspace))

        assert status is None
        assert [source["id"] for source in body["sources"]] == ["xdg", "cache"]
        by_id = {source["id"]: source for source in body["sources"]}
        assert by_id["xdg"]["deleted_count"] == 1
        assert by_id["xdg"]["left_count"] == 1
        assert by_id["cache"]["deleted_count"] == 1
        assert by_id["cache"]["left_count"] == 1
        assert body["deleted_count"] == 2
        assert body["left_count"] == 2
        assert body["success"] is True

        assert sorted(p.name for p in (trash_dir / "files").iterdir()) == [
            "outside.txt"
        ]
        assert not (trash_dir / "info" / "inside.txt.trashinfo").exists()
        assert (trash_dir / "info" / "outside.txt.trashinfo").exists()
        assert sorted(p.name for p in (cache / "files").iterdir()) == ["elsewhere.txt"]

    def test_absent_scope_keeps_the_single_trash_behaviour(
        self, trash_dir, tmp_path, monkeypatch
    ):
        """The default scope empties the XDG trash only and keeps the old response."""
        homes = tmp_path / "homes"
        monkeypatch.setattr(routes, "HOMES_ROOT", homes)
        cache = make_trash(homes / "cache")
        add_trash_item(cache, "cached.txt", "/home/cache/cached.txt", "abc")
        add_trash_item(trash_dir, "xdg.txt", "/home/user/xdg.txt", "x")

        status, body = empty_trash()

        assert status is None
        assert body == {"success": True, "deleted_count": 1}
        assert list((trash_dir / "files").iterdir()) == []
        assert (cache / "files" / "cached.txt").exists()
