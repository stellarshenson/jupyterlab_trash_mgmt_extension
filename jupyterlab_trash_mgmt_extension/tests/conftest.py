"""Pytest configuration and fixtures for trash management tests."""

import os
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def trash_dir(tmp_path, monkeypatch):
    """Create a temporary XDG trash directory structure."""
    trash_path = tmp_path / "Trash"
    files_dir = trash_path / "files"
    info_dir = trash_path / "info"
    
    files_dir.mkdir(parents=True)
    info_dir.mkdir(parents=True)
    
    # Set XDG_DATA_HOME to use our temp directory
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    
    return trash_path


@pytest.fixture
def sample_trash_file(trash_dir):
    """Create a sample file in trash with trashinfo."""
    files_dir = trash_dir / "files"
    info_dir = trash_dir / "info"
    
    # Create a test file
    test_file = files_dir / "test_file.txt"
    test_file.write_text("Test content for trash file")
    
    # Create corresponding trashinfo
    info_file = info_dir / "test_file.txt.trashinfo"
    info_file.write_text("""[Trash Info]
Path=/home/user/original/test_file.txt
DeletionDate=2024-01-15T10:30:00
""")
    
    return {
        "name": "test_file.txt",
        "file_path": test_file,
        "info_path": info_file,
        "original_path": "/home/user/original/test_file.txt"
    }


@pytest.fixture
def sample_trash_directory(trash_dir):
    """Create a sample directory in trash with trashinfo."""
    files_dir = trash_dir / "files"
    info_dir = trash_dir / "info"
    
    # Create a test directory with files
    test_dir = files_dir / "test_folder"
    test_dir.mkdir()
    (test_dir / "file1.txt").write_text("File 1 content")
    (test_dir / "file2.txt").write_text("File 2 content")
    
    # Create corresponding trashinfo
    info_file = info_dir / "test_folder.trashinfo"
    info_file.write_text("""[Trash Info]
Path=/home/user/original/test_folder
DeletionDate=2024-01-14T09:00:00
""")
    
    return {
        "name": "test_folder",
        "dir_path": test_dir,
        "info_path": info_file,
        "original_path": "/home/user/original/test_folder"
    }


@pytest.fixture
def restore_target_dir(tmp_path):
    """Create a directory for restoring files to."""
    target = tmp_path / "restore_target"
    target.mkdir(parents=True)
    return target
