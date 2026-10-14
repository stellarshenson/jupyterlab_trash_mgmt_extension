# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.1.12] - 2026-10-14

### Added

- Folder navigation: a double-click opens a trashed folder at any depth, a breadcrumb row leads back, and single items inside a folder can be restored or deleted permanently
- Panel header with the title `TRASH MANAGEMENT`, the Empty Trash and Refresh icons, and a summary bar with the item count and total size of the location in view
- Widget tests (jest), handler tests through `jp_fetch` (pytest) and a Galata browser test job in CI

### Changed

- The loading veil covers the panel only on the first load and while restore, delete or empty runs; a refresh rotates the refresh icon and the list stays usable
- The deletion time reads in a short form (`59m ago`, `4w ago`) in a 60 px column labelled `Deleted`, which gives the name column 30 px more
- A selected row has its own background, distinct from the row under the pointer
- Project template extension-template 4.6.5, canonical Makefile 1.45 and dependencies on the JupyterLab 4.6 line; the extension requires JupyterLab 4.6 or higher

### Fixed

- `list`, `restore` and `delete` reject a path that leaves the trash (absolute path, `..`, symbolic link); before, `delete` with `../x` removed that target
- Restore answers 409 and keeps a symbolic link with an absent target at the original path instead of replacing it
- Empty Trash reports the items it could not remove
- The selection survives the 10-second reload
- The refresh icon turns for the whole load, 500 ms at least
- Restore and Delete report their errors also when the list reload after them fails
- The size of a folder counts a symbolic link inside it as a link, not its target
- The time column no longer shows `0 months ago` or `0 years ago`

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
