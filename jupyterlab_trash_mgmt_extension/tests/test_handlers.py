"""Tests that send requests to the trash REST handlers of a running server."""

import json
import os

import pytest
from tornado.httpclient import HTTPClientError

NAMESPACE = "jupyterlab-trash-mgmt-extension"


async def get_list(jp_fetch, path=None):
    """GET the listing of the trash top level, or of a folder inside it."""
    params = {"path": path} if path is not None else {}
    response = await jp_fetch(NAMESPACE, "list", params=params)
    return json.loads(response.body)


async def post(jp_fetch, endpoint, trash_path):
    """POST a trash_path to an endpoint and return the decoded response body."""
    response = await jp_fetch(
        NAMESPACE, endpoint, method="POST", body=json.dumps({"trash_path": trash_path})
    )
    return json.loads(response.body)


async def status_of(request):
    """Await a request that must fail and return its HTTP status and error text."""
    with pytest.raises(HTTPClientError) as failure:
        await request
    return failure.value.code, json.loads(failure.value.response.body)["error"]


@pytest.fixture
def trashed_folder(trash_dir, tmp_path):
    """A trashed folder `a` holding two files and the nested folders `b/c`."""
    folder = trash_dir / "files" / "a"
    (folder / "b" / "c").mkdir(parents=True)
    (folder / "file1.txt").write_text("12345")
    (folder / "file2.txt").write_text("1234567890")
    (folder / "b" / "c" / "deep.txt").write_text("123")
    original = tmp_path / "original" / "a"
    info = trash_dir / "info" / "a.trashinfo"
    info.write_text(
        f"[Trash Info]\nPath={original}\nDeletionDate=2024-01-14T09:00:00\n"
    )
    return {"folder": folder, "info": info, "original": original}


class TestList:
    async def test_top_level(self, jp_fetch, trashed_folder):
        data = await get_list(jp_fetch)
        assert [item["trash_path"] for item in data["items"]] == ["a"]
        assert data["items"][0]["is_dir"] is True
        assert data["item_count"] == 1

    async def test_folder_children(self, jp_fetch, trashed_folder):
        data = await get_list(jp_fetch, "a")
        assert sorted(item["trash_path"] for item in data["items"]) == [
            "a/b",
            "a/file1.txt",
            "a/file2.txt",
        ]

    async def test_any_depth(self, jp_fetch, trashed_folder):
        data = await get_list(jp_fetch, "a/b/c")
        assert [item["trash_path"] for item in data["items"]] == ["a/b/c/deep.txt"]

    async def test_summary_of_folder(self, jp_fetch, trashed_folder):
        data = await get_list(jp_fetch, "a")
        # file1.txt 5 bytes + file2.txt 10 bytes + b/c/deep.txt 3 bytes
        assert data["item_count"] == 3
        assert data["total_size"] == 18
        assert data["total_size_formatted"] == "18 B"

    async def test_nested_row_carries_deletion_date_of_top_level(
        self, jp_fetch, trashed_folder
    ):
        data = await get_list(jp_fetch, "a/b")
        assert [item["deletion_date"] for item in data["items"]] == [
            "2024-01-14T09:00:00"
        ]

    async def test_nested_row_carries_original_path(self, jp_fetch, trashed_folder):
        data = await get_list(jp_fetch, "a/b/c")
        expected = str(trashed_folder["original"] / "b" / "c" / "deep.txt")
        assert data["items"][0]["original_path"] == expected

    async def test_empty_folder(self, jp_fetch, trash_dir):
        (trash_dir / "files" / "empty").mkdir()
        data = await get_list(jp_fetch, "empty")
        assert data["items"] == []
        assert data["item_count"] == 0

    async def test_folder_name_with_spaces_and_percent(self, jp_fetch, trash_dir):
        folder = trash_dir / "files" / " 100% done "
        folder.mkdir()
        (folder / "x.txt").write_text("x")
        data = await get_list(jp_fetch, " 100% done ")
        assert [item["name"] for item in data["items"]] == ["x.txt"]

    async def test_missing_folder_is_404(self, jp_fetch, trashed_folder):
        code, _ = await status_of(get_list(jp_fetch, "a/gone"))
        assert code == 404

    async def test_file_path_is_400(self, jp_fetch, trashed_folder):
        code, error = await status_of(get_list(jp_fetch, "a/file1.txt"))
        assert (code, error) == (400, "Not a folder")

    @pytest.mark.parametrize("path", ["..", "../info", "a/../..", "/etc", "a//b", "./a"])
    async def test_path_outside_trash_is_400(self, jp_fetch, trashed_folder, path):
        code, error = await status_of(get_list(jp_fetch, path))
        assert (code, error) == (400, "Invalid trash path")

    async def test_symlink_is_not_listed_as_a_folder(
        self, jp_fetch, trash_dir, tmp_path
    ):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("secret")
        os.symlink(outside, trash_dir / "files" / "link")
        code, error = await status_of(get_list(jp_fetch, "link"))
        assert (code, error) == (400, "Invalid trash path")

    async def test_path_through_a_symlink_is_400(
        self, jp_fetch, trashed_folder, tmp_path
    ):
        outside = tmp_path / "outside"
        (outside / "inner").mkdir(parents=True)
        os.symlink(outside, trashed_folder["folder"] / "link")
        code, error = await status_of(get_list(jp_fetch, "a/link/inner"))
        assert (code, error) == (400, "Invalid trash path")


class TestDelete:
    async def test_top_level_item(self, jp_fetch, trashed_folder):
        assert await post(jp_fetch, "delete", "a") == {"success": True}
        assert not trashed_folder["folder"].exists()
        assert not trashed_folder["info"].exists()

    async def test_nested_item_only(self, jp_fetch, trashed_folder):
        assert await post(jp_fetch, "delete", "a/file1.txt") == {"success": True}
        folder = trashed_folder["folder"]
        assert not (folder / "file1.txt").exists()
        assert (folder / "file2.txt").exists()
        assert trashed_folder["info"].exists()

    async def test_nested_folder(self, jp_fetch, trashed_folder):
        await post(jp_fetch, "delete", "a/b")
        assert not (trashed_folder["folder"] / "b").exists()
        assert (trashed_folder["folder"] / "file1.txt").exists()

    async def test_missing_nested_item_is_404(self, jp_fetch, trashed_folder):
        code, error = await status_of(post(jp_fetch, "delete", "a/missing.txt"))
        assert (code, error) == (404, "Item not found in trash")

    async def test_parent_segment_is_400(self, jp_fetch, trash_dir):
        victim = trash_dir / "victim"
        victim.mkdir()
        (victim / "keep.txt").write_text("keep")
        code, error = await status_of(post(jp_fetch, "delete", "../victim"))
        assert (code, error) == (400, "Invalid trash path")
        assert (victim / "keep.txt").exists()

    async def test_absolute_path_is_400(self, jp_fetch, trash_dir, tmp_path):
        victim = tmp_path / "victim"
        victim.mkdir()
        code, error = await status_of(post(jp_fetch, "delete", str(victim)))
        assert (code, error) == (400, "Invalid trash path")
        assert victim.exists()

    async def test_path_through_a_symlink_is_400(
        self, jp_fetch, trashed_folder, tmp_path
    ):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        os.symlink(outside, trashed_folder["folder"] / "link")
        code, error = await status_of(post(jp_fetch, "delete", "a/link/keep.txt"))
        assert (code, error) == (400, "Invalid trash path")
        assert (outside / "keep.txt").exists()

    async def test_nested_symlink_is_unlinked_not_followed(
        self, jp_fetch, trashed_folder, tmp_path
    ):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        link = trashed_folder["folder"] / "link"
        os.symlink(outside, link)
        await post(jp_fetch, "delete", "a/link")
        assert not link.is_symlink()
        assert (outside / "keep.txt").exists()


class TestRestore:
    async def test_top_level_item(self, jp_fetch, trashed_folder):
        original = trashed_folder["original"]
        data = await post(jp_fetch, "restore", "a")
        assert data == {"success": True, "restored_to": str(original)}
        assert (original / "file1.txt").read_text() == "12345"
        assert not trashed_folder["folder"].exists()
        assert not trashed_folder["info"].exists()

    async def test_nested_item(self, jp_fetch, trashed_folder):
        target = trashed_folder["original"] / "file1.txt"
        data = await post(jp_fetch, "restore", "a/file1.txt")
        assert data == {"success": True, "restored_to": str(target)}
        assert target.read_text() == "12345"

    async def test_nested_restore_creates_parents(self, jp_fetch, trashed_folder):
        assert not trashed_folder["original"].exists()
        await post(jp_fetch, "restore", "a/b/c/deep.txt")
        assert (trashed_folder["original"] / "b" / "c" / "deep.txt").read_text() == "123"

    async def test_nested_restore_keeps_the_folder(self, jp_fetch, trashed_folder):
        await post(jp_fetch, "restore", "a/file1.txt")
        folder = trashed_folder["folder"]
        assert folder.is_dir()
        assert (folder / "file2.txt").exists()
        assert trashed_folder["info"].exists()

    async def test_nested_restore_target_exists_is_409(self, jp_fetch, trashed_folder):
        target = trashed_folder["original"] / "file1.txt"
        target.parent.mkdir(parents=True)
        target.write_text("already here")
        code, error = await status_of(post(jp_fetch, "restore", "a/file1.txt"))
        assert (code, error) == (409, f"Destination already exists: {target}")
        assert (trashed_folder["folder"] / "file1.txt").exists()
        assert target.read_text() == "already here"

    async def test_restore_onto_a_broken_symlink_is_409(self, jp_fetch, trashed_folder):
        target = trashed_folder["original"] / "file1.txt"
        target.parent.mkdir(parents=True)
        os.symlink(target.parent / "absent", target)
        code, error = await status_of(post(jp_fetch, "restore", "a/file1.txt"))
        assert (code, error) == (409, f"Destination already exists: {target}")
        assert target.is_symlink()
        assert (trashed_folder["folder"] / "file1.txt").exists()

    async def test_nested_restore_without_trashinfo_is_400(
        self, jp_fetch, trashed_folder
    ):
        trashed_folder["info"].unlink()
        code, error = await status_of(post(jp_fetch, "restore", "a/file1.txt"))
        assert (code, error) == (400, "Cannot determine original path")
        assert (trashed_folder["folder"] / "file1.txt").exists()

    async def test_whole_folder_after_nested_restore_is_409(
        self, jp_fetch, trashed_folder
    ):
        await post(jp_fetch, "restore", "a/file1.txt")
        code, error = await status_of(post(jp_fetch, "restore", "a"))
        original = trashed_folder["original"]
        assert (code, error) == (409, f"Destination already exists: {original}")
        assert trashed_folder["folder"].is_dir()

    async def test_missing_nested_item_is_404(self, jp_fetch, trashed_folder):
        code, error = await status_of(post(jp_fetch, "restore", "a/missing.txt"))
        assert (code, error) == (404, "Item not found in trash")

    @pytest.mark.parametrize("path", ["../a", "a/../../x", "/etc/hostname"])
    async def test_path_outside_trash_is_400(self, jp_fetch, trashed_folder, path):
        code, error = await status_of(post(jp_fetch, "restore", path))
        assert (code, error) == (400, "Invalid trash path")

    async def test_path_through_a_symlink_is_400(
        self, jp_fetch, trashed_folder, tmp_path
    ):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        os.symlink(outside, trashed_folder["folder"] / "link")
        code, error = await status_of(post(jp_fetch, "restore", "a/link/keep.txt"))
        assert (code, error) == (400, "Invalid trash path")
        assert (outside / "keep.txt").exists()


class TestEmpty:
    async def test_removes_every_item(self, jp_fetch, trashed_folder, sample_trash_file):
        response = await jp_fetch(NAMESPACE, "empty", method="POST", body="{}")
        assert json.loads(response.body) == {"success": True, "deleted_count": 2}
        assert list((trashed_folder["folder"].parent).iterdir()) == []
        assert list(trashed_folder["info"].parent.iterdir()) == []
