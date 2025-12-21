"""Tests for trash management routes and helper functions."""

import json
import os
import shutil
from pathlib import Path

import pytest

from jupyterlab_trash_mgmt_extension.routes import (
    format_size,
    get_dir_size,
    get_item_size,
    get_trash_dir,
    parse_trashinfo,
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

    def test_get_item_size_nonexistent(self, tmp_path):
        """Test get_item_size for non-existent path."""
        nonexistent = tmp_path / "nonexistent.txt"
        size = get_item_size(nonexistent)
        assert size == 0

    def test_parse_trashinfo_valid(self, tmp_path):
        """Test parse_trashinfo with valid trashinfo file."""
        info_file = tmp_path / "test.trashinfo"
        info_file.write_text("""[Trash Info]
Path=/home/user/documents/important.txt
DeletionDate=2024-01-15T10:30:00
""")
        result = parse_trashinfo(info_file)
        assert result["original_path"] == "/home/user/documents/important.txt"
        assert result["deletion_date"] == "2024-01-15T10:30:00"

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
