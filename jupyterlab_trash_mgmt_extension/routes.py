import errno
import json
import os
import shutil
import stat
import threading
import time
import urllib.parse
from configparser import ConfigParser
from datetime import datetime
from pathlib import Path

from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
import tornado


def get_trash_dir() -> Path:
    """Get the XDG trash directory path."""
    xdg_data_home = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    return Path(xdg_data_home) / 'Trash'


# The root the cache and the home trashes are found under. Tests point it at a temporary tree.
HOMES_ROOT = Path('/home')

# The standardised labels: the xdg trash under HOME, and the notebook root.
LABEL_HOME = 'HOME'
LABEL_WORKSPACE = 'WORKSPACE'


def resolve_locations(locations, root_dir: str) -> list[str]:
    """The monitored locations as absolute paths: '~' expanded, a relative path joined to the server root."""
    return [
        os.path.abspath(os.path.join(root_dir, os.path.expanduser(location)))
        for location in locations
    ]


_RMTREE_ATTEMPTS = 3
_RMTREE_RETRY_DELAY = 0.1


def remove_tree(path) -> None:
    """Remove a directory tree, retrying while another process refills it.

    ENOTEMPTY during the walk means an entry was recreated after rmtree
    removed it; the writer gets a few short waits before the error is raised.
    A directory on another device is a mount point (rm --one-file-system): it
    and the folders above it stay, everything else goes, and OSError names it.
    """
    # A bind mount of the same file system shares st_dev, so it is not detected
    # here or in get_dir_size and its contents are deleted and counted.
    device = os.lstat(path).st_dev
    mounts = []
    for top, dirs, _ in os.walk(path):
        for name in list(dirs):
            if os.lstat(os.path.join(top, name)).st_dev != device:
                mounts.append(os.path.join(top, name))
                dirs.remove(name)
    if mounts:
        keep = set()
        for mount in mounts:
            while mount != path:
                keep.add(mount)
                mount = os.path.dirname(mount)
        for folder in [path, *(keep - set(mounts))]:
            for child in os.scandir(folder):
                if child.path in keep:
                    continue
                if child.is_dir(follow_symlinks=False):
                    shutil.rmtree(child.path)
                else:
                    os.unlink(child.path)
        raise OSError(f"{', '.join(mounts)}: holds a mount point, left in the trash")
    for attempt in range(1, _RMTREE_ATTEMPTS + 1):
        try:
            shutil.rmtree(path)
            return
        except OSError as error:
            if error.errno != errno.ENOTEMPTY or attempt == _RMTREE_ATTEMPTS:
                raise
            time.sleep(_RMTREE_RETRY_DELAY)


def remove_entry(entry: Path) -> None:
    """Remove one trashed entry, unlinking a symlink instead of following it."""
    if entry.is_symlink():
        entry.unlink()
    elif entry.is_dir():
        remove_tree(str(entry))
    else:
        entry.unlink()


# Directory sizes keyed by absolute path: (lstat mtime_ns, exact byte size).
_dir_size_cache: dict[str, tuple[int, int]] = {}
_dir_size_epoch = 0
_dir_size_lock = threading.Lock()


def get_dir_size(path: Path) -> int:
    """Calculate total size of a directory recursively. Symlinks count as the link itself.

    A directory on another device is a mount point: its contents are not counted (du -x).
    """
    try:
        device = os.lstat(path).st_dev
    except (PermissionError, OSError):
        return 0
    total = 0
    pending = [path]
    while pending:
        try:
            entries = list(os.scandir(pending.pop()))
        except (PermissionError, OSError):
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    total += entry.stat(follow_symlinks=False).st_size
                elif entry.is_dir(follow_symlinks=False):
                    if os.lstat(entry.path).st_dev == device:
                        pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
            except (PermissionError, OSError):
                continue
    return total


def get_dir_size_cached(path: Path) -> int:
    """Directory size from the process cache while the directory mtime is unchanged."""
    key = os.path.abspath(path)
    try:
        mtime_ns = path.lstat().st_mtime_ns
    except (PermissionError, OSError):
        return 0
    with _dir_size_lock:
        cached = _dir_size_cache.get(key)
        epoch = _dir_size_epoch
    if cached is not None and cached[0] == mtime_ns:
        return cached[1]
    size = get_dir_size(path)
    with _dir_size_lock:
        # An invalidation during the walk makes this size stale before it is stored.
        if epoch == _dir_size_epoch:
            _dir_size_cache[key] = (mtime_ns, size)
    return size


def invalidate_dir_size(path: Path, trash_dir: Path | None = None) -> None:
    """Drop the cached size of a path, of the cached paths beneath it, and of its ancestors.

    A mutation deeper in a folder changes that folder's total but not its mtime,
    so a cached ancestor would otherwise keep serving the size from before it.
    """
    global _dir_size_epoch
    key = os.path.abspath(path)
    prefix = key + os.sep
    root = os.path.abspath((trash_dir or get_trash_dir()) / 'files')
    with _dir_size_lock:
        _dir_size_epoch += 1
        for cached in list(_dir_size_cache):
            if cached == key or cached.startswith(prefix):
                del _dir_size_cache[cached]
        ancestor = os.path.dirname(key)
        while ancestor == root or ancestor.startswith(root + os.sep):
            _dir_size_cache.pop(ancestor, None)
            if ancestor == root:
                break
            ancestor = os.path.dirname(ancestor)


def prune_dir_sizes(listed: Path, names: set) -> None:
    """Drop cached sizes under a listing for entries that are no longer there."""
    global _dir_size_epoch
    prefix = os.path.abspath(listed) + os.sep
    with _dir_size_lock:
        for cached in list(_dir_size_cache):
            if cached.startswith(prefix):
                first = cached[len(prefix):].split(os.sep, 1)[0]
                if first not in names:
                    del _dir_size_cache[cached]
                    _dir_size_epoch += 1


def clear_dir_sizes() -> None:
    """Drop every cached directory size."""
    global _dir_size_epoch
    with _dir_size_lock:
        _dir_size_epoch += 1
        _dir_size_cache.clear()


def get_item_size(path: Path) -> int:
    """Get size of file or directory. Handles symlinks by reporting link size."""
    if path.is_symlink():
        try:
            return path.lstat().st_size
        except (PermissionError, OSError):
            return 0
    if path.is_dir():
        return get_dir_size_cached(path)
    try:
        return path.stat().st_size
    except (PermissionError, OSError):
        return 0


def format_size(size_bytes: int) -> str:
    """Format size in human readable format."""
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            if unit == 'B':
                return f"{size_bytes} {unit}"
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def parse_trashinfo(info_path: Path, location: str | None = None) -> dict:
    """Parse a .trashinfo file and return metadata.

    A relative Path, as send2trash writes in a location trash, is joined to
    that location; an absolute Path is kept.
    """
    result = {
        'original_path': '',
        'deletion_date': ''
    }
    try:
        config = ConfigParser()
        config.read(info_path)
        if config.has_section('Trash Info'):
            # Use raw=True to prevent interpolation of % characters in URL-encoded paths
            path = config.get('Trash Info', 'Path', fallback='', raw=True)
            original_path = urllib.parse.unquote(path)
            if location and original_path:
                original_path = os.path.join(location, original_path)
            result['original_path'] = original_path
            value = config.get('Trash Info', 'DeletionDate', fallback='', raw=True)
            try:
                # send2trash stores local time with no offset; tag it with the server's
                value = datetime.fromisoformat(value).astimezone().isoformat()
            except ValueError:
                pass
            result['deletion_date'] = value
    except Exception:
        pass
    return result


def resolve_trash_path(trash_path, trash_dir: Path | None = None) -> Path:
    """Map a path relative to Trash/files onto the filesystem.

    Raises ValueError for a path that could leave Trash/files: an absolute
    path, a `.`, `..` or empty segment, or a parent segment that is a symlink.
    The last segment may itself be a symlink - the entry is the link.
    """
    if not isinstance(trash_path, str) or not trash_path or '\x00' in trash_path:
        raise ValueError('Invalid trash path')
    parts = trash_path.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('Invalid trash path')
    current = (trash_dir or get_trash_dir()) / 'files'
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ValueError('Invalid trash path')
    return current / parts[-1]


def get_trash_metadata(
    trash_path: str, trash_dir: Path | None = None, location: str | None = None
) -> dict:
    """Original path and deletion date of an entry at any depth.

    Both come from the .trashinfo of the top-level item; a nested entry gets
    the original path of that item extended by its own relative path.
    """
    top, _, inner = trash_path.partition('/')
    info_file = (trash_dir or get_trash_dir()) / 'info' / f"{top}.trashinfo"
    metadata = parse_trashinfo(info_file, location) if info_file.exists() else {}
    original_path = metadata.get('original_path', '')
    if original_path and inner:
        original_path = str(Path(original_path) / inner)
    return {
        'original_path': original_path,
        'deletion_date': metadata.get('deletion_date', '')
    }


def collect_listing(
    folder: str, trash_dir: Path | None = None, location: str | None = None
) -> tuple[int | None, dict]:
    """Build the /list response body for a folder path, with its HTTP status."""
    # strip=False: a folder name may start or end with a space
    listed = (trash_dir or get_trash_dir()) / 'files'

    if folder:
        try:
            listed = resolve_trash_path(folder, trash_dir)
        except ValueError as e:
            return 400, {'error': str(e)}

        # A symlink is never followed, it would list a folder outside the trash.
        # Path.exists() reads EACCES as absent; lstat and stat report it.
        try:
            if stat.S_ISLNK(os.lstat(listed).st_mode):
                return 400, {'error': 'Invalid trash path'}
            mode = os.stat(listed).st_mode
        except FileNotFoundError:
            return 404, {'error': 'Folder not found in trash'}
        except OSError as error:
            return 500, {'error': str(error)}
        if not stat.S_ISDIR(mode):
            return 400, {'error': 'Not a folder'}

    # Inside a folder every entry shares the trashinfo of the top-level item
    folder_metadata = get_trash_metadata(folder, trash_dir, location) if folder else None

    items = []
    names = set()
    total_size = 0

    try:
        entries = list(listed.iterdir())
    except FileNotFoundError:
        # A missing folder is a removed folder, or an empty trash without one
        if folder:
            return 404, {'error': 'Folder not found in trash'}
        entries = []
    except OSError as error:
        return 500, {'error': str(error)}
    for entry in entries:
        names.add(entry.name)
        try:
            if folder_metadata is None:
                trash_path = entry.name
                metadata = get_trash_metadata(trash_path, trash_dir, location)
            else:
                trash_path = f"{folder}/{entry.name}"
                original_path = folder_metadata['original_path']
                metadata = {
                    'original_path': str(Path(original_path) / entry.name) if original_path else '',
                    'deletion_date': folder_metadata['deletion_date']
                }

            size = get_item_size(entry)
            total_size += size

            is_dir = entry.is_dir()
            is_symlink = entry.is_symlink()

            items.append({
                'name': entry.name,
                'trash_path': trash_path,
                'original_path': metadata.get('original_path', ''),
                'deletion_date': metadata.get('deletion_date', ''),
                'size': size,
                'size_formatted': format_size(size),
                'is_dir': is_dir,
                'is_symlink': is_symlink
            })
        except (PermissionError, OSError):
            continue

    prune_dir_sizes(listed, names)

    # Sort by deletion date (most recent first)
    items.sort(key=lambda x: x.get('deletion_date', ''), reverse=True)

    return None, {
        'items': items,
        'total_size': total_size,
        'total_size_formatted': format_size(total_size),
        'item_count': len(items)
    }


def source_label(path, homes) -> str:
    """The label of a source path: the server user's home folder shows as '~'.

    homes is HOME as spelled, then HOME with its symbolic links resolved. The
    path is compared as spelled and never resolved, so a symbolic link inside
    HOME keeps its '~' label. The order matters only when one HOME spelling
    lies inside the other. The standardised HOME and WORKSPACE labels bypass
    this function.
    """
    for home in homes:
        try:
            rest = Path(path).relative_to(home)
        except ValueError:
            continue
        return '~' if rest == Path('.') else f'~/{rest}'
    return str(path)


def source_candidates(locations=()) -> list[dict]:
    """Every possible trash source in display order, present or not.

    The first monitored location is the notebook root, so its label reads
    WORKSPACE wherever the root lives; later locations use source_label. The
    root never reads HOME: the home trash already does, and the two
    standardised trashes never share a label.
    A home is only a candidate when its own directory is a real directory:
    a symlink under the homes root is not followed out of that root.
    Each monitored location adds its .Trash-<uid>, and its .Trash/<uid> when
    .Trash is a sticky directory that is not a symlink.
    """
    user_home = Path(os.path.abspath(os.path.expanduser('~')))
    user_homes = (user_home, user_home.resolve())
    xdg_label = source_label(get_trash_dir(), user_homes)
    candidates = [
        {
            'id': 'xdg',
            # A trash under HOME belongs to the home folder, so it reads HOME
            'label': LABEL_HOME if xdg_label.startswith('~') else xdg_label,
            'path': get_trash_dir(),
            'root': get_trash_dir().parent
        },
        {
            'id': 'cache',
            'label': source_label(HOMES_ROOT / 'cache', user_homes),
            'path': HOMES_ROOT / 'cache',
            'root': HOMES_ROOT
        },
    ]

    try:
        homes = sorted(os.scandir(HOMES_ROOT), key=lambda entry: entry.name)
    except OSError:
        homes = []
    for entry in homes:
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        home = Path(entry.path)
        candidates.append({
            'id': f'home:{entry.name}',
            'label': source_label(home, user_homes),
            'path': home / '.local' / 'share' / 'Trash',
            'root': home
        })

    uid = os.getuid()
    for index, location in enumerate(locations):
        top = Path(location)
        label = LABEL_WORKSPACE if index == 0 else source_label(top, user_homes)
        trashes = [top / f'.Trash-{uid}']
        try:
            mode = (top / '.Trash').lstat().st_mode
        except OSError:
            mode = 0
        if stat.S_ISDIR(mode) and mode & stat.S_ISVTX:
            trashes.append(top / '.Trash' / str(uid))
        for trash in trashes:
            candidates.append({
                'id': f'location:{trash}',
                'label': label,
                'path': trash,
                'root': top,
                'location': str(top)
            })
    return candidates


def resolve_source(candidate: dict) -> Path | None:
    """The source's resolved trash directory, or None when absent or outside its root.

    A directory that raises any other error is still returned, so the caller
    reports it instead of dropping the source.
    """
    directory = Path(os.path.realpath(candidate['path']))
    try:
        directory.relative_to(Path(os.path.realpath(candidate['root'])))
    except ValueError:
        return None
    try:
        info = directory.stat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return directory
    if not stat.S_ISDIR(info.st_mode):
        return None
    return directory


def existing_sources(locations=()) -> list[dict]:
    """Every existing source in display order, with its resolved directory.

    A candidate whose directory has the file identity (device and inode) of one
    an earlier candidate already returned is skipped, so a bind mount alias of
    an earlier source is listed once. A resolved path cannot see a bind mount.
    """
    sources = []
    seen = set()
    for candidate in source_candidates(locations):
        directory = resolve_source(candidate)
        if directory is None:
            continue
        try:
            info = directory.stat()
        except OSError:
            # The source exists but cannot be statted: keep it so its error is reported
            sources.append({**candidate, 'directory': directory})
            continue
        identity = (info.st_dev, info.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        sources.append({**candidate, 'directory': directory})
    return sources


def collect_sources(locations=()) -> list[dict]:
    """The /sources response: each existing source with its count and size."""
    sources = []
    for source in existing_sources(locations):
        entry = {
            'id': source['id'],
            'label': source['label'],
            'item_count': 0,
            'total_size': format_size(0),
            'total_bytes': 0,
            'error': '',
            'location': str(source['directory'])
        }
        try:
            # Count and size only: the full listing parses every trashinfo
            files = source['directory'] / 'files'
            try:
                sizes = [get_item_size(item) for item in files.iterdir()]
            except FileNotFoundError:
                # No trash folder yet is an empty trash
                sizes = []
            entry['item_count'] = len(sizes)
            entry['total_bytes'] = sum(sizes)
            entry['total_size'] = format_size(entry['total_bytes'])
        except (PermissionError, OSError) as error:
            entry['error'] = str(error)
        sources.append(entry)
    # The XDG trash is always monitored, so a missing folder is an empty trash
    if not any(entry['id'] == 'xdg' for entry in sources):
        sources.insert(0, {
            'id': 'xdg',
            'label': source_candidates(locations)[0]['label'],
            'item_count': 0,
            'total_size': format_size(0),
            'total_bytes': 0,
            'error': '',
            'location': str(source_candidates(locations)[0]['path'])
        })
    return sources


def find_source(source_id, locations=()) -> dict | None:
    """The candidate with this source id, or None for an unknown id."""
    return next(
        (item for item in source_candidates(locations) if item['id'] == source_id), None
    )


def collect_source_listing(source_id: str, folder: str, locations=()) -> tuple[int | None, dict]:
    """The /list response for one source id."""
    candidate = find_source(source_id, locations)
    if candidate is None:
        return 400, {'error': 'Unknown trash source'}

    directory = resolve_source(candidate)
    if directory is not None:
        return collect_listing(folder, directory, candidate.get('location'))

    if folder:
        return 404, {'error': 'Folder not found in trash'}
    return None, {
        'items': [],
        'total_size': 0,
        'total_size_formatted': format_size(0),
        'item_count': 0
    }


class TrashStatusHandler(APIHandler):
    """Handler for checking if trash functionality is enabled."""

    @tornado.web.authenticated
    async def get(self):
        # Check if FileContentsManager.delete_to_trash is enabled
        contents_manager = self.settings.get('contents_manager')
        trash_enabled = getattr(contents_manager, 'delete_to_trash', False) if contents_manager else False

        self.finish(json.dumps({
            'trash_enabled': trash_enabled
        }))


class TrashSourcesHandler(APIHandler):
    """Handler for listing the available trash sources."""

    @tornado.web.authenticated
    async def get(self):
        sources = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, collect_sources, self.settings.get('trash_locations', [])
        )
        self.finish(json.dumps(sources))


class TrashListHandler(APIHandler):
    """Handler for listing trash contents."""

    @tornado.web.authenticated
    async def get(self):
        folder = self.get_argument('path', '', strip=False)
        source = self.get_argument('source', 'xdg')

        status, body = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, collect_source_listing, source, folder,
            self.settings.get('trash_locations', [])
        )

        if status is not None:
            self.set_status(status)
        self.finish(json.dumps(body))


def restore_item(
    trash_path: str, source_id: str | None = None, locations=()
) -> tuple[int | None, dict]:
    """Restore one trashed entry. Returns the HTTP status and response body.

    Without a source id the entry is in the XDG trash; with one it is in
    that source's trash.
    """
    trash_dir = None
    location = None
    if source_id is not None:
        candidate = find_source(source_id, locations)
        if candidate is None:
            return 400, {'error': 'Unknown trash source'}
        trash_dir = resolve_source(candidate)
        if trash_dir is None:
            return 404, {'error': 'Item not found in trash'}
        location = candidate.get('location')

    try:
        source = resolve_trash_path(trash_path, trash_dir)
    except ValueError as e:
        return 400, {'error': str(e)}

    info_file = (trash_dir or get_trash_dir()) / 'info' / f"{trash_path}.trashinfo"

    if not source.exists() and not source.is_symlink():
        return 404, {'error': 'Item not found in trash'}

    # Get original path from the trashinfo of the top-level item
    original_path = get_trash_metadata(trash_path, trash_dir, location)['original_path']

    if not original_path:
        return 400, {'error': 'Cannot determine original path'}

    dest = Path(original_path)

    # Check if destination already exists
    if dest.exists() or dest.is_symlink():
        return 409, {'error': f'Destination already exists: {original_path}'}

    # Ensure parent directory exists
    dest.parent.mkdir(parents=True, exist_ok=True)

    try:
        shutil.move(str(source), str(dest))
        # Only a top-level item has a trashinfo file of its own
        if '/' not in trash_path and info_file.exists():
            info_file.unlink()
        result = None, {
            'success': True,
            'restored_to': original_path
        }
    except Exception as e:
        result = 500, {'error': str(e)}
    invalidate_dir_size(source, trash_dir)
    return result


class TrashRestoreHandler(APIHandler):
    """Handler for restoring items from trash."""

    @tornado.web.authenticated
    async def post(self):
        data = json.loads(self.request.body)
        trash_path = data.get('trash_path', '')

        if not trash_path:
            self.set_status(400)
            self.finish(json.dumps({'error': 'No trash_path provided'}))
            return

        status, body = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, restore_item, trash_path, data.get('source'),
            self.settings.get('trash_locations', [])
        )

        if status is not None:
            self.set_status(status)
        self.finish(json.dumps(body))


def delete_item(
    trash_path: str, source_id: str | None = None, locations=()
) -> tuple[int | None, dict]:
    """Permanently delete one trashed entry. Returns the HTTP status and body.

    Without a source id the entry is in the XDG trash; with one it is in
    that source's trash.
    """
    trash_dir = None
    if source_id is not None:
        candidate = find_source(source_id, locations)
        if candidate is None:
            return 400, {'error': 'Unknown trash source'}
        trash_dir = resolve_source(candidate)
        if trash_dir is None:
            return 404, {'error': 'Item not found in trash'}

    try:
        target = resolve_trash_path(trash_path, trash_dir)
    except ValueError as e:
        return 400, {'error': str(e)}

    info_file = (trash_dir or get_trash_dir()) / 'info' / f"{trash_path}.trashinfo"

    if not target.exists() and not target.is_symlink():
        return 404, {'error': 'Item not found in trash'}

    try:
        remove_entry(target)

        # Only a top-level item has a trashinfo file of its own
        if '/' not in trash_path and info_file.exists():
            info_file.unlink()

        return None, {'success': True}
    except Exception as e:
        return 500, {'error': str(e)}
    finally:
        invalidate_dir_size(target, trash_dir)


class TrashDeleteHandler(APIHandler):
    """Handler for permanently deleting items from trash."""

    @tornado.web.authenticated
    async def post(self):
        data = json.loads(self.request.body)
        trash_path = data.get('trash_path', '')

        if not trash_path:
            self.set_status(400)
            self.finish(json.dumps({'error': 'No trash_path provided'}))
            return

        status, body = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, delete_item, trash_path, data.get('source'),
            self.settings.get('trash_locations', [])
        )

        if status is not None:
            self.set_status(status)
        self.finish(json.dumps(body))


def empty_source(trash_dir: Path) -> tuple[int, list[str]]:
    """Delete every item in one trash directory. Returns the count and the errors."""
    files_dir = trash_dir / 'files'
    info_dir = trash_dir / 'info'

    deleted_count = 0
    errors = []

    # Delete all files in trash
    try:
        entries = list(files_dir.iterdir())
    except FileNotFoundError:
        # No trash folder yet is an empty trash
        entries = []
    except (PermissionError, OSError) as error:
        # The trash could not be listed, so no entry is known removed; keep
        # every trashinfo for Restore (DEF-API-30)
        return deleted_count, errors + [str(error)]
    for entry in entries:
        try:
            remove_entry(entry)
            deleted_count += 1
        except FileNotFoundError:
            # A concurrent empty removed the entry first: it is gone either way
            pass
        except Exception as e:
            errors.append(f"{entry.name}: {str(e)}")

    # Delete the trashinfo files, except those of an entry that could not be
    # removed or examined: it stays in the trash and Restore needs its original path
    try:
        infos = list(info_dir.iterdir())
    except FileNotFoundError:
        infos = []
    except OSError as error:
        # The trashinfos cannot be listed; keep them and report why
        errors.append(str(error))
        infos = []
    for entry in infos:
        try:
            os.lstat(files_dir / entry.name.removesuffix('.trashinfo'))
        except FileNotFoundError:
            # The entry is gone, so its trashinfo is an orphan
            try:
                entry.unlink()
            except Exception:
                pass
        except OSError:
            # The entry cannot be examined; keep its trashinfo for Restore
            continue

    return deleted_count, errors


def is_under(path: str, root: Path) -> bool:
    """True when a recorded original path resolves at or below root."""
    if not path:
        return False
    try:
        Path(path).resolve().relative_to(root)
    except (ValueError, OSError):
        return False
    return True


def empty_workspace(
    trash_dir: Path, root: Path, location: str | None = None
) -> tuple[int, int, list[str]]:
    """Delete only workspace entries from one trash directory.

    Returns the deleted count, the left count and the errors.
    """
    files_dir = trash_dir / 'files'
    info_dir = trash_dir / 'info'

    deleted_count = 0
    left_count = 0
    errors = []

    try:
        entries = list(files_dir.iterdir())
    except FileNotFoundError:
        # No trash folder yet is an empty trash
        entries = []
    for entry in entries:
        info_file = info_dir / f"{entry.name}.trashinfo"
        original_path = parse_trashinfo(info_file, location).get('original_path', '')
        if not is_under(original_path, root):
            left_count += 1
            continue
        try:
            remove_entry(entry)
        except FileNotFoundError:
            # A concurrent delete removed the entry first: it is gone either way
            continue
        except Exception as e:
            left_count += 1
            errors.append(f"{entry.name}: {str(e)}")
            continue
        deleted_count += 1
        try:
            info_file.unlink()
        except OSError:
            pass

    return deleted_count, left_count, errors


def empty_trash(
    scope: str = 'xdg', workspace_root: str | None = None, locations=(),
    source_id: str | None = None
) -> tuple[int | None, dict]:
    """Empty the trash for a scope. Returns the HTTP status and response body.

    'xdg' keeps the single-trash response, and 'source' gives it for the one
    source with source_id. 'all' empties every existing source and 'workspace'
    deletes only each source's entries under the workspace root.
    """
    if scope in ('xdg', 'source'):
        trash_dir = get_trash_dir()
        if scope == 'source':
            candidate = find_source(source_id, locations)
            if candidate is None:
                return 400, {'error': 'Unknown trash source'}
            trash_dir = resolve_source(candidate)
        if trash_dir:
            deleted_count, errors = empty_source(trash_dir)
            # Only this trash changed, so the other sources keep their cached sizes
            invalidate_dir_size(trash_dir / 'files', trash_dir)
        else:
            deleted_count, errors = 0, []
        if errors:
            return None, {
                'success': False,
                'deleted_count': deleted_count,
                'errors': errors
            }
        return None, {
            'success': True,
            'deleted_count': deleted_count
        }

    root = Path(workspace_root).resolve() if workspace_root else None
    results = []
    for source in existing_sources(locations):
        entry = {
            'id': source['id'],
            'label': source['label'],
            'deleted_count': 0,
            'errors': []
        }
        try:
            os.stat(source['directory'])
        except FileNotFoundError:
            # Enumerated but gone before the run: it was not emptied
            entry['errors'] = ['the source is no longer available']
            results.append(entry)
            continue
        except OSError:
            pass
        try:
            if scope == 'all':
                entry['deleted_count'], entry['errors'] = empty_source(source['directory'])
            else:
                deleted, left, errors = empty_workspace(
                    source['directory'], root, source.get('location')
                )
                entry['deleted_count'] = deleted
                entry['left_count'] = left
                entry['errors'] = errors
        except (PermissionError, OSError) as error:
            entry['errors'] = [str(error)]
        results.append(entry)

    clear_dir_sizes()

    body = {
        'success': not any(entry['errors'] for entry in results),
        'deleted_count': sum(entry['deleted_count'] for entry in results),
        'sources': results
    }
    if scope == 'workspace' and all('left_count' in entry for entry in results):
        body['left_count'] = sum(entry['left_count'] for entry in results)
    return None, body


class TrashEmptyHandler(APIHandler):
    """Handler for emptying the entire trash."""

    @tornado.web.authenticated
    async def post(self):
        data = json.loads(self.request.body) if self.request.body else {}
        scope = data.get('scope', 'xdg')

        if scope not in ('xdg', 'source', 'all', 'workspace'):
            self.set_status(400)
            self.finish(json.dumps({'error': f'Unknown scope: {scope}'}))
            return

        workspace_root = None
        if scope == 'workspace':
            workspace_root = self.settings.get('server_root_dir')
            if not workspace_root:
                contents_manager = self.settings.get('contents_manager')
                workspace_root = getattr(contents_manager, 'root_dir', None)
            if not workspace_root:
                self.set_status(400)
                self.finish(json.dumps({'error': 'Workspace root is unknown'}))
                return

        status, body = await tornado.ioloop.IOLoop.current().run_in_executor(
            None, empty_trash, scope, workspace_root,
            self.settings.get('trash_locations', []), data.get('source')
        )

        if status is not None:
            self.set_status(status)
        self.finish(json.dumps(body))


def setup_route_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    base_route = url_path_join(base_url, "jupyterlab-trash-mgmt-extension")

    handlers = [
        (url_path_join(base_route, "status"), TrashStatusHandler),
        (url_path_join(base_route, "sources"), TrashSourcesHandler),
        (url_path_join(base_route, "list"), TrashListHandler),
        (url_path_join(base_route, "restore"), TrashRestoreHandler),
        (url_path_join(base_route, "delete"), TrashDeleteHandler),
        (url_path_join(base_route, "empty"), TrashEmptyHandler),
    ]

    web_app.add_handlers(host_pattern, handlers)
