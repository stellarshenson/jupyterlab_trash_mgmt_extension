# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## 1.0.7

- Fixed package-lock.json formatting for CI

## 1.0.6

- Multi-line hover tooltip showing original path, type, size, and deletion date
- Published to PyPI and npm

## 1.0.2

- Version bump for stable release
- Fixed `package.json` repository URLs for jupyter_releaser validation

## 0.4.7

- Added GitHub Actions CI/CD workflows (build, check-release)
- Implemented Python test suite with 22 tests for backend routes
- Added Jest configuration for frontend unit tests
- Conditional sidebar activation - only shows when `delete_to_trash=True`
- Fixed ConfigParser bug with URL-encoded paths containing `%`

## 0.4.6

- Initial release
- Dedicated sidebar panel for trash management (alongside file browser, kernels, git, extensions)
- List deleted files with name, original path, deletion date, and size
- Restore files to original location
- Permanently delete individual items
- Empty entire trash with confirmation dialog
- Right-click context menu for item actions
- Sortable columns (Name, Modified, Size)
- File browser-style UI with compact rows
- JupyterLab theme-aware styling
- XDG trash specification support (`~/.local/share/Trash/`)

<!-- <END NEW CHANGELOG ENTRY> -->
