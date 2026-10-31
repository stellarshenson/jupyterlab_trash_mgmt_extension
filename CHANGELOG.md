# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.1.20] - 2026-10-31

### Changed

- Apply the template files and packages the upgrade left out

## [1.1.18] - 2026-10-31

### Changed

- Upgrade to extension template v4.6.5 and Makefile 1.46

### Fixed

- Take the scoped @stellarshenson/jupyterlab-trash-mgmt-extension npm name

## [1.1.16] - 2026-10-30

### Changed

- Panel labels, titles, the list's `aria-label` and the delete and empty dialogs are read from the translation bundle, and the four panel commands declare their arguments with `describedBy`
- `@jupyterlab/translation` is a direct dependency at the version the lock already resolves

### Fixed

- The Build workflow's integration test no longer fails when other browser specs add items to the shared trash while the performance spec waits for its seeded count
- The source produces no ESLint warnings; the 23 warnings are cleared

## [1.1.15] - 2026-10-30

### Changed

- Motion always runs: the `reduced motion` chip, the `force motion` toggle and the `prefers-reduced-motion` styles are removed, so the refresh icon and the loading ring turn under every system preference
- The summary bar drops the wrap rule that only the removed controls needed
- The README shows a full-screen, high-resolution screenshot of the panel with eight items in the trash
- The unit and Galata specs assert that no motion control is rendered and that both spinner animations keep `jp-trash-panel-spin`

## [1.1.14] - 2026-10-29

### Added

- Keyboard control of the list: one tab stop, arrow and Home/End navigation, Space to select, Enter to open a folder, Shift+F10 for the row menu, and focus kept across the 10-second reload
- A `reduced motion` chip and a `force motion` toggle, on by default, so both spinners keep turning under a reduced-motion preference
- Galata browser specs for the panel: an Empty Trash run over 10,000 seeded items and the spinner motion under both preferences

### Changed

- Empty Trash and listing no longer block the Jupyter server: the handlers run off the event loop, directory sizes are cached behind an mtime check and an epoch guard, and the walk uses `os.scandir`
- Deletion times are returned with the server's UTC offset, so the age shown is right from another time zone
- Rows with an equal sort key break the tie by path, and the shift-click range starts at the clicked row after a sort change
- The active-row ring is scoped to the focused list and measures 11.18:1 in the light theme and 6.19:1 in the dark one

### Fixed

- Emptying a trash of tens of thousands of items froze every request in the lab until the deletion finished
- Restoring or deleting a nested item left the folder's cached size stale
- Two concurrent empties reported failure although the trash was emptied
- A folder removed while listing answered a generic 500 instead of the endpoint error
- The spinner stood still under a reduced-motion preference

## [1.1.13] - 2026-10-22

### Added

- Acceptance criterion `ACC-MOTION-58-SPIN` in a new `MOTION` category: the refresh icon and the loading ring keep rotating while the system prefers reduced motion

### Changed

- Tracker and journal only; no extension code changed in this release. The criterion is open, because `style/base.css` still stops both animations under `prefers-reduced-motion: reduce`

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
