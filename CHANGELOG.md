# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.1.36] - 2026-11-18

### Added

- A section band's label tooltip names the mountpoint of the volume holding that band's trash, as `HOME on /home` and `WORKSPACE on /home`; the server resolves it from the trash folder's nearest mount

### Fixed

- The entries box draws no scrollbar during the harmonica pull or fold, when its height is shorter than its rows; an empty trash no longer shows a bar while the bands trade heights

## [1.1.35] - 2026-11-18

### Changed

- Band labels read HOME for the home trash and WORKSPACE for the notebook root, wherever the root lives; the notebook root never reads HOME, so the two standardised trashes never share a label, and every other label keeps its tilde or path

## [1.1.34] - 2026-11-18

### Added

- The section bands fold by the design system's harmonica navigation: the wheel at a list end previews the neighbour's rows by a quarter of the scroll distance, the event that brings the pull to the give length folds over 400 ms and opens the next band, and wheel events during the fold do nothing; a click, Enter or Space opens a band
- A short open band leaves the next band directly under its last row, and a panel too short for the bands scrolls the column so every band stays reachable

### Changed

- The open section takes only its content height; a section takes the remaining space only when its rows exceed it, replacing the 40 percent cap of the sections container
- Folded sections keep their rows in the document, out of sight and out of the tab order, so the fold preview shows the neighbour's rows

## [1.1.33] - 2026-11-18

### Changed

- Empty All Bins and Clean Workspace report their outcome in a 3 second success notification with the total deleted count and the left count when known; the result dialog with Ok is gone
- The confirmation before the run still lists each source with its count and size; a failure opens the error dialog with the per-source counts and errors

### Fixed

- A trashed source that cannot be read, or that vanishes while the run proceeds, is reported as an error instead of an empty trash
- A workspace clean whose source raised an error answers with the per-source errors instead of a 500
- The trashinfo of an entry that could not be removed survives an unreadable files or info directory, so Restore keeps its original path

## [1.1.32] - 2026-11-18

### Added

- A filter button in the panel header opens a search box; typing narrows the main list and every section to the files and folders whose name or original path contains the text, ignoring case; the clear button restores every row and the caret stays in the field

### Changed

- Trash buttons stay visible and are disabled while their trash holds no items, instead of hiding
- With Show Volumes on, the summary bar totals every trash and each trash is a foldable band below it: the home trash `~` first holding the main list, one band per other trash, an empty band reading Trash is empty; the menu reads Hide Volumes while the volumes show
- The band count, the total line and the band trash button follow Restore and Delete at once, before the next sources answer
- A menu opened on a disabled trash button returns the focus to the panel
- The sources answer carries each trash's size in bytes

### Fixed

- An expanded empty section band showed no Trash is empty line
- The home trash was labelled with its trash folder instead of `~`

## [1.1.29] - 2026-11-17

### Added

- Show Volumes is in every right-click menu of the panel: the summary bar, the main list, every section band and every row; in a row menu it follows the row actions after a separator
- With Show Volumes on, the summary bar starts with the home trash label, `~/.local/share/Trash` by default

### Changed

- A trash label under the home folder starts with `~`, as `~/workspace`; the home trash is labelled by its folder instead of `Trash`; a home folder reached through a symbolic link gets `~` in both spellings
- Clean All Sources is named Empty All Bins in the command palette and its dialogs
- The band and summary bar trash buttons draw an 18px box with rounded corners inside the band

### Fixed

- A right-click in the panel outside the header opened the browser menu
- Keyboard focus fell to the page body after a panel menu closed or Show Volumes removed the focused band or row; every panel menu returns the focus, whether the mouse or the keyboard opened it
- After Delete or Restore the main list jumped to its first row; the neighbour row becomes active and the list keeps its place

## [1.1.28] - 2026-11-16

### Added

- Show Volumes: a checkable entry in the panel header's right-click menu and in the command palette under Trash; off by default and remembered in the browser; while on, each trash shows as its own section
- With Show Volumes on, each section band has a trash button beside its fold toggle that empties only that trash after a dialog naming it, and the summary bar has a trash button that empties only the home trash
- Every row of every trash offers Restore, `/home/cache` and the per-user home trashes included
- Server: `POST delete` takes a `source` id, and `POST empty` takes scope `source` with a `source` id; an unknown id or a path outside that trash answers 400

### Changed

- While Show Volumes is off, the main list shows the items of every trash together; each row restores and deletes in its own trash
- Delete, Restore and every empty hold the panel veil only while their own request runs; the rows they removed go at once, and a slow trash no longer holds back the others
- A section band stays one 21px line; a long folder label ends in an ellipsis and its tooltip shows the full label

### Fixed

- The header trash button empties every trash, not only the home trash; its dialog lists every trash
- After a keyboard empty the focus moves to the fold toggle or the refresh button instead of leaving the panel

## [1.1.27] - 2026-11-15

### Added

- Trash folders on other file systems: the notebook root's `.Trash-<uid>` (or `.Trash/<uid>` under a sticky `.Trash`) is always watched, and the server option `c.TrashManagement.locations` (default `[]`) adds folders; each trash folder is a section with its own item count and size
- Restore from a location section row with a right-click or Shift+F10; the row tooltip shows the original path, type, size and deletion time
- Clean All Sources and Clean Workspace include the location trashes; a trashinfo `Path` relative to its location is joined to that location

### Changed

- With the main list empty the sections take the free panel height; with items they keep the 40 percent cap
- One source count request runs at a time, so a section count can be up to one 10 s refresh old
- A section header keeps its item count and size visible when the folder label is long
- Section rows redraw only when their listing changed, so keyboard focus stays on its row
- Location rows take the main-list hover background, and lose it while their Restore menu is open
- `Trash is empty` and `Folder is empty` show as one left-aligned italic line under the summary bar, as in the other panels of the family

### Fixed

- Sizing or deleting a trashed folder stops at a file system mounted inside it; the entry stays in the trash with an error naming the mount, and a symbolic link is deleted as a link
- The main list no longer draws a white focus outline around itself; keyboard focus with no active row makes the first row active, also after Enter on a folder or a keyboard Restore or Delete

## [1.1.26] - 2026-11-13

### Changed

- Count and size a trash source without building its listing
- Skip the PayPal donate link in the link check

### Fixed

- Keep the trashinfo of an undeleted entry and list the clean commands in the palette

## [1.1.22] - 2026-11-02

### Added

- Trash source sections below the main list for `/home/cache` and every per-user home trash, each collapsible and showing its own item count and size
- `Clean All Sources` empties every source; `Clean Workspace` removes only entries whose original path lies under the workspace root and reports what it left
- Server endpoints `GET sources`, `GET list?source=` and `POST empty` with `scope` of `xdg`, `all` or `workspace`

### Changed

- The header refresh button stays static; a still ring marks a refresh in flight and clears itself when the request never returns
- The stale-load retry asks again for the newest requested folder, waits while a younger load is pending, and never draws a superseded answer over a pending navigation
- Extra sections cap at 40 percent of the panel height, so the main list keeps its share; the busy ring and the section focus ring meet 3:1 contrast
- Trash sources are deduplicated by file identity, so one trash mounted under two paths is listed once
- The Galata suite runs one spec file at a time, because its specs share one server and one seeded trash

### Fixed

- The refresh icon rotated with nothing loading and no click
- Empty Trash retries a directory a writer refilled, instead of failing with `Directory not empty`
- A home trash that is the same directory as the XDG trash was listed as a second section

## [1.1.21] - 2026-10-31

### Changed

- Require Python 3.12

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
