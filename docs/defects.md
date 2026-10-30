# Defects - jupyterlab_trash_mgmt_extension

Observed wrong behaviour of the trash side panel in `src/widget.ts` and of its REST handlers in `jupyterlab_trash_mgmt_extension/routes.py`, with the record of what was tried against each.

## Authors

- `@kj` Konrad Jelen

## Server API `API`

REST handlers under `jupyterlab-trash-mgmt-extension/`

- [x] `DEF-API-1` **delete removes paths outside the trash** - CRITICAL; `POST delete` with `trash_path` `../x` or an absolute path removes that target, a directory recursively; needs an authenticated request; cause: `files_dir / trash_path` joined with no containment check; fix: reject any path that leaves `Trash/files`; `jupyterlab_trash_mgmt_extension/routes.py`
  - evidence: pytest `TestDelete::test_parent_segment_is_400` and `test_absolute_path_is_400` pass and the victim path still exists; both failed on the unfixed handler; pytest 63 passed on 2026-10-14
  - repro: create `Trash/victim/`, POST `delete` with `{"trash_path": "../victim"}`; `victim` is gone
  - test-tags: INTEGRATION
  - root-cause: 2026-10-13T21:21:56Z @kj `TrashDeleteHandler.post` deletes `files_dir / trash_path` taken from the request body; `Path` keeps `..` segments and an absolute right operand replaces the left one
  - log: 2026-10-13T21:21:56Z @kj added
  - log: 2026-10-13T21:40:59Z @kj reproduced: the unfixed `delete` handler answers 200 for `../victim` and for an absolute path; `test_parent_segment_is_400` and `test_absolute_path_is_400` fail with `DID NOT RAISE HTTPClientError`
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-API-7` **folder size follows symlinks** - MINOR; folder size counts the target of a file symlink inside it and 0 for a symlink to a folder; the folder row then disagrees with the total inside the folder, 123.8 KB against 123.9 KB; cause: `get_dir_size` follows links; fix: count a symlink by `lstat`; `jupyterlab_trash_mgmt_extension/routes.py`
  - evidence: pytest `test_get_item_size_directory_counts_symlinks_as_links` passes; in the browser the row `data` and the summary inside `data` both read 123.9 KB; pytest 63 passed on 2026-10-14
  - repro: trash a folder that holds a symlink to a 1 MB file outside the trash; the folder row shows 1.0 MB
  - test-tags: UNIT
  - root-cause: 2026-10-13T21:53:51Z @kj `get_dir_size` sums `entry.stat().st_size` for every `entry.is_file()`; both calls follow a symlink, while a top-level symlink is sized by `lstat`
  - log: 2026-10-13T21:53:51Z @kj added
  - log: 2026-10-13T21:53:51Z @kj observed on the visual-check server: row `data` showed 123.8 KB, the summary inside `data` showed 123.9 KB; the 147 B difference is the symlink `link-inside`
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-API-9` **restore replaces a broken symlink** - MINOR; restore onto an original path that holds a symbolic link with an absent target answers 200 and replaces the link; breaks `restore never overwrites an existing path`; fix: also test `dest.is_symlink()`; `jupyterlab_trash_mgmt_extension/routes.py`
  - evidence: pytest `TestRestore::test_restore_onto_a_broken_symlink_is_409` passes; it failed on the unfixed handler; confirmed by review round 2; pytest 63 passed on 2026-10-14
  - repro: put a link with an absent target at the original path of a trashed file, POST `restore`; the link is gone
  - test-tags: INTEGRATION
  - root-cause: 2026-10-13T22:42:26Z @kj `TrashRestoreHandler.post` tests the destination with `dest.exists()`, which follows the link and returns False
  - log: 2026-10-13T22:42:26Z @kj added
  - log: 2026-10-13T22:42:40Z @kj found by review round 1 (architect); reproduced: `test_restore_onto_a_broken_symlink_is_409` fails on the unfixed handler with `DID NOT RAISE HTTPClientError`
  - log: 2026-10-13T23:27:16Z @kj closed
- [x] `DEF-API-18` **deletion time has no time zone** - MINOR; `list` passes `DeletionDate` through as server local time with no offset; the browser reads it as browser local time, so the shown age is wrong by the zone difference between server and browser; a time ahead of the browser clock reads `just now`; present at HEAD; owner decision
  - evidence: pytest -q jupyterlab_trash_mgmt_extension/tests: 72 passed; test_parse_trashinfo_valid (naive 10:30 comes back +01:00, wall time kept), test_parse_trashinfo_unparseable_deletion_date and test_parse_trashinfo_missing_deletion_date passed; direct probe: +02:00 input returns 09:30+01:00, the same instant, not double-converted
  - repro: run the server with `TZ=UTC` and the browser in another zone, trash a file; the age is off by the zone difference
  - test-tags: MANUAL
  - root-cause: 2026-10-13T23:10:34Z @kj `send2trash` writes `DeletionDate` with `datetime.now()` and no offset; `get_trash_metadata` returns the string unchanged and `_formatRelativeTime` parses it with `new Date()`
  - log: 2026-10-13T23:10:34Z @kj added
  - log: 2026-10-13T23:10:35Z @kj found while measuring the time column for DEF-PANEL-11; not from a reviewer; not changed in this work
  - log: 2026-10-28T21:05:22Z @kj closed
- [x] `DEF-API-19-EMPTY-FREEZE` **emptying a large trash freezes the whole server** - CRITICAL; Empty Trash on 22,895 items / 48.7 GB stops every request in the lab until the delete ends: websockets drop, kernels miss heartbeats, extensions time out; list re-walks the whole trash every 10 s, so the same stall repeats while the panel is open; cause in root-cause; fix: handlers off the IOLoop plus cached directory sizes; jupyterlab_trash_mgmt_extension/routes.py
  - evidence: regression-verify PASS: nested restore and nested delete at depth 2 show a fresh 5 B size (15 B to 5 B, matching a fresh walk); two concurrent empties both succeed (71 + 49 deleted, 0 files and 0 trashinfo left); a folder removed before listing returns 404 JSON, not 500; make test exit 0 (jest 49 passed, pytest 70 passed, auth gate green); list ping max 6.4 ms and empty ping max 4.3 ms against 200 ms (before 1215.1 and 1409.4 ms); Galata browser max /api/status 13.0 ms over 58 samples vs 2972.1 ms old (prove run 133.9 vs 3015.1 ms; bar 1000 ms)
  - repro: open the panel on a trash of tens of thousands of items and press Empty Trash; measured on the 3,400-item / 60,000-file synthetic trash: list ping max 1215.1 ms and empty ping max 1409.4 ms against a 200 ms bar (tmp/workflows/trash-empty-perf/bench-before.json)
  - test-tags: INTEGRATION, UNIT
  - root-cause: 2026-10-28T20:31:07Z @kj TrashEmptyHandler.post and the other handlers are synchronous defs, so Tornado runs shutil.rmtree and every recursive size walk on the IOLoop thread; list repeats the walk on the panel's 10 s poll (src/widget.ts:11)
  - log: 2026-10-28T20:31:07Z @kj added; reason: reported by @kj on 2026-10-22; measured block 1215 ms for list and 1409 ms for empty on a 60,000-file synthetic trash
  - log: 2026-10-28T20:40:09Z @kj edited repro "open the panel on a trash of tens of thousands of items and press Empty Trash; a websocket in another tab fails until the delete ends" -> "open the panel on a trash of tens of thousands of items and press Empty Trash; measured on the 3,400-item / 60,000-file synthetic trash: list ping max 1215.1 ms and empty ping max 1409.4 ms against a 200 ms bar (tmp/workflows/trash-empty-perf/bench-before.json)"
  - log: 2026-10-28T20:40:14Z @kj perf-verify: freeze fixed, list ping max 5.7 ms and empty ping max 4.8 ms (bar 200 ms), down from 1215.1 and 1409.4 ms; make test green (jest 49, pytest 66); second list 2.06x, below the 5x criterion; nested-mutation stale-size regression found; left open
  - log: 2026-10-28T20:44:26Z @kj Galata E2E (ui-tests/tests/trash-empty-performance.spec.ts): 10,000 seeded files in 4,000 entries, Empty Trash POST 3189 ms versus 3056 ms old, max /api/status latency 13.0 ms over 58 samples versus 2972.1 ms old (bar 1000 ms); fixed passes, old handler fails
  - log: 2026-10-28T20:48:50Z @kj regression-verify PASS: nested restore and nested delete at depth 2 show a fresh 5 B size (15 B to 5 B, matching a fresh walk); two concurrent empties both succeed (71 + 49 deleted, 0 files and 0 trashinfo left); a folder removed before listing returns 404 JSON, not 500; make test exit 0 (jest 49 passed, pytest 70 passed, auth gate green); list ping max 6.4 ms and empty ping max 4.3 ms against 200 ms (before 1215.1 and 1409.4 ms); Galata browser max /api/status 13.0 ms over 58 samples vs 2972.1 ms old (prove run 133.9 vs 3015.1 ms; bar 1000 ms); reason: the closing proof must quote the regression cases, test counts, bench and browser numbers
  - log: 2026-10-28T20:48:54Z @kj closed; reason: same numbers as the preceding log line

## Trash side panel `PANEL`

Lumino widget in `src/widget.ts`

- [x] `DEF-PANEL-2` **refresh icon stops turning early** - MINOR; after a refresh click the icon stops turning when the list arrives, before the 500 ms minimum; likely cause: `_renderHeader` replaces the refresh button during the load and the new button has no `jp-mod-spinning`; fix: build the header once; `src/widget.ts`
  - evidence: jest `refresh icon > turns until the load ends, 500 ms at least` and `header > keeps the same buttons across loads` pass; jest 49 passed on 2026-10-14
  - root-cause: 2026-10-13T21:42:52Z @kj `_loadTrashContents` calls `_renderHeader`, which clears the header and builds a new refresh button; `jp-mod-spinning` stays on the removed button
  - repro: click refresh against a fast server, sample the button class every 50 ms; `jp-mod-spinning` is gone before 500 ms
  - test-tags: UNIT
  - log: 2026-10-13T21:21:56Z @kj added
  - log: 2026-10-13T21:42:52Z @kj reproduced under jest on the unfixed widget: 400 ms after the click the refresh button on screen has no `jp-mod-spinning`
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-PANEL-3` **Empty Trash hides partial failures** - MEDIUM; `Empty Trash` shows no error when some items fail to delete; the leftover rows stay with no reason given; cause: `empty` answers 200 with `success: false` and `errors`, `_emptyTrash` ignores the response body; `src/widget.ts`
  - evidence: jest `Empty Trash > reports the items that could not be removed` passes; jest 49 passed on 2026-10-14
  - repro: make one trashed item undeletable, click `Empty Trash`, confirm; no error dialog opens
  - test-tags: UNIT
  - log: 2026-10-13T21:21:56Z @kj added
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-PANEL-6` **selection lost every 10 s** - MEDIUM; selected rows lose their selection when the 10 s auto-refresh reloads the list; a selection made more than 10 s before the right-click is gone; cause: `_loadTrashContents` clears `_selectedItems` on every load; fix: keep the selection by `trash_path` while the location stays the same; `src/widget.ts`
  - evidence: jest `selection > survives the background refresh` and `keeps the shift-click anchor across the background refresh` pass; jest 49 passed on 2026-10-14
  - repro: select a row, wait 10 s; the row is no longer selected
  - test-tags: UNIT
  - root-cause: 2026-10-13T21:43:00Z @kj `_startAutoRefresh` runs `_refreshInBackground` every 10 s; it calls `_loadTrashContents`, which runs `this._selectedItems.clear()` and renders new row elements
  - log: 2026-10-13T21:43:00Z @kj added
  - log: 2026-10-13T21:43:00Z @kj reproduced under jest on the unfixed widget: 1 row selected before `_refreshInBackground`, 0 after
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-PANEL-8` **failed action hides its error when the reload fails** - MAJOR; Restore and Delete open no error dialog when the list reload after them fails too; with the server unreachable the veil appears and disappears and nothing is reported; fix: report before the reload; `src/widget.ts`
  - evidence: jest `failed reload after an action` passes for restore and for delete; both cases failed on the unfixed widget; confirmed by review round 2; jest 49 passed on 2026-10-14
  - repro: make `restore` and `list` fail, restore a row; no dialog opens
  - test-tags: UNIT
  - root-cause: 2026-10-13T22:42:26Z @kj `_restoreItems` and `_deleteItems` await `_loadTrashContents()` before the `showErrorMessage` block inside `try/finally`; a rejected reload leaves through `finally` and skips the block
  - log: 2026-10-13T22:42:26Z @kj added
  - log: 2026-10-13T22:42:40Z @kj found by review round 1 (architect); reproduced under jest on the unfixed widget: `restore` and `list` reject, `showErrorMessage` called 0 times; same for `delete`
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-PANEL-10` **selected row looks like a hovered row** - MAJOR; a selected row and the row under the pointer have the same background; a click or Ctrl+click on a row changes nothing on screen; fix: selected row on `--jp-layout-color3`; `style/base.css`
  - evidence: measured in the built panel: selected against hovered row 1.62:1 in the light and the dark theme, time and size text on a selected row 9.40:1 and 5.17:1; confirmed by review round 3
  - repro: click a row, move the pointer to another row; both rows look the same
  - test-tags: MANUAL
  - root-cause: 2026-10-13T22:42:27Z @kj one CSS rule gives `.jp-TrashPanel-item:hover` and `.jp-TrashPanel-item.jp-mod-selected` the background `--jp-layout-color2`
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (ux-designer); measured in Chromium on the unfixed panel: selected and hovered row both rgb(238, 238, 238) light, rgb(66, 66, 66) dark; unchanged from HEAD
  - log: 2026-10-13T23:08:38Z @kj review round 2: the new selected background lowered the time and size text on a selected row to 3.85:1 light and 3.06:1 dark; fixed by giving those two cells `--jp-ui-font-color1` on a selected row, measured 9.40:1 and 5.17:1
  - log: 2026-10-13T23:27:16Z @kj closed
- [x] `DEF-PANEL-11` **name column shows about 6 characters at 250 px** - MAJOR; at the default sidebar width of 250 px the name text box is 56 px; `Untitled.ipynb` to `Untitled12.ipynb` all read `Untitl...`; fix: short time strings, narrower time column, name line in the row tooltip; `style/base.css`, `src/widget.ts`
  - evidence: measured at a 250 px sidebar in the built panel: name text box 86 px (56 px before), no time or size cell cut, both themes; jest `time column > shows the age in a short form` passes; confirmed by review round 3
  - repro: open the panel at a 250 px sidebar with several `Untitled*.ipynb` in the trash
  - test-tags: MANUAL
  - root-cause: 2026-10-13T22:42:27Z @kj the time column is fixed at 90 px plus 8 px padding to hold strings as long as `59 minutes ago`; the size column takes 60 px
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (ux-designer): 124 of 129 names truncated at 250 px; widths unchanged from HEAD; deferred by the adjudicator for the change budget of round 1
  - log: 2026-10-13T23:08:38Z @kj tried `Time.formatHuman(date, "narrow")`: page language `en-GB` gives `13 days ago` (66.4 px), cut in a 60 px column, and a time ahead of the clock reads `next yr.`; dropped for fixed short strings in `_formatRelativeTime`
  - log: 2026-10-13T23:22:15Z @kj applied: short time strings and a 60 px time column, name text box 86 px at a 250 px sidebar (56 px before); the tooltip name line was ruled out in review rounds 2 and 3 and is not applied; open remainder: names that differ after about 10 characters
  - log: 2026-10-13T23:27:16Z @kj closed
- [x] `DEF-PANEL-12` **column header says Modified** - MINOR; the time column is labelled `Modified` and holds the deletion time; the row tooltip names the same value `Deleted:`; fix: label `Deleted`; `src/widget.ts`
  - evidence: jest `time column > is labelled Deleted` passes; the browser shows `Deleted` with the sort arrow in the 60 px header cell; confirmed by review round 3
  - repro: open the panel, read the header of the time column
  - test-tags: UNIT
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (both lenses); label unchanged from HEAD; deferred by the adjudicator for the change budget of round 1
  - log: 2026-10-13T23:27:16Z @kj closed
- [x] `DEF-PANEL-13` **rows with an equal sort key keep the server order** - MINOR; inside a folder all rows share one deletion time, so the default sort leaves them in directory order while the header shows a sort arrow; fix: compare names when the keys are equal; `src/widget.ts`
  - evidence: jest `sort tie-break > sorts rows with an equal deletion date by name` and `sort tie-break > keeps the tie order in both directions` pass; verify PASS_WITH_FINDINGS, jlpm test 57 passed, 0 failed; probe confirmed the tie order in both directions and across a reload
  - repro: open a trashed folder with 10 files; the list is not alphabetical
  - test-tags: UNIT
  - root-cause: 2026-10-13T22:42:27Z @kj the comparator in `_getSortedItems` returns 0 for equal keys and the server lists in `iterdir()` order
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (both lenses); visible in `tmp/shots/13-light-inside-folder.png`; deferred by the adjudicator for the change budget of round 1
  - log: 2026-10-13T23:22:23Z @kj review round 3: the adjudicator withdrew the promotion and left it open for defect work outside the review loop; the remedy counts as a new mechanism for a MINOR; owner decision
  - log: 2026-10-28T21:03:03Z @kj closed
- [x] `DEF-PANEL-14` **shift-click anchor ignores a sort change** - MINOR; click a row, change the sort, shift-click another row: the range starts at the row that now sits at the old index, not at the clicked row; fix: hold the anchor as `trash_path`; `src/widget.ts`
  - evidence: jest `selection > starts the range at the clicked row after a sort change` and `selection > keeps the shift-click anchor across the background refresh` pass; verify PASS_WITH_FINDINGS, jlpm test 57 passed, 0 failed; probe confirmed click selection and shift-click range survive a sort change and a background reload
  - repro: rows a, b, c sorted by name; click a; reverse the sort; shift-click b; c and b are selected
  - test-tags: UNIT
  - root-cause: 2026-10-13T22:42:27Z @kj the anchor is the row index `_lastClickedIndex`; `_handleSort` reorders the rows and leaves the index unchanged
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (architect), reproduced by the reviewer under jest; deferred by the adjudicator for the change budget of round 1
  - log: 2026-10-13T23:22:23Z @kj review round 3: the adjudicator withdrew the promotion and left it open for defect work outside the review loop; the remedy counts as a new mechanism for a MINOR; owner decision
  - log: 2026-10-28T21:03:08Z @kj closed
- [x] `DEF-PANEL-15` **rows cannot be operated by keyboard** - MAJOR; no row takes focus: select, open folder, Restore and Delete Permanently work by mouse only; breadcrumb focus drops to the page body at every 10 s reload; needs a keyboard model (one tab stop, arrow keys, Enter, Space, menu key, roles); owner decision; `src/widget.ts`
  - evidence: jest `keyboard model > is one listbox tab stop and moves the active row with the arrows`, `keyboard model > toggles the active row selection with Space`, `keyboard model > opens the active folder with Enter`, `keyboard model > opens the row menu with Shift+F10 and the menu key` and `keyboard model > keeps the active row across a background reload` all pass; verify PASS_WITH_FINDINGS, jlpm test 57 passed, 0 failed, 20 probe tests passed
  - repro: press Tab through the panel; focus goes to Empty Trash, Refresh, the list container, then leaves the panel
  - test-tags: MANUAL
  - root-cause: 2026-10-13T22:42:27Z @kj `src/widget.ts` sets no tabindex, no keydown listener and no role; rows and breadcrumb are rebuilt on every load and focus is not restored
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (ux-designer); select, Restore and Delete were mouse only at HEAD; deferred by the adjudicator: a new interaction model that needs the owner decision and its own acceptance criteria
  - log: 2026-10-28T21:03:16Z @kj closed; reason: the five jest case names are quoted verbatim, which does not fit 50 words
- [x] `DEF-PANEL-21-KEYFOCUS` **keyboard focus drops to body and mouse clicks leave no active row** - MEDIUM; From the panel verifier. Leaving a folder through the focused breadcrumb, closing the keyboard-opened context menu, and emptying the trash all drop focus to BODY. A mouse click selects a row but does not make it active, so Space and Enter afterwards do nothing. File src/widget.ts: breadcrumb rebuild around line 364, context-menu aboutToClose around line 85, click handler around line 506, list hidden on empty around line 458.
  - evidence: jest focus edges 4/4 pass (breadcrumb activation, keyboard menu close, click then Space, empty hides list); make test exit 0 2026-10-28: jest 61 passed, pytest 72 passed, auth gate passed
  - repro: trash panel: focus the Trash breadcrumb inside folder a and activate it -> BODY; focus the list, open the context menu with the ContextMenu key and close it -> BODY
  - log: 2026-10-28T21:05:26Z @kj added; reason: filed from the panel verifier findings
  - log: 2026-10-28T21:16:11Z @kj closed
- [x] `DEF-PANEL-22-ACTIVE-RING` **Active-row indicator fails contrast and ignores focus** - MAJOR; the active-row indicator failed contrast, 2.45:1 light and 1.98:1 dark against the selected background, and stayed visible while the list held no focus
  - evidence: browser measurement in the rebuilt panel: active-row ring on the selected background 11.178:1 light and 6.193:1 dark (floor 3.0), outline-style none while the list held no focus; make test exit 0 (jest 66 passed, pytest 73 passed); Galata 5/5 passed
  - repro: focus the list, read the ring against the selected background: 2.45:1 light, 1.98:1 dark; move focus to Refresh and the ring stays
  - test-tags: MANUAL
  - root-cause: 2026-10-28T22:21:19Z @kj the outline used the brand colour and the rule was not focus-scoped
  - log: 2026-10-28T22:21:19Z @kj added
  - log: 2026-10-28T22:21:22Z @kj closed

## Test suite `TEST`

pytest and jest suites of the extension

- [x] `DEF-TEST-4` **handler tests never call the handlers** - MINOR; the 9 tests in `TestTrashOperations` repeat the file operations with `shutil` inside the test body; no test sends a request to `list`, `restore`, `delete` or `empty`, so a handler regression passes; fix: request the handlers through `jp_fetch`; `jupyterlab_trash_mgmt_extension/tests/test_routes.py`
  - evidence: `tests/test_handlers.py` sends 40 request cases through `jp_fetch` to list, restore, delete and empty; with the body of `TrashDeleteHandler.post` replaced by `pass` 8 of them fail; pytest 63 passed on 2026-10-14
  - related: ACC-NAV-35 - first criterion covered by a real handler request
  - repro: replace the body of `TrashDeleteHandler.post` with `pass`, run pytest; all 22 tests pass
  - test-tags: INTEGRATION
  - log: 2026-10-13T21:21:57Z @kj added
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-TEST-5` **jest suite tests nothing** - MINOR; the only jest test asserts `1 + 1` equals 2; no widget code runs under jest; fix: widget tests with a mocked `requestAPI`; `src/__tests__/jupyterlab_trash_mgmt_extension.spec.ts`
  - evidence: `src/__tests__/widget.spec.ts` runs the widget with a mocked `requestAPI`; 13 mutants of `widget.ts` each failed at least one case; jest 49 passed on 2026-10-14
  - repro: run `jlpm test`, read the coverage table; `widget.ts` is at 0 %
  - test-tags: UNIT
  - log: 2026-10-13T21:21:57Z @kj added
  - log: 2026-10-13T23:27:15Z @kj closed
- [x] `DEF-TEST-23-PERF-COUNT` **Build fails: perf spec waits for an exact trash count** - MAJOR; the Integration tests job fails on every push because trash-empty-performance.spec.ts waits for the exact summary text '4000 items', while other spec files delete their temporary files into the same trash and the panel reads 4003
  - evidence: Build 41032946681 success and Check Release 41032946674 success on c3efb0a; local Galata 4/4 on the fixed spec (EMPTY_POST_MS=3819, PING_MAX_MS=12.3)
  - repro: push to main; Build workflow Integration tests job fails at ui-tests/tests/trash-empty-performance.spec.ts:68 with Received string '4003 items · 48.8 KB' against Expected substring '4000 items'
  - test-tags: E2E
  - root-cause: 2026-10-30T09:16:49Z @kj the spec asserts an exact count on a trash other spec files mutate concurrently; the seeded 4000 entries are only a lower bound
  - log: 2026-10-30T09:16:49Z @kj added
  - log: 2026-10-30T09:26:20Z @kj closed

## Distribution `DIST`

README, package metadata and the files a release publishes

- [x] `DEF-DIST-16` **README names JupyterLab 4.0.0 as the floor** - MINOR; README.md line 28 reads `Requires JupyterLab 4.0.0 or higher`; `package.json` and `pyproject.toml` require 4.6; `.resources/screenshot-trash.png` shows the previous header; `README.md`
  - evidence: README.md line 29 reads `Requires JupyterLab 4.6 or higher`; a `Folder navigation` feature line is added; `.resources/screenshot-trash.png` replaced by a capture of the new panel from the visual-check server
  - repro: read README.md line 28 beside the `jupyterlab` range in `pyproject.toml`
  - test-tags: MANUAL
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (architect); the floor moved to 4.6 with the dependency upgrade of this change
  - log: 2026-10-13T23:25:55Z @kj closed
- [x] `DEF-DIST-17` **source distribution ships working files** - MINOR; the sdist holds `.claude/CLAUDE.md`, `.claude/JOURNAL.md`, `.claude/settings.local.json`, `.playwright-mcp/*.yml`, `docs/acc-crit.md`, `docs/defects.md`; owner decision before the next release; `pyproject.toml`
  - evidence: python -m build --sdist built the 1.1.13 sdist; tar tzf (54 entries) shows no .claude, .agents, .playwright-mcp, docs, tmp, logs or coverage path, and holds pyproject.toml, README.md and jupyterlab_trash_mgmt_extension/{__init__,routes,_version}.py; the wheel keeps 7 labextension shared-data entries
  - repro: run `tar tzf dist/jupyterlab_trash_mgmt_extension-*.tar.gz` and look for `.claude`, `.playwright-mcp` and `docs`
  - test-tags: MANUAL
  - root-cause: 2026-10-13T22:42:27Z @kj `[tool.hatch.build.targets.sdist]` excludes only `.github` and `binder`; `.claude/settings.local.json` and `.playwright-mcp/` are in no ignore file that hatchling reads
  - log: 2026-10-13T22:42:27Z @kj added
  - log: 2026-10-13T22:42:41Z @kj found by review round 1 (architect); `.claude` was shipped before this change, `docs/` and `.playwright-mcp/` are new; ruled outside the review bar
  - log: 2026-10-28T21:05:20Z @kj closed

## Spinner animation `MOTION`

Rotation of the refresh icon and of the loading ring

- log: 2026-10-28T20:58:25Z @kj category created

- [x] `DEF-MOTION-20-SPIN` **spinners stand still under reduced motion** - MINOR; with the system set to reduce motion both spinners stop: the refresh icon does not turn during a load and the loading ring holds still; cause in root-cause; fix: delete the animation: none rule, keep the dimming; style/base.css
  - evidence: rebuild replaced the served bundle (md5 96147f26 -> da634503100a45cb94b1af234d6c7d53); Galata spec spinner-motion.spec.ts reports computed animation-name jp-trash-panel-spin for the header svg and .jp-TrashPanel-loadingSpinner under both reduce and no-preference; full Galata suite 4/4 passed
  - related: ACC-MOTION-58-SPIN
  - repro: set the OS to prefer reduced motion, open the Trash panel, click Refresh; neither spinner rotates
  - test-tags: E2E
  - root-cause: 2026-10-28T20:58:25Z @kj style/base.css:341 sets animation: none for .jp-TrashPanel-header-button.jp-mod-spinning svg and .jp-TrashPanel-loadingSpinner under @media (prefers-reduced-motion: reduce); shipped in every release up to 1.1.13
  - log: 2026-10-28T20:58:25Z @kj added; reason: reported by @kj on 2026-10-28 while emptying the large trash; paired with acceptance criterion ACC-MOTION-58-SPIN
  - log: 2026-10-28T20:58:29Z @kj fix in the working tree: the reduced-motion block now only dims; ui-tests/tests/spinner-motion.spec.ts asserts computed animation-name jp-trash-panel-spin under both motion preferences; the browser run fails today only because the installed labextension bundle predates the CSS fix (static/232.2e456271cee51023.js still carries animation: none), so the rebuild-and-reinstall workflow reruns it before the criterion closes; reason: state of the fix between filing and the rebuilt frontend
  - log: 2026-10-28T21:08:32Z @kj closed; reason: browser evidence from the rebuilt frontend

