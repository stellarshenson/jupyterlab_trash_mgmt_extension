import json
import os
import shutil
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


def get_dir_size(path: Path) -> int:
    """Calculate total size of a directory recursively. Symlinks count as the link itself."""
    total = 0
    try:
        for entry in path.rglob('*'):
            if entry.is_symlink():
                total += entry.lstat().st_size
            elif entry.is_file():
                total += entry.stat().st_size
    except (PermissionError, OSError):
        pass
    return total


def get_item_size(path: Path) -> int:
    """Get size of file or directory. Handles symlinks by reporting link size."""
    if path.is_symlink():
        try:
            return path.lstat().st_size
        except (PermissionError, OSError):
            return 0
    if path.is_dir():
        return get_dir_size(path)
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


def parse_trashinfo(info_path: Path) -> dict:
    """Parse a .trashinfo file and return metadata."""
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
            result['original_path'] = urllib.parse.unquote(path)
            result['deletion_date'] = config.get('Trash Info', 'DeletionDate', fallback='', raw=True)
    except Exception:
        pass
    return result


def resolve_trash_path(trash_path) -> Path:
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
    current = get_trash_dir() / 'files'
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ValueError('Invalid trash path')
    return current / parts[-1]


def get_trash_metadata(trash_path: str) -> dict:
    """Original path and deletion date of an entry at any depth.

    Both come from the .trashinfo of the top-level item; a nested entry gets
    the original path of that item extended by its own relative path.
    """
    top, _, inner = trash_path.partition('/')
    info_file = get_trash_dir() / 'info' / f"{top}.trashinfo"
    metadata = parse_trashinfo(info_file) if info_file.exists() else {}
    original_path = metadata.get('original_path', '')
    if original_path and inner:
        original_path = str(Path(original_path) / inner)
    return {
        'original_path': original_path,
        'deletion_date': metadata.get('deletion_date', '')
    }


class TrashStatusHandler(APIHandler):
    """Handler for checking if trash functionality is enabled."""

    @tornado.web.authenticated
    def get(self):
        # Check if FileContentsManager.delete_to_trash is enabled
        contents_manager = self.settings.get('contents_manager')
        trash_enabled = getattr(contents_manager, 'delete_to_trash', False) if contents_manager else False

        self.finish(json.dumps({
            'trash_enabled': trash_enabled
        }))


class TrashListHandler(APIHandler):
    """Handler for listing trash contents."""

    @tornado.web.authenticated
    def get(self):
        # strip=False: a folder name may start or end with a space
        folder = self.get_argument('path', '', strip=False)
        listed = get_trash_dir() / 'files'

        if folder:
            try:
                listed = resolve_trash_path(folder)
            except ValueError as e:
                self.set_status(400)
                self.finish(json.dumps({'error': str(e)}))
                return

            # A symlink is never followed, it would list a folder outside the trash
            if listed.is_symlink():
                self.set_status(400)
                self.finish(json.dumps({'error': 'Invalid trash path'}))
                return

            if not listed.exists():
                self.set_status(404)
                self.finish(json.dumps({'error': 'Folder not found in trash'}))
                return

            if not listed.is_dir():
                self.set_status(400)
                self.finish(json.dumps({'error': 'Not a folder'}))
                return

        # Inside a folder every entry shares the trashinfo of the top-level item
        folder_metadata = get_trash_metadata(folder) if folder else None

        items = []
        total_size = 0

        if listed.exists():
            for entry in listed.iterdir():
                try:
                    if folder_metadata is None:
                        trash_path = entry.name
                        metadata = get_trash_metadata(trash_path)
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

        # Sort by deletion date (most recent first)
        items.sort(key=lambda x: x.get('deletion_date', ''), reverse=True)

        self.finish(json.dumps({
            'items': items,
            'total_size': total_size,
            'total_size_formatted': format_size(total_size),
            'item_count': len(items)
        }))


class TrashRestoreHandler(APIHandler):
    """Handler for restoring items from trash."""

    @tornado.web.authenticated
    def post(self):
        data = json.loads(self.request.body)
        trash_path = data.get('trash_path', '')

        if not trash_path:
            self.set_status(400)
            self.finish(json.dumps({'error': 'No trash_path provided'}))
            return

        try:
            source = resolve_trash_path(trash_path)
        except ValueError as e:
            self.set_status(400)
            self.finish(json.dumps({'error': str(e)}))
            return

        info_file = get_trash_dir() / 'info' / f"{trash_path}.trashinfo"

        if not source.exists() and not source.is_symlink():
            self.set_status(404)
            self.finish(json.dumps({'error': 'Item not found in trash'}))
            return

        # Get original path from the trashinfo of the top-level item
        original_path = get_trash_metadata(trash_path)['original_path']

        if not original_path:
            self.set_status(400)
            self.finish(json.dumps({'error': 'Cannot determine original path'}))
            return

        dest = Path(original_path)

        # Check if destination already exists
        if dest.exists() or dest.is_symlink():
            self.set_status(409)
            self.finish(json.dumps({'error': f'Destination already exists: {original_path}'}))
            return

        # Ensure parent directory exists
        dest.parent.mkdir(parents=True, exist_ok=True)

        try:
            shutil.move(str(source), str(dest))
            # Only a top-level item has a trashinfo file of its own
            if '/' not in trash_path and info_file.exists():
                info_file.unlink()
            self.finish(json.dumps({
                'success': True,
                'restored_to': original_path
            }))
        except Exception as e:
            self.set_status(500)
            self.finish(json.dumps({'error': str(e)}))


class TrashDeleteHandler(APIHandler):
    """Handler for permanently deleting items from trash."""

    @tornado.web.authenticated
    def post(self):
        data = json.loads(self.request.body)
        trash_path = data.get('trash_path', '')

        if not trash_path:
            self.set_status(400)
            self.finish(json.dumps({'error': 'No trash_path provided'}))
            return

        try:
            target = resolve_trash_path(trash_path)
        except ValueError as e:
            self.set_status(400)
            self.finish(json.dumps({'error': str(e)}))
            return

        info_file = get_trash_dir() / 'info' / f"{trash_path}.trashinfo"

        if not target.exists() and not target.is_symlink():
            self.set_status(404)
            self.finish(json.dumps({'error': 'Item not found in trash'}))
            return

        try:
            if target.is_symlink():
                # Symlinks should be unlinked, never rmtree'd
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(str(target))
            else:
                target.unlink()

            # Only a top-level item has a trashinfo file of its own
            if '/' not in trash_path and info_file.exists():
                info_file.unlink()

            self.finish(json.dumps({'success': True}))
        except Exception as e:
            self.set_status(500)
            self.finish(json.dumps({'error': str(e)}))


class TrashEmptyHandler(APIHandler):
    """Handler for emptying the entire trash."""

    @tornado.web.authenticated
    def post(self):
        trash_dir = get_trash_dir()
        files_dir = trash_dir / 'files'
        info_dir = trash_dir / 'info'

        deleted_count = 0
        errors = []

        # Delete all files in trash
        if files_dir.exists():
            for entry in list(files_dir.iterdir()):
                try:
                    if entry.is_symlink():
                        entry.unlink()
                    elif entry.is_dir():
                        shutil.rmtree(str(entry))
                    else:
                        entry.unlink()
                    deleted_count += 1
                except Exception as e:
                    errors.append(f"{entry.name}: {str(e)}")

        # Delete all trashinfo files
        if info_dir.exists():
            for entry in list(info_dir.iterdir()):
                try:
                    entry.unlink()
                except Exception:
                    pass

        if errors:
            self.finish(json.dumps({
                'success': False,
                'deleted_count': deleted_count,
                'errors': errors
            }))
        else:
            self.finish(json.dumps({
                'success': True,
                'deleted_count': deleted_count
            }))


def setup_route_handlers(web_app):
    host_pattern = ".*$"
    base_url = web_app.settings["base_url"]
    base_route = url_path_join(base_url, "jupyterlab-trash-mgmt-extension")

    handlers = [
        (url_path_join(base_route, "status"), TrashStatusHandler),
        (url_path_join(base_route, "list"), TrashListHandler),
        (url_path_join(base_route, "restore"), TrashRestoreHandler),
        (url_path_join(base_route, "delete"), TrashDeleteHandler),
        (url_path_join(base_route, "empty"), TrashEmptyHandler),
    ]

    web_app.add_handlers(host_pattern, handlers)
