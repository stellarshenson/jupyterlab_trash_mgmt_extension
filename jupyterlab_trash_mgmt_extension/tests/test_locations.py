"""Tests for the trash folders of the notebook root and of c.TrashManagement.locations."""

import json
import os
from pathlib import Path

import pytest
from tornado.httpclient import HTTPClientError

from jupyterlab_trash_mgmt_extension import TrashManagement, routes
from jupyterlab_trash_mgmt_extension.routes import (
    collect_source_listing,
    collect_sources,
    existing_sources,
    resolve_locations,
)

from .test_routes import add_trash_item, make_trash

NAMESPACE = "jupyterlab-trash-mgmt-extension"
UID = os.getuid()


def dash_trash(location: Path) -> Path:
    """Create <location>/.Trash-<uid> with its files and info folders."""
    return make_trash(location / f".Trash-{UID}")


def shared_trash(location: Path, mode: int = 0o1777) -> Path:
    """Create <location>/.Trash/<uid> under a .Trash with the given mode."""
    shared = location / ".Trash"
    shared.mkdir(parents=True)
    os.chmod(shared, mode)
    return make_trash(shared / str(UID))


def source_id(trash: Path) -> str:
    return f"location:{trash}"


def location_ids(locations) -> list[str]:
    return [s["id"] for s in existing_sources(locations) if s["id"].startswith("location:")]


async def fetch_json(jp_fetch, endpoint, body=None, params=None):
    if body is None:
        response = await jp_fetch(NAMESPACE, endpoint, params=params or {})
    else:
        response = await jp_fetch(NAMESPACE, endpoint, method="POST", body=json.dumps(body))
    return json.loads(response.body)


async def failure_of(request):
    with pytest.raises(HTTPClientError) as failure:
        await request
    return failure.value.code, json.loads(failure.value.response.body)["error"]


class TestOption:
    async def test_default_resolves_to_the_server_root_alone(self, jp_serverapp):
        assert TrashManagement().locations == []
        assert jp_serverapp.web_app.settings["trash_locations"] == [jp_serverapp.root_dir]

    def test_tilde_is_expanded_and_a_relative_path_joins_the_root(self, tmp_path):
        home = str(tmp_path / "home")
        assert resolve_locations(
            ["~", ".", "data", "~/.cache", "/mnt/nas-shared"], "/srv/root"
        ) == [home, "/srv/root", "/srv/root/data", f"{home}/.cache", "/mnt/nas-shared"]

    async def test_trash_at_the_top_of_a_folder_below_the_root_adds_no_section(
        self, jp_fetch, jp_root_dir
    ):
        root_trash = dash_trash(jp_root_dir)
        dash_trash(jp_root_dir / "nfs")
        shared_trash(jp_root_dir / "volume")

        sources = await fetch_json(jp_fetch, "sources")

        assert [s["id"] for s in sources if s["id"].startswith("location:")] == [
            source_id(root_trash)
        ]


class TestConfiguredOption:
    @pytest.fixture
    def jp_server_config(self, jp_server_config):
        return {**jp_server_config, "TrashManagement": {"locations": ["~/.cache"]}}

    async def test_configured_cache_adds_its_section_after_the_root(
        self, jp_fetch, jp_serverapp, trash_dir, tmp_path
    ):
        add_trash_item(trash_dir, "x.txt", "/home/user/x.txt")
        root_trash = dash_trash(Path(jp_serverapp.root_dir))
        cache = tmp_path / "home" / ".cache"
        cache_trash = dash_trash(cache)
        add_trash_item(cache_trash, "c.txt", "c.txt", "123")
        dash_trash(tmp_path / "unlisted")

        sources = await fetch_json(jp_fetch, "sources")
        listing = await fetch_json(jp_fetch, "list")

        assert [(s["id"], s["label"], s["item_count"]) for s in sources] == [
            ("xdg", "Trash", 1),
            (source_id(root_trash), jp_serverapp.root_dir, 0),
            (source_id(cache_trash), str(cache), 1),
        ]
        assert [item["original_path"] for item in listing["items"]] == ["/home/user/x.txt"]


class TestConfiguredRoot:
    @pytest.fixture
    def jp_server_config(self, jp_server_config, jp_root_dir):
        return {**jp_server_config, "TrashManagement": {"locations": [str(jp_root_dir)]}}

    async def test_configured_root_gives_one_root_section(self, jp_fetch, jp_serverapp):
        root_trash = dash_trash(Path(jp_serverapp.root_dir))

        sources = await fetch_json(jp_fetch, "sources")

        assert [s["id"] for s in sources if s["id"].startswith("location:")] == [
            source_id(root_trash)
        ]


class TestLocationSources:
    def test_dash_uid_trash_is_a_source_labelled_with_its_location(self, tmp_path):
        location = tmp_path / "nas"
        trash = dash_trash(location)
        sources = existing_sources([str(location)])
        assert [(s["id"], s["label"]) for s in sources] == [(source_id(trash), str(location))]

    def test_sticky_shared_trash_is_a_source(self, tmp_path):
        location = tmp_path / "nas"
        trash = shared_trash(location)
        assert location_ids([str(location)]) == [source_id(trash)]

    def test_shared_trash_without_the_sticky_bit_is_not_a_source(self, tmp_path):
        location = tmp_path / "nas"
        shared_trash(location, 0o777)
        assert location_ids([str(location)]) == []

    def test_shared_trash_that_is_a_symlink_is_not_a_source(self, tmp_path):
        location = tmp_path / "nas"
        real = location / "real"
        real.mkdir(parents=True)
        os.chmod(real, 0o1777)
        make_trash(real / str(UID))
        os.symlink(real, location / ".Trash")
        assert location_ids([str(location)]) == []

    def test_location_without_a_trash_is_not_a_source(self, tmp_path):
        location = tmp_path / "plain"
        location.mkdir()
        assert location_ids([str(location)]) == []

    def test_location_trash_that_is_the_xdg_trash_is_listed_once(self, tmp_path, monkeypatch):
        location = tmp_path / "data"
        make_trash(location / "Trash")
        os.symlink(location / "Trash", location / f".Trash-{UID}")
        monkeypatch.setenv("XDG_DATA_HOME", str(location))
        assert [s["id"] for s in existing_sources([str(location)])] == ["xdg"]

    def test_unlisted_folder_holding_a_trash_is_not_a_source(self, tmp_path):
        listed = tmp_path / "listed"
        listed.mkdir()
        dash_trash(tmp_path / "unlisted")
        assert location_ids([str(listed)]) == []

    def test_sources_follow_option_order_after_the_xdg_trash(self, trash_dir, tmp_path):
        first = tmp_path / "zeta"
        second = tmp_path / "alpha"
        first_trash = shared_trash(first)
        second_trash = dash_trash(second)
        add_trash_item(first_trash, "f.txt", "f.txt", "12345")

        sources = collect_sources([str(first), str(second)])

        assert [(s["id"], s["label"]) for s in sources] == [
            ("xdg", "Trash"),
            (source_id(first_trash), str(first)),
            (source_id(second_trash), str(second)),
        ]
        assert (sources[1]["item_count"], sources[1]["total_size"]) == (1, "5 B")


class TestRelativePath:
    def test_relative_path_joins_the_location_and_absolute_is_kept(self, tmp_path):
        location = tmp_path / "nas"
        trash = dash_trash(location)
        add_trash_item(trash, "b.txt", "a/b.txt")
        add_trash_item(trash, "abs.txt", "/elsewhere/abs.txt")
        (trash / "files" / "d").mkdir()
        (trash / "files" / "d" / "x.txt").write_text("x")
        (trash / "info" / "d.trashinfo").write_text("[Trash Info]\nPath=sub/d\n")

        _, top = collect_source_listing(source_id(trash), "", [str(location)])
        _, inside = collect_source_listing(source_id(trash), "d", [str(location)])

        paths = {item["name"]: item["original_path"] for item in top["items"]}
        assert paths == {
            "b.txt": str(location / "a" / "b.txt"),
            "abs.txt": "/elsewhere/abs.txt",
            "d": str(location / "sub" / "d"),
        }
        assert [item["original_path"] for item in inside["items"]] == [
            str(location / "sub" / "d" / "x.txt")
        ]

    def test_xdg_relative_path_is_not_joined(self, trash_dir):
        add_trash_item(trash_dir, "r.txt", "a/r.txt")
        _, body = collect_source_listing("xdg", "", ["/somewhere"])
        assert body["items"][0]["original_path"] == "a/r.txt"


@pytest.fixture
def nas(jp_serverapp, tmp_path):
    """A configured location holding .Trash-<uid> with b.txt trashed from a/b.txt."""
    location = tmp_path / "nas"
    trash = dash_trash(location)
    add_trash_item(trash, "b.txt", "a/b.txt", "nas")
    jp_serverapp.web_app.settings["trash_locations"] = [str(location)]
    return {"location": location, "trash": trash, "id": source_id(trash)}


class TestLocationRestore:
    async def test_list_through_the_server_joins_the_relative_path(self, jp_fetch, nas):
        data = await fetch_json(jp_fetch, "list", params={"source": nas["id"]})
        assert [item["original_path"] for item in data["items"]] == [
            str(nas["location"] / "a" / "b.txt")
        ]

    async def test_restore_moves_the_item_to_the_joined_path(self, jp_fetch, nas):
        target = nas["location"] / "a" / "b.txt"
        data = await fetch_json(
            jp_fetch, "restore", {"trash_path": "b.txt", "source": nas["id"]}
        )
        assert data == {"success": True, "restored_to": str(target)}
        assert target.read_text() == "nas"
        assert not (nas["trash"] / "files" / "b.txt").exists()
        assert not (nas["trash"] / "info" / "b.txt.trashinfo").exists()
        sources = await fetch_json(jp_fetch, "sources")
        assert [(s["id"], s["item_count"]) for s in sources] == [(nas["id"], 0)]

    async def test_existing_destination_is_409_and_keeps_the_item(self, jp_fetch, nas):
        target = nas["location"] / "a" / "b.txt"
        target.parent.mkdir(parents=True)
        target.write_text("already here")
        code, error = await failure_of(
            fetch_json(jp_fetch, "restore", {"trash_path": "b.txt", "source": nas["id"]})
        )
        assert (code, error) == (409, f"Destination already exists: {target}")
        assert target.read_text() == "already here"
        assert (nas["trash"] / "files" / "b.txt").exists()
        assert (nas["trash"] / "info" / "b.txt.trashinfo").exists()

    async def test_unknown_source_is_400(self, jp_fetch, nas):
        code, error = await failure_of(
            fetch_json(jp_fetch, "restore", {"trash_path": "b.txt", "source": "nope"})
        )
        assert (code, error) == (400, "Unknown trash source")
        assert (nas["trash"] / "files" / "b.txt").exists()
        assert not (nas["location"] / "a").exists()

    @pytest.mark.parametrize("trash_path", ["../x", "/etc/passwd", "d/link/keep.txt"])
    async def test_path_leaving_the_source_trash_is_400(
        self, jp_fetch, nas, tmp_path, trash_path
    ):
        # ../x would name this file; d/link is a symbolic link out of the trash
        victim = nas["trash"] / "x"
        victim.write_text("victim")
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        (nas["trash"] / "files" / "d").mkdir()
        os.symlink(outside, nas["trash"] / "files" / "d" / "link")
        (nas["trash"] / "info" / "d.trashinfo").write_text("[Trash Info]\nPath=d\n")
        before = sorted(p.name for p in (nas["trash"] / "files").iterdir())

        code, error = await failure_of(
            fetch_json(jp_fetch, "restore", {"trash_path": trash_path, "source": nas["id"]})
        )

        assert (code, error) == (400, "Invalid trash path")
        assert victim.read_text() == "victim"
        assert (outside / "keep.txt").read_text() == "keep"
        assert sorted(p.name for p in (nas["trash"] / "files").iterdir()) == before
        assert not (nas["location"] / "d").exists()

    async def test_restore_without_a_source_keeps_the_xdg_trash(
        self, jp_fetch, nas, trash_dir, tmp_path
    ):
        target = tmp_path / "restored" / "b.txt"
        add_trash_item(trash_dir, "b.txt", str(target), "xdg")
        data = await fetch_json(jp_fetch, "restore", {"trash_path": "b.txt"})
        assert data == {"success": True, "restored_to": str(target)}
        assert target.read_text() == "xdg"
        assert (nas["trash"] / "files" / "b.txt").exists()

    async def test_nested_restore_shows_the_fresh_folder_size(self, jp_fetch, nas):
        routes.clear_dir_sizes()
        folder = nas["trash"] / "files" / "d"
        (folder / "sub").mkdir(parents=True)
        (folder / "keep.txt").write_text("12345")
        (folder / "sub" / "file.txt").write_text("1234567890")
        (nas["trash"] / "info" / "d.trashinfo").write_text("[Trash Info]\nPath=d\n")

        def size_of_d(data):
            return next(item["size"] for item in data["items"] if item["name"] == "d")

        listing = await fetch_json(jp_fetch, "list", params={"source": nas["id"]})
        assert size_of_d(listing) == 15
        await fetch_json(
            jp_fetch, "restore", {"trash_path": "d/sub/file.txt", "source": nas["id"]}
        )
        listing = await fetch_json(jp_fetch, "list", params={"source": nas["id"]})
        assert size_of_d(listing) == 5
        assert (nas["location"] / "d" / "sub" / "file.txt").read_text() == "1234567890"



@pytest.mark.parametrize(
    "source, trash_dir",
    [("cache", "cache"), ("home:alice", "alice/.local/share/Trash")],
)
class TestHomesRestore:
    """ACC-SCOPE-92-RESTORE-ALL: a /home/cache and a /home/<name> row restore."""

    @pytest.fixture
    def homes_trash(self, tmp_path, source, trash_dir):
        # conftest points routes.HOMES_ROOT at tmp_path / "homes"
        trash = make_trash(routes.HOMES_ROOT / trash_dir)
        target = tmp_path / "restored" / "b.txt"
        add_trash_item(trash, "b.txt", str(target), source)
        return {"trash": trash, "target": target}

    async def test_restore_moves_the_item_to_its_original_path(
        self, jp_fetch, homes_trash, source
    ):
        data = await fetch_json(
            jp_fetch, "restore", {"trash_path": "b.txt", "source": source}
        )
        assert data == {"success": True, "restored_to": str(homes_trash["target"])}
        assert homes_trash["target"].read_text() == source
        assert not (homes_trash["trash"] / "files" / "b.txt").exists()
        assert not (homes_trash["trash"] / "info" / "b.txt.trashinfo").exists()

    async def test_existing_destination_is_409_and_keeps_the_item(
        self, jp_fetch, homes_trash, source
    ):
        target = homes_trash["target"]
        target.parent.mkdir(parents=True)
        target.write_text("already here")
        code, error = await failure_of(
            fetch_json(jp_fetch, "restore", {"trash_path": "b.txt", "source": source})
        )
        assert (code, error) == (409, f"Destination already exists: {target}")
        assert target.read_text() == "already here"
        assert (homes_trash["trash"] / "files" / "b.txt").exists()
        assert (homes_trash["trash"] / "info" / "b.txt.trashinfo").exists()

class TestLocationDelete:
    async def test_delete_with_a_source_deletes_only_there(self, jp_fetch, nas, trash_dir):
        add_trash_item(trash_dir, "b.txt", "/home/user/b.txt", "xdg")
        data = await fetch_json(jp_fetch, "delete", {"trash_path": "b.txt", "source": nas["id"]})
        assert data == {"success": True}
        assert not (nas["trash"] / "files" / "b.txt").exists()
        assert not (nas["trash"] / "info" / "b.txt.trashinfo").exists()
        assert (trash_dir / "files" / "b.txt").read_text() == "xdg"
        assert (trash_dir / "info" / "b.txt.trashinfo").exists()

    async def test_unknown_source_is_400(self, jp_fetch, nas):
        code, error = await failure_of(
            fetch_json(jp_fetch, "delete", {"trash_path": "b.txt", "source": "nope"})
        )
        assert (code, error) == (400, "Unknown trash source")
        assert (nas["trash"] / "files" / "b.txt").exists()

    @pytest.mark.parametrize("trash_path", ["../x", "/etc/passwd", "d/link/keep.txt"])
    async def test_path_leaving_the_source_trash_is_400(
        self, jp_fetch, nas, tmp_path, trash_path
    ):
        # ../x would name this file; d/link is a symbolic link out of the trash
        victim = nas["trash"] / "x"
        victim.write_text("victim")
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep")
        (nas["trash"] / "files" / "d").mkdir()
        os.symlink(outside, nas["trash"] / "files" / "d" / "link")

        code, error = await failure_of(
            fetch_json(jp_fetch, "delete", {"trash_path": trash_path, "source": nas["id"]})
        )

        assert (code, error) == (400, "Invalid trash path")
        assert victim.read_text() == "victim"
        assert (outside / "keep.txt").read_text() == "keep"
        assert (nas["trash"] / "files" / "b.txt").exists()


@pytest.fixture
def two_locations(jp_serverapp, tmp_path):
    """The server root holding .Trash-<uid> and a second location with a sticky .Trash/<uid>.

    Each trash holds one entry under the root and one outside it, one of the
    two recorded with a relative Path.
    """
    root = Path(jp_serverapp.root_dir)
    nas = tmp_path / "nas"
    root_trash = dash_trash(root)
    nas_trash = shared_trash(nas)
    add_trash_item(root_trash, "in.txt", "notes/in.txt")
    add_trash_item(root_trash, "out.txt", str(tmp_path / "elsewhere" / "out.txt"))
    add_trash_item(nas_trash, "in.txt", str(root / "in.txt"))
    add_trash_item(nas_trash, "out.txt", "out.txt")
    jp_serverapp.web_app.settings["trash_locations"] = [str(root), str(nas)]
    return {"root": source_id(root_trash), "nas": source_id(nas_trash),
            "root_trash": root_trash, "nas_trash": nas_trash}


class TestLocationEmpty:
    async def test_scope_all_empties_every_location_trash(self, jp_fetch, two_locations):
        body = await fetch_json(jp_fetch, "empty", {"scope": "all"})
        assert [(s["id"], s["deleted_count"]) for s in body["sources"]] == [
            (two_locations["root"], 2),
            (two_locations["nas"], 2),
        ]
        assert body["success"] is True
        for trash in (two_locations["root_trash"], two_locations["nas_trash"]):
            assert list((trash / "files").iterdir()) == []
            assert list((trash / "info").iterdir()) == []

    async def test_scope_workspace_deletes_only_entries_under_the_root(
        self, jp_fetch, two_locations
    ):
        body = await fetch_json(jp_fetch, "empty", {"scope": "workspace"})
        assert [
            (s["id"], s["deleted_count"], s["left_count"]) for s in body["sources"]
        ] == [(two_locations["root"], 1, 1), (two_locations["nas"], 1, 1)]
        for trash in (two_locations["root_trash"], two_locations["nas_trash"]):
            assert [p.name for p in (trash / "files").iterdir()] == ["out.txt"]
            assert [p.name for p in (trash / "info").iterdir()] == ["out.txt.trashinfo"]

    async def test_scope_source_empties_only_that_source(
        self, jp_fetch, two_locations, trash_dir
    ):
        add_trash_item(trash_dir, "x.txt", "/home/user/x.txt")
        body = await fetch_json(
            jp_fetch, "empty", {"scope": "source", "source": two_locations["nas"]}
        )
        assert body == {"success": True, "deleted_count": 2}
        assert list((two_locations["nas_trash"] / "files").iterdir()) == []
        assert list((two_locations["nas_trash"] / "info").iterdir()) == []
        assert [p.name for p in (trash_dir / "files").iterdir()] == ["x.txt"]
        assert sorted(p.name for p in (two_locations["root_trash"] / "files").iterdir()) == [
            "in.txt", "out.txt"
        ]

    async def test_scope_source_keeps_the_cached_sizes_of_other_sources(
        self, jp_fetch, two_locations, trash_dir
    ):
        folder = trash_dir / "files" / "dir"
        folder.mkdir()
        (folder / "a.txt").write_text("abc")
        routes.get_dir_size_cached(folder)
        key = os.path.abspath(folder)
        assert key in routes._dir_size_cache

        await fetch_json(jp_fetch, "empty", {"scope": "source", "source": two_locations["nas"]})
        assert key in routes._dir_size_cache

    @pytest.mark.parametrize("body", [{"scope": "source", "source": "nope"}, {"scope": "source"}])
    async def test_scope_source_with_an_unknown_id_is_400(self, jp_fetch, two_locations, body):
        code, error = await failure_of(fetch_json(jp_fetch, "empty", body))
        assert (code, error) == (400, "Unknown trash source")
        for trash in (two_locations["root_trash"], two_locations["nas_trash"]):
            assert len(list((trash / "files").iterdir())) == 2
