import { Widget } from '@lumino/widgets';
import {
  showDialog,
  Dialog,
  showErrorMessage,
  Notification
} from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import { nullTranslator } from '@jupyterlab/translation';
import { Menu } from '@lumino/widgets';
import { CommandRegistry } from '@lumino/commands';
import { Message } from '@lumino/messaging';
import { ServerConnection } from '@jupyterlab/services';
import { closeIcon, filterIcon } from '@jupyterlab/ui-components';
import { requestAPI } from './request';
import { trashIcon, folderIcon, fileIcon, refreshIcon } from './icon';
import {
  atEnd,
  easeOutCubic,
  giveLength,
  pullStep,
  springPull
} from './harmonica';

const trans = nullTranslator.load('jupyterlab_trash_mgmt_extension');

// Auto-refresh interval: 1/6 minute = 10 seconds
const REFRESH_INTERVAL_MS = 10000;

// The localStorage key of the sources the user collapsed in the extra sections
const COLLAPSED_KEY =
  '@stellarshenson/jupyterlab-trash-mgmt-extension:panel:collapsed';

function loadCollapsed(): Set<string> {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(COLLAPSED_KEY) ?? '[]'
    );
    return new Set(
      Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []
    );
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage blocked or full: the state lasts until the page reloads.
  }
}

// The localStorage key of the Show Volumes choice; off unless it reads true
const SHOW_VOLUMES_KEY =
  '@stellarshenson/jupyterlab-trash-mgmt-extension:panel:show-volumes';

function loadShowVolumes(): boolean {
  try {
    return (
      JSON.parse(window.localStorage.getItem(SHOW_VOLUMES_KEY) ?? '') === true
    );
  } catch {
    return false;
  }
}

function saveShowVolumes(on: boolean): void {
  try {
    window.localStorage.setItem(SHOW_VOLUMES_KEY, JSON.stringify(on));
  } catch {
    // Storage blocked or full: the choice lasts until the page reloads.
  }
}

/** A byte count in the server's format_size form. */
function formatSize(bytes: number): string {
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (bytes < 1024) {
      return unit === 'B' ? `${bytes} B` : `${bytes.toFixed(1)} ${unit}`;
    }
    bytes /= 1024;
  }
  return `${bytes.toFixed(1)} PB`;
}

/** The summary bar's count and size. */
function countText(count: number, size: string): string {
  return `${count} ${count === 1 ? 'item' : 'items'} \u00B7 ${size}`;
}

/**
 * The row an arrow, Home or End key moves to in a list of `count` rows, or
 * null for any other key. Without an active row the arrows start at an end.
 */
function movedIndex(key: string, index: number, count: number): number | null {
  let target: number;
  switch (key) {
    case 'ArrowDown':
      target = index < 0 ? 0 : index + 1;
      break;
    case 'ArrowUp':
      target = index < 0 ? count - 1 : index - 1;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = count - 1;
      break;
    default:
      return null;
  }
  return Math.max(0, Math.min(target, count - 1));
}

/**
 * True when a recorded original path lies at or below root, as the server's
 * is_under reads it.
 * shortcut: compares the text only, so a row under a symlinked root stays
 * until its source's fresh listing answers; resolve paths if that shows.
 */
function isUnder(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Disable a button, or enable it. A button disabled while it holds the focus
 * hands it to `next` first, so the focus stays in the panel, never on the
 * page body.
 */
function setOff(
  button: HTMLButtonElement,
  off: boolean,
  next: HTMLElement
): void {
  if (off && button === document.activeElement) {
    next.focus();
  }
  button.disabled = off;
}

/** Shift+F10 and the ContextMenu key open a row menu. */
function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
}

// A load pending longer than this no longer blocks the auto-refresh, so a
// hung server cannot stop the list from updating. Its response is discarded
// by the sequence number when it finally arrives.
const STALE_LOAD_MS = 120000;

interface ITrashItem {
  name: string;
  trash_path: string;
  original_path: string;
  deletion_date: string;
  size: number;
  size_formatted: string;
  is_dir: boolean;
  is_symlink: boolean;
  // The source of a row that is not in the XDG trash
  source?: string;
}

/** A row's identity: its trash path, after its source outside the XDG trash. */
function rowKey(item: ITrashItem): string {
  return item.source === undefined
    ? item.trash_path
    : `${item.source}\0${item.trash_path}`;
}

interface ITrashListResponse {
  items: ITrashItem[];
  total_size: number;
  total_size_formatted: string;
  item_count: number;
}

interface ITrashSource {
  id: string;
  label: string;
  item_count: number;
  total_size: string;
  total_bytes: number;
  error: string;
  mountpoint: string;
}

interface ICleanSourceResult {
  id: string;
  label: string;
  deleted_count: number;
  errors: string[];
  left_count?: number;
}

interface ICleanResponse {
  success: boolean;
  deleted_count: number;
  sources?: ICleanSourceResult[];
  left_count?: number;
  errors?: string[];
}

/** The elements of one extra source section. */
interface ISectionParts {
  section: HTMLDivElement;
  header: HTMLButtonElement;
  empty: HTMLButtonElement;
  // The entries box: the section's scroll container, the band excluded. It
  // stands empty for the home section, whose rows are the main list moved in
  entries: HTMLDivElement;
  // The Trash is empty line under the band of a trash that lists nothing;
  // the home band has none and no list, its rows are the main list
  none?: HTMLDivElement;
  caret: HTMLSpanElement;
  label: HTMLSpanElement;
  list?: HTMLDivElement;
  // The listing the rows were drawn from, so an unchanged one is not redrawn
  key?: string;
}

/** One side of the wheel's height trade: its section and its entries box. */
interface ISectionSide {
  section: HTMLDivElement;
  entries: HTMLDivElement;
}

type SortColumn = 'name' | 'modified' | 'size';
type SortDirection = 'asc' | 'desc';

export class TrashWidget extends Widget {
  private _header: HTMLDivElement;
  private _summary: HTMLDivElement;
  private _summaryText: HTMLSpanElement;
  // The count and size of the listing in view; with Show Volumes on, the top
  // level shows the total of every trash instead
  private _summaryCount = '';
  private _breadcrumb: HTMLDivElement;
  private _columnHeader: HTMLDivElement;
  private _list: HTMLDivElement;
  private _emptyMessage: HTMLDivElement;
  private _loadingVeil: HTMLDivElement;
  private _emptyBtn: HTMLButtonElement;
  private _filterBtn: HTMLButtonElement;
  private _filterWrap: HTMLDivElement;
  private _filterInput: HTMLInputElement;
  private _filterClear: HTMLButtonElement;
  // The text the visible rows must carry in their name or original path
  private _filter = '';
  private _refreshBtn: HTMLButtonElement;
  private _commands: CommandRegistry;
  private _contextMenu: Menu;
  private _selectedItems: Set<ITrashItem> = new Set();
  // The row a shift-click ranges from, held by row key because sorting moves
  // rows
  private _lastClickedAnchor: string | null = null;
  // The row arrow navigation treats as current, held by row key because
  // sorting and every reload rebuild the rows
  private _activePath: string | null = null;
  private _itemElements: Map<ITrashItem, HTMLElement> = new Map();
  private _items: ITrashItem[] = [];
  private _sortedItems: ITrashItem[] = [];
  private _sortColumn: SortColumn = 'modified';
  private _sortDirection: SortDirection = 'desc';
  private _refreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private _serverSettings: ServerConnection.ISettings;
  // Segments of the folder in view; empty at the top level of the trash
  private _path: string[] = [];
  // The source of the folder in view; 'xdg' at the top level
  private _pathSource = 'xdg';
  // The last main listing, its rows tagged with their source
  private _mainList: ITrashListResponse = {
    items: [],
    total_size: 0,
    total_size_formatted: formatSize(0),
    item_count: 0
  };
  // False until the first list has arrived
  private _loaded = false;
  // List requests in flight, the sequence number of the newest one, when each
  // pending one started, and the sequence number of the last one rendered
  private _pendingLoads = 0;
  private _loadSeq = 0;
  private _loadStarts = new Map<number, number>();
  private _renderedSeq = 0;
  // The folder the newest request asked for, so the background chase retries
  // the pending location rather than the one under it
  private _requestPath: string[] = [];
  private _requestSource = 'xdg';
  // Tokens of the warm refreshes in flight; each keeps the button marked busy
  // until it settles
  private _warmTokens: Set<symbol> = new Set();
  // Bounds the busy mark so a warm refresh that never returns cannot leave
  // the button marked busy; the request itself is not cancelled
  private _warmMarkTimer: ReturnType<typeof setTimeout> | null = null;
  // The extra trash sources, one collapsible section each, below the main list
  private _sectionsEl: HTMLDivElement;
  private _sources: ITrashSource[] = [];
  // Raised by every action that changes the trash; a /sources or source
  // listing answer that started under an older value predates the change and
  // is dropped
  private _trashGen = 0;
  // The generation of the /sources request in flight; a refresh in the same
  // generation sends none, an action sends a new one
  private _sourcesGen: number | null = null;
  // False until the first /sources request has settled
  private _sourcesSettled = false;
  private _sectionParts: Map<string, ISectionParts> = new Map();
  // What each section's own listing request returned, or the error it raised
  private _sectionListings: Map<string, ITrashListResponse | Error> = new Map();
  // Sources whose listing request is in flight, with its generation, or
  // answered for this load; a request in flight is not sent again in its
  // generation, while an action sends a new one beside it and the older
  // answer is dropped
  private _sectionPending: Map<string, number> = new Map();
  private _sectionFetched: Set<string> = new Set();
  private _collapsed = loadCollapsed();
  // Off: no sections, and the top level merges every source into the main list
  private _showVolumes = loadShowVolumes();
  private _headerMenu: Menu;
  private _headerMenuOpener: Element | null = null;
  // The Restore menu of a section row, the row it was opened on, and the
  // active row of each section, held by path because every listing answer
  // rebuilds the rows
  private _sectionMenu: Menu;
  private _sectionTarget: { source: string; item: ITrashItem } | null = null;
  private _sectionActive: Map<string, string> = new Map();
  // The sticky breadcrumb-and-sort-header block of the home entries box
  private _homeChrome: HTMLDivElement;
  // Harmonica navigation: the wheel over the panel folds the open section
  // into its neighbour at the give length
  private _phase: 'idle' | 'pulling' | 'springing' | 'folding' = 'idle';
  // The pull on screen, a magnitude; _pullDir carries the wheel's direction
  private _pull = 0;
  private _pullDir: 1 | -1 = 1;
  // The open entries box's height at rest, held through the gesture
  private _base = 0;
  private _give = 44;
  private _leave: ISectionSide | null = null;
  private _enter: ISectionSide | null = null;
  private _enterTarget = 0;
  private _foldStart = 0;
  private _springStart = 0;
  private _springFrom = 0;
  private _frame: number | null = null;
  private _springTimer: ReturnType<typeof setTimeout> | null = null;
  // The sub-pixel remainder a whole-pixel scrollTop write drops
  private _wheelCarry = 0;
  private _onWheel = (event: WheelEvent): void => this._handleWheel(event);

  constructor(serverSettings: ServerConnection.ISettings) {
    super();
    this._serverSettings = serverSettings;
    this.id = 'jp-trash-panel';
    this.title.icon = trashIcon;
    this.title.caption = trans.__('Trash');
    this.addClass('jp-TrashPanel');

    // Set up commands for context menu
    this._commands = new CommandRegistry();
    this._setupCommands();
    this._contextMenu = new Menu({ commands: this._commands });
    this._contextMenu.addItem({ command: 'trash:restore' });
    this._contextMenu.addItem({ command: 'trash:delete' });
    this._contextMenu.addItem({ type: 'separator' });
    this._contextMenu.addItem({ command: 'trash:show-volumes' });

    // Clear visual state when menu closes (keep selection) and give the
    // focus the menu took back to the list it was opened from
    this._contextMenu.aboutToClose.connect(() => {
      this.node.classList.remove('jp-mod-contextMenuOpen');
      this._focusListOrRefresh();
    });

    this._sectionMenu = new Menu({ commands: this._commands });
    this._sectionMenu.addItem({ command: 'trash:restore-from-source' });
    this._sectionMenu.addItem({ type: 'separator' });
    this._sectionMenu.addItem({ command: 'trash:show-volumes' });
    // The focus the menu took goes back to the row it was opened on
    this._sectionMenu.aboutToClose.connect(() => {
      this.node.classList.remove('jp-mod-contextMenuOpen');
      if (this._sectionTarget === null) {
        return;
      }
      this._sectionParts
        .get(this._sectionTarget.source)
        ?.list?.querySelector<HTMLElement>('[tabindex="0"]')
        ?.focus();
    });

    // Create header: title on the left, action icons on the right.
    this._header = document.createElement('div');
    this._header.className = 'jp-TrashPanel-header';

    const title = document.createElement('span');
    title.className = 'jp-TrashPanel-title';
    title.textContent = trans.__('Trash Management');
    this._header.appendChild(title);

    // Left of Empty Trash, so that button stays directly left of Refresh
    this._filterBtn = document.createElement('button');
    this._filterBtn.className = 'jp-TrashPanel-header-button';
    this._filterBtn.title = trans.__('Filter trash');
    // The pressed state is drawn with a class, which says nothing to a screen
    // reader; the filter box starts hidden, so this starts false.
    this._filterBtn.setAttribute('aria-pressed', 'false');
    filterIcon.element({ container: this._filterBtn });
    this._filterBtn.addEventListener('click', () => this._toggleFilter());
    this._header.appendChild(this._filterBtn);

    this._emptyBtn = document.createElement('button');
    this._emptyBtn.className =
      'jp-TrashPanel-header-button jp-TrashPanel-header-button-danger';
    this._emptyBtn.title = trans.__('Empty Trash');
    this._emptyBtn.disabled = true;
    trashIcon.element({ container: this._emptyBtn });
    this._emptyBtn.addEventListener('click', () => this._cleanSources('all'));
    this._header.appendChild(this._emptyBtn);

    // Refresh is appended last, so it is the rightmost icon
    this._refreshBtn = document.createElement('button');
    this._refreshBtn.className = 'jp-TrashPanel-header-button';
    this._refreshBtn.title = trans.__('Refresh');
    refreshIcon.element({ container: this._refreshBtn });
    this._refreshBtn.addEventListener('click', () => this.refresh());
    this._header.appendChild(this._refreshBtn);

    this.node.appendChild(this._header);

    // Filter box under the header, hidden until the filter button shows it.
    // It sits outside the list and the sections, so a re-render keeps the
    // input and the caret the user is typing with.
    this._filterWrap = document.createElement('div');
    this._filterWrap.className = 'jp-TrashPanel-filterWrap';
    // The `hidden` attribute toggles `display: none` through the user agent
    // stylesheet, so the wrapper's `display: flex` must not override it.
    this._filterWrap.hidden = true;

    this._filterInput = document.createElement('input');
    this._filterInput.type = 'search';
    this._filterInput.className = 'jp-TrashPanel-filterInput';
    this._filterInput.placeholder = trans.__('Filter trash...');
    this._filterInput.setAttribute('aria-label', trans.__('Filter trash'));
    this._filterInput.spellcheck = false;
    this._filterInput.addEventListener('input', () => {
      this._filter = this._filterInput.value;
      this._syncFilterClear();
      this._renderFiltered();
    });

    this._filterClear = document.createElement('button');
    this._filterClear.className = 'jp-TrashPanel-filterClear';
    this._filterClear.title = trans.__('Clear filter');
    this._filterClear.hidden = true;
    closeIcon.element({ container: this._filterClear });
    this._filterClear.addEventListener('click', () => {
      this._filter = '';
      this._filterInput.value = '';
      this._syncFilterClear();
      this._renderFiltered();
      // Clearing is a step in filtering, not the end of it - keep the caret
      // in the field so the next query can be typed straight away.
      this._filterInput.focus();
    });

    this._filterWrap.append(this._filterInput, this._filterClear);
    this.node.appendChild(this._filterWrap);

    this._headerMenu = new Menu({ commands: this._commands });
    this._headerMenu.addItem({ command: 'trash:show-volumes' });
    // The focus the menu took goes back to the panel part it was opened on
    this._headerMenu.aboutToClose.connect(() => {
      let opener = this._headerMenuOpener;
      // A disabled trash button cannot take the focus; the element setOff
      // hands its focus to takes it: the band's fold toggle, or Refresh
      if (opener instanceof HTMLButtonElement && opener.disabled) {
        opener =
          opener === this._emptyBtn
            ? this._refreshBtn
            : opener.previousElementSibling;
      }
      if (opener instanceof HTMLElement && this.node.contains(opener)) {
        opener.focus();
      }
    });
    // Every right-click in the panel a row menu does not take opens Show Volumes
    this.node.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._headerMenuOpener =
        (e.target as Element).closest('button:disabled') ??
        document.activeElement;
      this._headerMenu.open(e.clientX, e.clientY);
    });

    // Create summary bar: item count and total size of the listed location.
    // The bar wraps, so both readouts stay visible.
    this._summary = document.createElement('div');
    this._summary.className = 'jp-TrashPanel-summary';
    this._summaryText = document.createElement('span');
    this._summaryText.className = 'jp-TrashPanel-summaryText';
    this._summary.appendChild(this._summaryText);
    this.node.appendChild(this._summary);

    // Create breadcrumb row: shown only inside a folder
    this._breadcrumb = document.createElement('div');
    this._breadcrumb.className = 'jp-TrashPanel-breadcrumb';
    this._breadcrumb.hidden = true;
    this.node.appendChild(this._breadcrumb);

    // Create column headers
    this._columnHeader = document.createElement('div');
    this._columnHeader.className = 'jp-TrashPanel-columnHeader';
    this.node.appendChild(this._columnHeader);
    // Another source's rows may arrive before the first main listing
    this._renderColumnHeader();

    // Create list container. It is the single tab stop of the keyboard model:
    // rows are options exposed through aria-activedescendant, never tabindex.
    this._list = document.createElement('div');
    this._list.className = 'jp-TrashPanel-list';
    this._list.tabIndex = 0;
    this._list.setAttribute('role', 'listbox');
    this._list.setAttribute('aria-multiselectable', 'true');
    this._list.setAttribute('aria-label', trans.__('Trash items'));
    this._list.addEventListener('keydown', (e: KeyboardEvent) =>
      this._handleListKeyDown(e)
    );
    // Keyboard focus with no active row activates the first row, as ArrowDown
    // does (WAI-ARIA listbox); a mouse focus leaves it to the click
    this._list.addEventListener('focus', () => {
      if (this._activePath === null && this._list.matches(':focus-visible')) {
        this._setActiveIndex(0);
      }
    });
    this.node.appendChild(this._list);

    // Create empty message
    this._emptyMessage = document.createElement('div');
    this._emptyMessage.className = 'jp-TrashPanel-empty';
    this._emptyMessage.textContent = trans.__('Trash is empty');
    this._emptyMessage.style.display = 'none';
    this.node.appendChild(this._emptyMessage);

    // The section column holds every section with Show Volumes on, home
    // first; with it off the column is empty and hidden
    this._sectionsEl = document.createElement('div');
    this._sectionsEl.className = 'jp-TrashPanel-sections';
    this.node.appendChild(this._sectionsEl);

    // The sticky block of the home entries box: it wraps the breadcrumb and
    // the sort headers while Show Volumes is on, and holds no child while off
    this._homeChrome = document.createElement('div');
    this._homeChrome.className = 'jp-TrashPanel-homeChrome';

    // The wheel over the whole panel drives the section in focus
    this.node.addEventListener('wheel', this._onWheel, { passive: false });

    // Create loading veil - visible by default, until the first load ends
    this._loadingVeil = document.createElement('div');
    this._loadingVeil.className = 'jp-TrashPanel-loading';
    this._loadingVeil.setAttribute('role', 'status');
    this._loadingVeil.setAttribute('aria-live', 'polite');
    this._loadingVeil.setAttribute('aria-label', trans.__('Working'));
    const loadingSpinner = document.createElement('div');
    loadingSpinner.className = 'jp-TrashPanel-loadingSpinner';
    this._loadingVeil.appendChild(loadingSpinner);
    this.node.appendChild(this._loadingVeil);

    // Clear selection when clicking empty area of the list
    this._list.addEventListener('click', (e: MouseEvent) => {
      if (e.target === this._list) {
        this._clearSelection();
      }
    });

    // Note: Initial load is handled in onAfterShow() when panel becomes visible
  }

  private _setupCommands(): void {
    this._commands.addCommand('trash:restore', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: () => {
        const count = this._selectedItems.size;
        return count > 1 ? `Restore ${count} Items` : 'Restore';
      },
      execute: () => {
        if (this._selectedItems.size > 0) {
          this._restoreItems([...this._selectedItems]);
        }
      }
    });

    this._commands.addCommand('trash:delete', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: () => {
        const count = this._selectedItems.size;
        return count > 1
          ? `Delete ${count} Items Permanently`
          : 'Delete Permanently';
      },
      execute: () => {
        if (this._selectedItems.size > 0) {
          this._deleteItems([...this._selectedItems]);
        }
      }
    });

    this._commands.addCommand('trash:restore-from-source', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: trans.__('Restore'),
      execute: () => {
        if (this._sectionTarget !== null) {
          void this._restoreFromSource(
            this._sectionTarget.source,
            this._sectionTarget.item
          );
        }
      }
    });

    this._commands.addCommand('trash:show-volumes', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: () =>
        this._showVolumes ? trans.__('Hide Volumes') : trans.__('Show Volumes'),
      execute: () => this.toggleShowVolumes()
    });

    this._commands.addCommand('trash:clean-all', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: trans.__('Empty All Bins'),
      execute: () => {
        void this._cleanSources('all');
      }
    });

    this._commands.addCommand('trash:clean-workspace', {
      describedBy: { args: { type: 'object', properties: {} } },
      label: trans.__('Clean Workspace'),
      execute: () => {
        void this._cleanSources('workspace');
      }
    });
  }

  /** True while the sources show as sections below the XDG trash. */
  get showVolumes(): boolean {
    return this._showVolumes;
  }

  /**
   * Show or hide the source sections and save the choice. The main list
   * turns into the XDG trash or the merged list, so a folder of another
   * source is left for the top level.
   */
  toggleShowVolumes(): void {
    // A pull, spring or fold in flight ends at rest before the repaint
    this._abortHarmonica();
    this._showVolumes = !this._showVolumes;
    saveShowVolumes(this._showVolumes);
    // A removed section takes the focus with it; the main list gets it
    const inPanel = this.node.contains(document.activeElement);
    this._renderSections();
    if (inPanel && !this.node.contains(document.activeElement)) {
      this._focusListOrRefresh();
    }
    this._renderMain();
    // The menus and the palette redraw the entry with its new label
    this._commands.notifyCommandChanged('trash:show-volumes');
    void this.refresh(this._pathSource === 'xdg' ? this._path : [], 'xdg');
  }

  /**
   * Reload the panel on a user action. Lists the folder in view unless
   * another location is given.
   */
  async refresh(
    path: string[] = this._path,
    source: string = this._pathSource
  ): Promise<void> {
    // The veil covers the whole panel, header included, so it is raised only
    // while there is no list to show yet.
    const cold = !this._loaded;
    let token: symbol | null = null;
    if (cold) {
      this._setLoading(true);
    } else {
      // A static ring marks the button while the warm load runs
      token = Symbol();
      this._warmTokens.add(token);
      if (this._warmTokens.size === 1) {
        this._setWarmMark(true);
      }
    }
    try {
      await this._loadTrashContents(path, source);
    } catch (error) {
      console.error('Failed to load trash:', error);
      showErrorMessage('Trash Error', 'Failed to load trash contents');
    } finally {
      if (cold) {
        this._setLoading(false);
      } else if (token !== null) {
        // Remove only this refresh's token; a newer refresh keeps its own
        this._warmTokens.delete(token);
        if (this._warmTokens.size === 0) {
          this._setWarmMark(false);
        }
      }
    }
  }

  private _setLoading(on: boolean): void {
    this._loadingVeil.hidden = !on;
  }

  /**
   * Show or hide the busy mark on the refresh button. The mark follows the
   * set of pending warm-refresh tokens; the timer armed when the first token
   * arrives clears the whole set and the mark after STALE_LOAD_MS, so a
   * refresh that never returns cannot leave the button marked busy. The
   * request itself is not cancelled.
   */
  private _setWarmMark(on: boolean): void {
    if (this._warmMarkTimer !== null) {
      clearTimeout(this._warmMarkTimer);
      this._warmMarkTimer = null;
    }
    this._refreshBtn.setAttribute('aria-busy', String(on));
    this._refreshBtn.classList.toggle('jp-mod-busy', on);
    if (on) {
      this._warmMarkTimer = setTimeout(() => {
        this._warmMarkTimer = null;
        // A refresh that never returns must not keep the mark on
        this._warmTokens.clear();
        this._setWarmMark(false);
      }, STALE_LOAD_MS);
    }
  }

  /**
   * Background refresh without the veil - used for auto-refresh.
   */
  private async _refreshInBackground(): Promise<void> {
    if (this._pendingLoads > 0) {
      // A load in flight already carries the newest location; do not race it
      // until it has hung past the stale threshold. The newest pending start
      // decides, so a settled load's age can no longer fire this.
      const starts = [...this._loadStarts.values()];
      const newest = starts[starts.length - 1];
      if (Date.now() - newest < STALE_LOAD_MS) {
        return;
      }
      // The pending load is stale. Chase the folder the newest request asked
      // for, so a pending folder open is retried.
      try {
        await this._loadTrashContents(this._requestPath, this._requestSource);
      } catch (error) {
        console.error('Failed to load trash:', error);
      }
      return;
    }
    try {
      await this._loadTrashContents();
    } catch (error) {
      console.error('Failed to load trash:', error);
    }
  }

  /**
   * Request the listing of a location. A folder that no longer exists
   * answers 404; its nearest existing parent is listed in its place, and
   * `path` is shortened to that parent. The source applies inside a folder;
   * the top level is the XDG trash.
   */
  private async _fetchList(
    path: string[],
    source: string
  ): Promise<ITrashListResponse> {
    const folder = encodeURIComponent(path.join('/'));
    const endPoint =
      path.length === 0
        ? 'list'
        : source === 'xdg'
          ? `list?path=${folder}`
          : `list?source=${encodeURIComponent(source)}&path=${folder}`;
    try {
      return await requestAPI<ITrashListResponse>(
        endPoint,
        this._serverSettings
      );
    } catch (error: any) {
      if (path.length === 0 || error?.response?.status !== 404) {
        throw error;
      }
      path.pop();
      return this._fetchList(path, source);
    }
  }

  /**
   * Load a location from the API and render it. Defaults to the folder in
   * view.
   */
  private async _loadTrashContents(
    path: string[] = this._path,
    source: string = this._pathSource
  ): Promise<void> {
    const seq = ++this._loadSeq;
    const gen = this._trashGen;
    this._requestPath = [...path];
    this._requestSource = source;
    // Each pending load keeps its own start, so a settled load drops out of
    // the stale measure instead of carrying its age into the next one.
    this._loadStarts.set(seq, Date.now());
    const target = [...path];
    let data: ITrashListResponse;
    this._pendingLoads++;
    this._list.setAttribute('aria-busy', 'true');
    // Sources load alongside the listing; their sections never hold it back
    void this._loadSources();
    try {
      data = await this._fetchList(target, source);
    } finally {
      // The newest load owns the mark: when it ends, the list shown is final
      // even while an older request is still pending.
      if (seq === this._loadSeq) {
        this._list.setAttribute('aria-busy', 'false');
      }
      this._pendingLoads--;
      this._loadStarts.delete(seq);
    }
    // A load older than the one already shown is stale; a load older than a
    // newer request still renders when it answers the newest requested
    // location, which is the chased folder a pending open is waiting for.
    // A listing that started before a change to the trash is stale too
    if (seq < this._renderedSeq || gen !== this._trashGen) {
      return;
    }
    if (
      seq < this._loadSeq &&
      (target.join('/') !== this._requestPath.join('/') ||
        source !== this._requestSource)
    ) {
      return;
    }
    this._renderedSeq = seq;
    // The 404 fallback may have reached the top level, which is the XDG trash
    const listed = target.length > 0 ? source : 'xdg';

    // The selection and the shift-click anchor are kept by row key while
    // the location stays the same; a move to another folder clears both.
    if (
      target.join('/') !== this._path.join('/') ||
      listed !== this._pathSource
    ) {
      this._selectedItems.clear();
      this._lastClickedAnchor = null;
    }

    // The first successful render lowers the veil however the load started; a
    // cold refresh whose request hangs never reaches its own finally.
    const firstRender = !this._loaded;
    this._path = target;
    this._pathSource = listed;
    this._loaded = true;
    if (firstRender) {
      this._setLoading(false);
    }
    this._mainList =
      listed === 'xdg'
        ? data
        : {
            ...data,
            items: data.items.map(item => ({ ...item, source: listed }))
          };
    const hadCrumbFocus = this._renderBreadcrumb();
    this._renderColumnHeader();
    this._renderMain();
    // A crumb that is gone or no longer focusable still held the focus; the
    // new location takes it, so the keyboard continues from its list.
    if (hadCrumbFocus) {
      this._focusListOrRefresh();
    }
  }

  /** Show or hide the filter box. Hiding clears the query, so no filter the
   * user cannot see narrows the rows. */
  private _toggleFilter(): void {
    const show = this._filterWrap.hidden;
    // A hidden subtree cannot hold the focus; the header button takes it
    if (!show && this._filterWrap.contains(document.activeElement)) {
      this._filterBtn.focus();
    }
    this._filterWrap.hidden = !show;
    this._filterBtn.classList.toggle('jp-mod-active', show);
    this._filterBtn.setAttribute('aria-pressed', String(show));
    if (show) {
      this._filterInput.focus();
      return;
    }
    this._filter = '';
    this._filterInput.value = '';
    this._syncFilterClear();
    this._renderFiltered();
  }

  /** Show the clear button only while the field has text. */
  private _syncFilterClear(): void {
    this._filterClear.hidden = !this._filterInput.value;
  }

  /** True when the row's name or original path carries the query, ignoring
   * case. An empty query keeps every row. */
  private _matchesFilter(item: ITrashItem): boolean {
    const query = this._filter.trim().toLowerCase();
    return (
      query === '' ||
      item.name.toLowerCase().includes(query) ||
      item.original_path.toLowerCase().includes(query)
    );
  }

  /** Redraw the main list and every section with the current query. */
  private _renderFiltered(): void {
    // A row the query hides must not stay selected, or an action reaches a
    // file the user cannot see. The drawn rows are _items filtered, and
    // _getSortedItems only reorders them.
    const shown = new Set(this._items.filter(i => this._matchesFilter(i)));
    this._selectedItems = new Set(
      [...this._selectedItems].filter(i => shown.has(i))
    );
    this._renderItems();
    this._renderSections();
  }

  /**
   * Draw the main list from the last main listing. At the top level with
   * Show Volumes off, the rows of every other source's own listing join it,
   * and the summary counts and sizes them all.
   */
  private _renderMain(): void {
    const merged = !this._showVolumes && this._path.length === 0;
    const items = [...this._mainList.items];
    let totalSize = this._mainList.total_size;
    for (const source of merged ? this._sources : []) {
      const listing = this._sectionListings.get(source.id);
      if (
        source.id !== 'xdg' &&
        !source.error &&
        listing !== undefined &&
        !(listing instanceof Error)
      ) {
        items.push(
          ...listing.items.map(item => ({ ...item, source: source.id }))
        );
        totalSize += listing.total_size;
      }
    }
    // A source answering before the XDG trash shows its rows at once
    if (!this._loaded && items.length > 0) {
      this._setLoading(false);
    }
    const kept = new Set([...this._selectedItems].map(rowKey));
    this._items = items;
    this._selectedItems = new Set(items.filter(item => kept.has(rowKey(item))));
    if (!items.some(item => rowKey(item) === this._lastClickedAnchor)) {
      this._lastClickedAnchor = null;
    }
    // Without another source's rows the summary keeps the server's own text
    this._renderSummary(
      items.length === this._mainList.items.length
        ? this._mainList
        : {
            items,
            item_count: items.length,
            total_size: totalSize,
            total_size_formatted: formatSize(totalSize)
          }
    );
    this._renderItems();
  }

  private _renderSummary(data: ITrashListResponse): void {
    this._summaryCount = countText(data.item_count, data.total_size_formatted);
    this._paintEmptyBtn(data.item_count);
  }

  /**
   * The header trash button empties every source, so it is enabled while any
   * holds an item. With Show Volumes on, the summary bar at the top level
   * totals every trash from the sources answer.
   */
  private _paintEmptyBtn(count = this._mainList.item_count): void {
    // Inside a folder the trash holds at least that folder
    setOff(
      this._emptyBtn,
      this._path.length === 0 &&
        count === 0 &&
        this._sources.every(source => source.item_count === 0),
      this._refreshBtn
    );
    let text = this._summaryCount;
    if (this._showVolumes && this._path.length === 0) {
      const items = this._sources.reduce(
        (sum, source) => sum + source.item_count,
        0
      );
      const bytes = this._sources.reduce(
        (sum, source) => sum + source.total_bytes,
        0
      );
      // Before the first sources answer the bar stays blank: a count of the
      // main list alone would be a total that leaves out a trash
      text =
        this._sources.length === 0 ? '' : countText(items, formatSize(bytes));
    }
    this._summaryText.textContent = text;
  }

  /**
   * Fetch the source list for a load and draw its sections. The main listing
   * does not wait for this request.
   */
  private async _loadSources(): Promise<void> {
    const gen = this._trashGen;
    if (this._sourcesGen === gen) {
      return;
    }
    this._sourcesGen = gen;
    let sources: ITrashSource[];
    try {
      sources = await requestAPI<ITrashSource[]>(
        'sources',
        this._serverSettings
      );
    } catch (error) {
      console.warn('Failed to load trash sources:', error);
      return;
    } finally {
      this._sourcesSettled = true;
      if (this._sourcesGen === gen) {
        this._sourcesGen = null;
      }
    }
    // An answer that started before a change to the trash is stale
    if (gen !== this._trashGen) {
      return;
    }
    this._sources = sources;
    // Every load refreshes each source's own listing
    this._sectionFetched.clear();
    this._renderSections();
    this._paintEmptyBtn();
    // Every other source lists at once: off, its rows join the merged list as
    // it answers; on, a fold previews and opens a neighbour with rows ready
    for (const source of sources) {
      if (source.id !== 'xdg' && !source.error) {
        void this._loadSectionList(source);
      }
    }
    this._renderMain();
  }

  /**
   * Draw the sections of the sources the server returned, home first and the
   * rest in its order. One section is open at rest; the collapsed key is
   * normalised to describe exactly that. A source that still has a section
   * keeps its elements and the focus in them.
   */
  private _renderSections(): void {
    this._abortHarmonica();
    if (this._showVolumes && this._sources.length > 0) {
      this._normaliseCollapsed();
    }
    this.toggleClass('jp-mod-bands', this._showVolumes);
    const folded = this._homeFolded();
    const previous = new Map(this._sectionParts);
    this._sectionParts.clear();
    // Show Volumes off draws none
    const sources = this._showVolumes ? this._orderedSources() : [];
    let index = 0;
    for (const source of sources) {
      const parts = previous.get(source.id) ?? this._createSection(source);
      previous.delete(source.id);
      this._sectionParts.set(source.id, parts);
      // Moving a node drops the focus in it, so only a misplaced section
      // moves
      const at = this._sectionsEl.children[index++] ?? null;
      if (at !== parts.section) {
        this._sectionsEl.insertBefore(parts.section, at);
      }
      this._paintSection(source, parts);
    }
    // The main elements move into the home entries box, or back before the
    // column first, so removing a home section never takes the list with it
    this._placeMainElements();
    for (const parts of previous.values()) {
      parts.section.remove();
    }
    // A home band that came or went folds or unfolds the main list
    if (this._homeFolded() !== folded) {
      this._paintHomeFold();
    }
    this._updateShort();
  }

  /** The home section first, then the other sources in the server's order. */
  private _orderedSources(): ITrashSource[] {
    const home = this._sources.find(source => source.id === 'xdg');
    const rest = this._sources.filter(source => source.id !== 'xdg');
    return home === undefined ? rest : [home, ...rest];
  }

  /** The section open at rest: the first source the key leaves open. */
  private _openId(): string | null {
    return (
      this._orderedSources().find(source => !this._collapsed.has(source.id))
        ?.id ?? null
    );
  }

  /**
   * Write every source id to the collapsed key except the open one, or every
   * id when none is open, so the key describes the drawn state.
   */
  private _normaliseCollapsed(): void {
    this._setOpen(this._openId());
  }

  /** Open one section and fold every other; nothing opens for a null id. */
  private _setOpen(id: string | null): void {
    this._collapsed = new Set(
      this._sources.filter(source => source.id !== id).map(source => source.id)
    );
    saveCollapsed(this._collapsed);
  }

  /**
   * Move the breadcrumb, the column header, the main list and its empty line
   * into the home entries box while Show Volumes is on, and back before the
   * column while it is off. A node moves only from a wrong parent, so a
   * re-render keeps the focus.
   */
  private _placeMainElements(): void {
    const home = this._sectionParts.get('xdg');
    const inside = this._showVolumes && home !== undefined;
    if (!inside) {
      // The main elements move out of the home entries box first, so the
      // removed home section can never take the list with it
      if (this._breadcrumb.parentElement !== this.node) {
        this.node.insertBefore(this._breadcrumb, this._sectionsEl);
      }
      if (this._columnHeader.parentElement !== this.node) {
        this.node.insertBefore(this._columnHeader, this._sectionsEl);
      }
      if (this._list.parentElement !== this.node) {
        this.node.insertBefore(this._list, this._sectionsEl);
      }
      if (this._emptyMessage.parentElement !== this.node) {
        this.node.insertBefore(this._emptyMessage, this._sectionsEl);
      }
      // The column keeps its place after the main elements
      if (this._sectionsEl.previousElementSibling !== this._emptyMessage) {
        this._emptyMessage.after(this._sectionsEl);
      }
      return;
    }
    // The column sits directly under the summary bar while it draws the home
    // section
    if (this._summary.nextElementSibling !== this._sectionsEl) {
      this.node.insertBefore(
        this._sectionsEl,
        this._summary.nextElementSibling
      );
    }
    const entries = home!.entries;
    if (this._homeChrome.parentElement !== entries) {
      entries.insertBefore(this._homeChrome, entries.firstChild);
    }
    if (this._breadcrumb.parentElement !== this._homeChrome) {
      this._homeChrome.appendChild(this._breadcrumb);
    }
    if (this._columnHeader.parentElement !== this._homeChrome) {
      this._homeChrome.appendChild(this._columnHeader);
    }
    if (this._list.parentElement !== entries) {
      entries.appendChild(this._list);
    }
    if (this._emptyMessage.parentElement !== entries) {
      entries.appendChild(this._emptyMessage);
    }
  }

  /** True while the home band shows folded, which hides the main list. */
  private _homeFolded(): boolean {
    return this._sectionParts.has('xdg') && this._openId() !== 'xdg';
  }

  /** Show or hide the breadcrumb, column header and main list by the home fold. */
  private _paintHomeFold(): void {
    this._renderItems();
    if (this._renderBreadcrumb()) {
      this._focusListOrRefresh();
    }
  }

  /**
   * The static bands: every section's band plus its section borders, which
   * the entries box's own height does not cover.
   */
  private _bandHeight(): number {
    let bands = 0;
    for (const parts of this._sectionParts.values()) {
      bands += parts.section.offsetHeight - parts.entries.offsetHeight;
    }
    return bands;
  }

  /** True while the static bands alone fill or overflow the column. */
  private _short(): boolean {
    return (
      this._sectionsEl.clientHeight > 0 &&
      this._sectionsEl.clientHeight - this._bandHeight() <= 0
    );
  }

  /** Scroll the column in a panel too short for its bands, or clip it. */
  private _updateShort(): void {
    this._sectionsEl.classList.toggle('jp-mod-short', this._short());
  }

  /**
   * The panel-wide wheel. At the open list's end it stretches a pull that
   * previews the neighbour; the event that brings the pull to the give
   * length folds the section and opens the neighbour. Elsewhere the browser
   * keeps the event, and the open list scrolls natively or by the delta.
   */
  private _handleWheel(event: WheelEvent): void {
    // A horizontal or zoom wheel is the browser's
    if (event.deltaY === 0 || event.ctrlKey) {
      return;
    }
    // Wheel events during the fold are cancelled and do nothing
    if (this._phase === 'folding') {
      event.preventDefault();
      return;
    }
    // A column too short for its bands scrolls as a whole; the browser keeps
    // the wheel so no band is clipped out of reach
    if (this._short()) {
      return;
    }
    const openId = this._openId();
    const parts = openId === null ? undefined : this._sectionParts.get(openId);
    // No open section, or the veil covers the panel: the page keeps its scroll
    if (parts === undefined || !this._loadingVeil.hidden) {
      return;
    }
    const scroller = parts.entries;
    if (this._phase === 'idle') {
      // The held base is the open box's height at rest
      this._base = scroller.offsetHeight;
      this._give = giveLength(this._base);
    }
    const direction: 1 | -1 = event.deltaY > 0 ? 1 : -1;
    if (
      !atEnd(scroller.scrollTop, scroller.scrollHeight, this._base, direction)
    ) {
      // The open list can scroll this way
      this._resetPull();
      if (scroller.contains(event.target as Node)) {
        return;
      }
      event.preventDefault();
      // A whole-pixel scrollTop write drops the remainder; keep it so a
      // slow touchpad scroll still moves
      const want = scroller.scrollTop + this._wheelCarry + event.deltaY;
      scroller.scrollTop = want;
      const dropped = want - scroller.scrollTop;
      this._wheelCarry = Math.abs(dropped) < 1 ? dropped : 0;
      return;
    }
    event.preventDefault();
    const order = this._orderedSources();
    const at = order.findIndex(source => source.id === openId);
    const neighbour = order[at + direction];
    // No neighbour: the event is absorbed and starts no pull
    if (neighbour === undefined) {
      this._resetPull();
      return;
    }
    // Stretch from the pull on screen; a direction change drops the preview
    // and starts at zero, so the opposite neighbour is never left stretched
    let start = this._pull;
    if (this._pullDir !== direction) {
      this._resetPull();
      start = 0;
    }
    this._stopSpring();
    const enterParts = this._sectionParts.get(neighbour.id)!;
    this._leave = { section: parts.section, entries: scroller };
    this._enter = { section: enterParts.section, entries: enterParts.entries };
    this._pullDir = direction;
    this._phase = 'pulling';
    this._pull = pullStep(start, event.deltaY, this._give);
    if (this._pull >= this._give) {
      this._startFold();
      return;
    }
    this._paintPull();
    this._armSpring();
  }

  /** Render the pull as a height trade between the two entries boxes. */
  private _paintPull(): void {
    const leave = this._leave;
    const enter = this._enter;
    if (leave === null || enter === null) {
      return;
    }
    const pull = Math.max(0, this._pull);
    leave.entries.classList.add('jp-mod-animating');
    enter.entries.classList.add('jp-mod-animating');
    // The entering band draws no folded divider while it previews
    enter.section.classList.remove('jp-mod-collapsed');
    const leaveHeight = Math.max(0, this._base - pull);
    leave.entries.style.height = `${leaveHeight}px`;
    enter.entries.style.height = `${pull}px`;
    this._pin(leave, leaveHeight);
    this._pin(enter, pull);
  }

  /**
   * Pin the leaving list to the edge the user is at and the entering list
   * to the opposite edge, after the height is applied: down leaves the
   * bottom and enters the top, up the reverse.
   */
  private _pin(side: ISectionSide, height: number): void {
    const top =
      this._pullDir === 1 ? side === this._enter : side === this._leave;
    side.entries.scrollTop = top
      ? 0
      : Math.max(0, side.entries.scrollHeight - height);
  }

  /** Arm the 160ms idle spring that returns a short pull to rest. */
  private _armSpring(): void {
    this._stopSpring();
    this._springTimer = setTimeout(() => {
      this._springTimer = null;
      if (this._phase !== 'pulling') {
        return;
      }
      this._phase = 'springing';
      this._springStart = Date.now();
      this._springFrom = this._pull;
      this._stepSpring();
    }, 160);
  }

  /** Run the damped spring from the pull on screen, under 300ms. */
  private _stepSpring(): void {
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      const elapsed = Date.now() - this._springStart;
      this._pull = springPull(this._springFrom, elapsed);
      if (Math.abs(this._pull) < 1 || elapsed >= 300) {
        this._resetPull();
        return;
      }
      this._paintPull();
      this._stepSpring();
    });
  }

  /**
   * Fold the leaving section to its band and open the entering one over
   * 400ms, ease-out cubic, from the heights on screen. The enter target is
   * its content height or the space the bands leave, whichever is shorter.
   */
  private _startFold(): void {
    const enter = this._enter!;
    this._phase = 'folding';
    this._foldStart = Date.now();
    // The give event renders its own preview before the frames take over;
    // the reveal also lets the entering box's content be measured
    this._paintPull();
    const free = this._sectionsEl.clientHeight - this._bandHeight();
    this._enterTarget = Math.max(0, Math.min(enter.entries.scrollHeight, free));
    this._stepFold();
  }

  /** One fold frame; the wall clock finishes it even in a throttled tab. */
  private _stepFold(): void {
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      const elapsed = Date.now() - this._foldStart;
      const e = easeOutCubic(Math.min(1, elapsed / 400));
      const leave = this._leave!;
      const enter = this._enter!;
      const leaveHeight = (this._base - this._give) * (1 - e);
      const enterHeight = this._give + (this._enterTarget - this._give) * e;
      leave.entries.style.height = `${leaveHeight}px`;
      enter.entries.style.height = `${enterHeight}px`;
      this._pin(leave, leaveHeight);
      this._pin(enter, enterHeight);
      if (elapsed >= 400) {
        this._finishFold();
        return;
      }
      this._stepFold();
    });
  }

  /** Swap the open section at the fold's end and clear every inline height. */
  private _finishFold(): void {
    const leave = this._leave!;
    const enter = this._enter!;
    const enterId = enter.section.dataset.source!;
    const homeFolded = this._homeFolded();
    // The leaving entries box is hidden after the fold; the focus moves to
    // the entering band rather than the page body
    const hadFocus = leave.section.contains(document.activeElement);
    const direction = this._pullDir;
    this._clearHeights();
    this._pull = 0;
    this._phase = 'idle';
    this._leave = null;
    this._enter = null;
    this._setOpen(enterId);
    this._paintAllSections();
    // The entering list rests at the edge the wheel came from
    enter.entries.scrollTop =
      direction === 1
        ? 0
        : Math.max(0, enter.entries.scrollHeight - enter.entries.offsetHeight);
    if (hadFocus) {
      this._sectionParts.get(enterId)?.header.focus();
    }
    if (this._homeFolded() !== homeFolded) {
      this._paintHomeFold();
    }
  }

  /**
   * End any pull, spring or fold at rest before a repaint. A running fold
   * keeps its entering section open; the normalised key is saved.
   */
  private _abortHarmonica(): void {
    const folding = this._phase === 'folding';
    const enterId = folding
      ? (this._enter?.section.dataset.source ?? null)
      : null;
    this._clearHeights();
    // The preview dropped the folded class; the open state did not change
    if (this._enter !== null && !folding) {
      this._enter.section.classList.add('jp-mod-collapsed');
    }
    this._pull = 0;
    this._phase = 'idle';
    this._leave = null;
    this._enter = null;
    if (folding && enterId !== null) {
      // The fold's end state: the entering section opens, the leaving folds
      this._setOpen(enterId);
      this._paintAllSections();
    } else if (this._showVolumes && this._sources.length > 0) {
      this._normaliseCollapsed();
    }
  }

  /** Cancel the spring timer and the frame, and drop the inline heights. */
  private _clearHeights(): void {
    this._stopSpring();
    for (const side of [this._leave, this._enter]) {
      if (side === null) {
        continue;
      }
      side.entries.classList.remove('jp-mod-animating');
      side.entries.style.height = '';
    }
  }

  /** Stop the spring timer and its frame chain. */
  private _stopSpring(): void {
    if (this._springTimer !== null) {
      clearTimeout(this._springTimer);
      this._springTimer = null;
    }
    if (this._frame !== null) {
      cancelAnimationFrame(this._frame);
      this._frame = null;
    }
  }

  /** Drop the pull, its preview and the spring, leaving the open section. */
  private _resetPull(): void {
    const enter = this._enter;
    this._clearHeights();
    if (enter !== null) {
      enter.section.classList.add('jp-mod-collapsed');
    }
    this._pull = 0;
    this._phase = 'idle';
    this._leave = null;
    this._enter = null;
  }

  private _createSection(source: ITrashSource): ISectionParts {
    const section = document.createElement('div');
    section.className = 'jp-TrashPanel-section';
    section.dataset.source = source.id;

    // The band holds the fold toggle and the trash button as siblings, so a
    // trash click or key never reaches the toggle
    const band = document.createElement('div');
    band.className = 'jp-TrashPanel-sectionBand';

    // A native button takes the focus and the Enter / Space activation
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'jp-TrashPanel-sectionHeader';

    const caret = document.createElement('span');
    caret.className = 'jp-TrashPanel-caret';
    // Decorative: the state it draws is already on aria-expanded
    caret.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'jp-TrashPanel-sectionLabel';

    header.append(caret, label);
    header.addEventListener('click', () => this._toggleSection(source.id));
    header.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') {
        return;
      }
      // preventDefault stops the native click, so the toggle runs once
      e.preventDefault();
      this._toggleSection(source.id);
    });

    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'jp-TrashPanel-sectionEmpty';
    empty.title = trans.__('Empty Trash in %1', source.label);
    trashIcon.element({ container: empty });
    empty.addEventListener('click', () => this._emptySource(source.id));
    band.append(header, empty);

    // The entries box is the section's only scroll container
    const entries = document.createElement('div');
    entries.className = 'jp-TrashPanel-sectionEntries';
    section.append(band, entries);
    // The home band's rows are the main list, moved into its entries box
    if (source.id === 'xdg') {
      return { section, header, empty, entries, caret, label };
    }

    const none = document.createElement('div');
    none.className = 'jp-TrashPanel-empty';
    none.textContent = trans.__('Trash is empty');
    none.hidden = true;

    const list = document.createElement('div');
    list.className = 'jp-TrashPanel-sectionList';
    // Every trash's rows restore; the list is one tab stop whose arrows move
    // the active row and whose focused row is the active one
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', source.label);
    list.addEventListener('keydown', (e: KeyboardEvent) => {
      const rows = Array.from(list.children) as HTMLElement[];
      const moved = movedIndex(
        e.key,
        rows.findIndex(row => row.tabIndex === 0),
        rows.length
      );
      if (moved === null || rows.length === 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      rows[moved].focus();
      rows[moved].scrollIntoView?.({ block: 'nearest' });
    });
    list.addEventListener('focusin', (e: FocusEvent) =>
      this._activateSectionRow(source.id, list, e.target as HTMLElement)
    );

    entries.append(list, none);
    return { section, header, empty, entries, none, caret, label, list };
  }

  /**
   * A band click or key: open the folded band, or fold the open one. A fold
   * in flight ends at its end state first, so the click applies to the
   * section the fold leaves open.
   */
  private _toggleSection(id: string): void {
    const homeFolded = this._homeFolded();
    this._abortHarmonica();
    if (this._openId() === id) {
      this._collapsed.add(id);
      saveCollapsed(this._collapsed);
    } else {
      this._setOpen(id);
    }
    this._paintAllSections();
    if (homeFolded !== this._homeFolded()) {
      this._paintHomeFold();
    }
  }

  /** Draw every section from its source and its own listing. */
  private _paintAllSections(): void {
    // The collapsed class hides the home entries box, and a browser blurs a
    // hidden box before _renderItems can see the focus; remember it
    const homeFocus =
      document.activeElement === this._list ||
      this._columnHeader.contains(document.activeElement);
    for (const source of this._sources) {
      const parts = this._sectionParts.get(source.id);
      if (parts !== undefined) {
        this._paintSection(source, parts);
      }
    }
    // A hidden box that kept the focus hands it to the home band, or to the
    // refresh button while the empty branch would
    if (
      homeFocus &&
      this._homeFolded() &&
      !this.node.contains(document.activeElement)
    ) {
      (this._items.length === 0
        ? this._refreshBtn
        : this._sectionParts.get('xdg')!.header
      ).focus();
    }
  }

  /**
   * Draw one section from the source list and its own listing. The header
   * always carries the source's count and size, so a collapsed section still
   * reports what it holds.
   */
  private _paintSection(source: ITrashSource, parts: ISectionParts): void {
    // A pull, spring or fold in flight ends at rest before the repaint
    this._abortHarmonica();
    const expanded = this._openId() === source.id;
    parts.header.setAttribute('aria-expanded', String(expanded));
    parts.caret.textContent = expanded ? '▾' : '▸';
    // A folded band draws the divider under it
    parts.section.classList.toggle('jp-mod-collapsed', !expanded);
    // The collapsed class hides the entries box; folded and previewed rows
    // never take a tab stop
    parts.entries.toggleAttribute('inert', !expanded);
    setOff(parts.empty, source.item_count === 0, parts.header);

    const cached = this._sectionListings.get(source.id);
    const error =
      source.error || (cached instanceof Error ? cached.message : '');
    if (parts.list && parts.none) {
      // Not while pending or failed
      parts.none.hidden =
        Boolean(error) ||
        cached === undefined ||
        cached instanceof Error ||
        cached.items.length > 0;
    }
    // The label or the error takes the ellipsis; the count and size never shrink
    const text = document.createElement('span');
    text.className = 'jp-TrashPanel-sectionText';
    text.textContent = error
      ? trans.__('%1: %2', source.label, error)
      : source.label;
    // The ellipsis can hide the label's end; the tooltip carries all of it
    // and names the volume holding the trash
    text.title = trans.__('%1 on %2', text.textContent, source.mountpoint);
    if (error) {
      parts.label.replaceChildren(text);
      parts.list?.replaceChildren();
      parts.key = undefined;
      return;
    }
    const count = document.createElement('span');
    count.className = 'jp-TrashPanel-sectionCount';
    count.textContent = this._sourceCount(source);
    parts.label.replaceChildren(text, count);
    // The home band's rows are the main list, which lists on its own
    if (parts.list === undefined) {
      return;
    }

    // Every source lists on its own; a pending answer is not asked again
    void this._loadSectionList(source);
    if (cached === undefined || cached instanceof Error) {
      return;
    }
    // An unchanged listing and query keep their rows, and the focused one,
    // and only move their ages on
    const shown = cached.items.filter(item => this._matchesFilter(item));
    const key = JSON.stringify([
      this._filter.trim().toLowerCase(),
      cached.items.map(item => [item.trash_path, item.size, item.deletion_date])
    ]);
    if (key === parts.key) {
      shown.forEach((item, index) => {
        parts.list!.children[index].querySelector(
          '.jp-TrashPanel-sectionAge'
        )!.textContent = this._formatRelativeTime(item.deletion_date);
      });
      return;
    }
    parts.key = key;
    const hadFocus = parts.list.contains(document.activeElement);
    parts.list.innerHTML = '';
    for (const item of shown) {
      parts.list.appendChild(this._sectionRow(item, source.id));
    }
    // The rebuilt rows keep the active row and the focus it held
    const rows = Array.from(parts.list.children) as HTMLElement[];
    const active =
      rows.find(
        row => row.dataset.path === this._sectionActive.get(source.id)
      ) ?? rows[0];
    this._activateSectionRow(source.id, parts.list, active);
    if (hadFocus) {
      (active ?? parts.header).focus();
    }
  }

  /** Make one row of a section the tab stop of its list. */
  private _activateSectionRow(
    source: string,
    list: HTMLElement,
    row: HTMLElement | undefined
  ): void {
    for (const el of Array.from(list.children) as HTMLElement[]) {
      el.tabIndex = el === row ? 0 : -1;
    }
    if (row?.dataset.path !== undefined) {
      this._sectionActive.set(source, row.dataset.path);
    }
  }

  /** Open the Restore menu of a section row at a point. */
  private _openSectionMenu(
    source: string,
    item: ITrashItem,
    row: HTMLElement,
    x: number,
    y: number
  ): void {
    this._activateSectionRow(source, row.parentElement!, row);
    this._sectionTarget = { source, item };
    this.node.classList.add('jp-mod-contextMenuOpen');
    this._sectionMenu.open(x, y);
  }

  /**
   * Restore one entry of a section's trash to its original path. Success
   * reloads the source counts and the section listings; a failure, such as
   * an existing destination, is reported the way the main list reports it.
   */
  private async _restoreFromSource(
    source: string,
    item: ITrashItem
  ): Promise<void> {
    this._setLoading(true);
    try {
      await requestAPI<{ success: boolean; restored_to: string }>(
        'restore',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({ trash_path: item.trash_path, source })
        }
      );
      // The row after the restored one becomes active, or the one before it
      // when it was last; none leaves the focus to the section header
      const rows = Array.from(
        this._sectionParts.get(source)?.list?.children ?? []
      ) as HTMLElement[];
      const index = rows.findIndex(row => row.dataset.path === item.trash_path);
      const next = (rows[index + 1] ?? rows[index - 1])?.dataset.path;
      if (next === undefined) {
        this._sectionActive.delete(source);
      } else {
        this._sectionActive.set(source, next);
      }
      // A section row restores out of its own trash only
      this._reloadChanged(
        (id, row) => id === source && row.trash_path === item.trash_path,
        false
      );
    } catch (error: any) {
      showErrorMessage(
        'Restore Failed',
        `${item.name}: ${error?.message || 'unknown error'}`
      );
    } finally {
      this._setLoading(false);
    }
  }

  /**
   * Fetch one source's listing. The section, or the merged list, renders as
   * soon as this answer arrives, whatever the other sources are doing.
   */
  private async _loadSectionList(source: ITrashSource): Promise<void> {
    const id = source.id;
    const gen = this._trashGen;
    if (this._sectionPending.get(id) === gen || this._sectionFetched.has(id)) {
      return;
    }
    this._sectionPending.set(id, gen);
    let result: ITrashListResponse | Error;
    try {
      result = await requestAPI<ITrashListResponse>(
        `list?source=${encodeURIComponent(id)}`,
        this._serverSettings
      );
    } catch (error: any) {
      result =
        error instanceof Error ? error : new Error(String(error?.message));
    }
    if (this._sectionPending.get(id) === gen) {
      this._sectionPending.delete(id);
    }
    // An answer that started before a change to the trash is stale
    if (gen !== this._trashGen) {
      return;
    }
    this._sectionFetched.add(id);
    this._sectionListings.set(id, result);
    const parts = this._sectionParts.get(id);
    const current = this._sources.find(item => item.id === id);
    if (parts !== undefined && current !== undefined) {
      this._paintSection(current, parts);
    }
    // Before the first main listing the top level is the merged list too
    if (!this._showVolumes && this._path.length === 0) {
      this._renderMain();
    }
  }

  /** One section row; it opens the Restore menu of its source. */
  private _sectionRow(item: ITrashItem, source: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'jp-TrashPanel-sectionRow';
    row.dataset.path = item.trash_path;
    row.setAttribute('role', 'option');
    row.title = this._itemTitle(item, source);
    row.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._openSectionMenu(source, item, row, e.clientX, e.clientY);
    });
    row.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!isMenuKey(e)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      this._openSectionMenu(source, item, row, rect.left + 8, rect.bottom);
    });

    const name = document.createElement('span');
    name.className = 'jp-TrashPanel-sectionName';
    name.textContent = item.name;

    const age = document.createElement('span');
    age.className = 'jp-TrashPanel-sectionAge';
    age.textContent = this._formatRelativeTime(item.deletion_date);

    const size = document.createElement('span');
    size.className = 'jp-TrashPanel-sectionSize';
    size.textContent = item.size_formatted;

    row.append(name, age, size);
    return row;
  }

  /** A source's label with its count and size, as the header shows it. */
  private _sourceSummary(source: ITrashSource): string {
    return source.label + this._sourceCount(source);
  }

  /** The ' (n items, size)' part of a source's summary. */
  private _sourceCount(source: ITrashSource): string {
    const noun = source.item_count === 1 ? trans.__('item') : trans.__('items');
    return trans.__(' (%1 %2, %3)', source.item_count, noun, source.total_size);
  }

  /**
   * Rebuild the crumbs. Returns true when the breadcrumb held the focus and
   * the rebuilt crumb could not take it back.
   */
  private _renderBreadcrumb(): boolean {
    // The reload rebuilds the crumbs; remember which one held the focus by
    // its depth so the focus returns to the same place.
    const focused = Array.from(
      this._breadcrumb.querySelectorAll<HTMLElement>('.jp-TrashPanel-crumb')
    ).indexOf(document.activeElement as HTMLElement);
    this._breadcrumb.innerHTML = '';
    this._breadcrumb.hidden = this._path.length === 0;

    const labels = ['Trash', ...this._path];
    const built: HTMLElement[] = [];
    labels.forEach((label, depth) => {
      if (depth > 0) {
        const separator = document.createElement('span');
        separator.className = 'jp-TrashPanel-crumbSeparator';
        separator.textContent = '/';
        separator.setAttribute('aria-hidden', 'true');
        this._breadcrumb.appendChild(separator);
      }

      // The last segment is the folder in view; the ones before it navigate
      const isCurrent = depth === this._path.length;
      const crumb = document.createElement(isCurrent ? 'span' : 'button');
      crumb.className = 'jp-TrashPanel-crumb';
      crumb.textContent = label;
      crumb.title = label;
      if (isCurrent) {
        crumb.classList.add('jp-mod-current');
      } else {
        crumb.addEventListener('click', () =>
          this._navigate(this._path.slice(0, depth))
        );
      }
      this._breadcrumb.appendChild(crumb);
      built.push(crumb);
    });

    const restore = built[focused];
    // The folded home entries box hides the crumb, so it cannot take the
    // focus back
    if (
      restore instanceof HTMLButtonElement &&
      !this._breadcrumb.hidden &&
      !this._homeFolded()
    ) {
      restore.focus();
      return false;
    }
    return focused >= 0;
  }

  /** Focus the list, or the refresh button when the list is hidden. */
  private _focusListOrRefresh(): void {
    const target =
      this._homeFolded() || this._list.style.display === 'none'
        ? this._refreshBtn
        : this._list;
    target.focus();
  }

  /**
   * Show another location: a folder inside the trash, or the top level for
   * an empty path.
   */
  private _navigate(path: string[], source: string = this._pathSource): void {
    void this.refresh(path, source);
  }

  private _renderColumnHeader(): void {
    // The rebuild replaces the buttons; remember which one held the focus by
    // its position so the focus returns to the same column.
    const focused = Array.from(
      this._columnHeader.querySelectorAll<HTMLElement>(
        '.jp-TrashPanel-sortable'
      )
    ).indexOf(document.activeElement as HTMLElement);
    this._columnHeader.innerHTML = '';

    const createHeader = (
      label: string,
      column: SortColumn,
      className: string
    ) => {
      // A native button carries focus and Enter/Space activation itself
      const header = document.createElement('button');
      header.type = 'button';
      header.className = `${className} jp-TrashPanel-sortable`;
      header.textContent = label;
      header.setAttribute(
        'aria-label',
        `${label}, ${
          this._sortColumn === column
            ? this._sortDirection === 'asc'
              ? trans.__('sorted ascending')
              : trans.__('sorted descending')
            : trans.__('not sorted')
        }`
      );

      if (this._sortColumn === column) {
        const arrow = document.createElement('span');
        arrow.className = 'jp-TrashPanel-sortArrow';
        arrow.textContent =
          this._sortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
        header.appendChild(arrow);
      }

      header.addEventListener('click', () => this._handleSort(column));
      return header;
    };

    this._columnHeader.appendChild(
      createHeader('Name', 'name', 'jp-TrashPanel-col-name')
    );
    this._columnHeader.appendChild(
      createHeader('Deleted', 'modified', 'jp-TrashPanel-col-modified')
    );
    this._columnHeader.appendChild(
      createHeader('Size', 'size', 'jp-TrashPanel-col-size')
    );

    if (focused >= 0) {
      this._columnHeader
        .querySelectorAll<HTMLButtonElement>('.jp-TrashPanel-sortable')
        [focused].focus();
    }
  }

  private _handleSort(column: SortColumn): void {
    if (this._sortColumn === column) {
      this._sortDirection = this._sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortColumn = column;
      this._sortDirection = column === 'name' ? 'asc' : 'desc';
    }
    this._renderColumnHeader();
    this._renderItems();
  }

  private _getSortedItems(): ITrashItem[] {
    const items = [...this._items];
    const dir = this._sortDirection === 'asc' ? 1 : -1;

    items.sort((a, b) => {
      let order = 0;
      switch (this._sortColumn) {
        case 'name':
          order = dir * a.name.localeCompare(b.name);
          break;
        case 'modified':
          order = dir * a.deletion_date.localeCompare(b.deletion_date);
          break;
        case 'size':
          order = dir * (a.size - b.size);
          break;
      }
      // A tie must resolve the same way in both directions, or the arrow
      // claims an order the list does not have; the row key breaks it.
      return order !== 0 ? order : rowKey(a).localeCompare(rowKey(b));
    });

    return items;
  }

  private _renderItems(): void {
    // A pull, spring or fold in flight ends at rest before the repaint
    this._abortHarmonica();
    this._list.innerHTML = '';
    this._itemElements.clear();
    const folded = this._homeFolded();

    if (this._items.length === 0) {
      // The merged top level is empty only once every source has answered
      const waiting =
        !this._loaded ||
        (!this._showVolumes &&
          this._path.length === 0 &&
          (!this._sourcesSettled ||
            this._sources.some(
              source =>
                source.id !== 'xdg' &&
                !source.error &&
                !this._sectionListings.has(source.id)
            )));
      this._emptyMessage.textContent =
        this._path.length > 0
          ? trans.__('Folder is empty')
          : trans.__('Trash is empty');
      this._emptyMessage.style.display = waiting ? 'none' : '';
      // A hidden element cannot hold the focus; hand it to the header
      if (
        document.activeElement === this._list ||
        this._columnHeader.contains(document.activeElement)
      ) {
        this._refreshBtn.focus();
      }
      this._columnHeader.style.display = 'none';
      this._list.style.display = 'none';
      this._sortedItems = [];
      this._restoreActiveRow();
      return;
    }

    this._emptyMessage.style.display = 'none';
    // A hidden list cannot hold the focus; the home band's fold toggle takes it
    if (
      folded &&
      (document.activeElement === this._list ||
        this._columnHeader.contains(document.activeElement))
    ) {
      this._sectionParts.get('xdg')!.header.focus();
    }
    this._columnHeader.style.display = 'flex';
    this._list.style.display = 'block';

    this._sortedItems = this._getSortedItems().filter(item =>
      this._matchesFilter(item)
    );
    for (const item of this._sortedItems) {
      const itemEl = this._createItemElement(item);
      this._itemElements.set(item, itemEl);
      this._list.appendChild(itemEl);
    }
    this._restoreActiveRow();
  }

  private _clearSelection(): void {
    for (const item of this._selectedItems) {
      const el = this._itemElements.get(item);
      if (el) {
        el.classList.remove('jp-mod-selected');
        el.setAttribute('aria-selected', 'false');
      }
    }
    this._selectedItems.clear();
  }

  private _selectItem(item: ITrashItem): void {
    this._selectedItems.add(item);
    const el = this._itemElements.get(item);
    if (el) {
      el.classList.add('jp-mod-selected');
      el.setAttribute('aria-selected', 'true');
    }
  }

  private _deselectItem(item: ITrashItem): void {
    this._selectedItems.delete(item);
    const el = this._itemElements.get(item);
    if (el) {
      el.classList.remove('jp-mod-selected');
      el.setAttribute('aria-selected', 'false');
    }
  }

  private _handleItemClick(item: ITrashItem, index: number, e: MouseEvent) {
    // A click makes its row the active row, so the keyboard continues from it
    this._activePath = rowKey(item);
    this._renderActiveRow();
    // Resolve the anchor by path: a sort change reorders the rows between clicks
    const anchorIndex =
      this._lastClickedAnchor === null
        ? -1
        : this._sortedItems.findIndex(
            row => rowKey(row) === this._lastClickedAnchor
          );
    if (e.shiftKey && anchorIndex >= 0) {
      // Shift+click: range select from the anchor to the current row
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);

      if (!e.ctrlKey && !e.metaKey) {
        this._clearSelection();
      }

      for (let i = start; i <= end; i++) {
        this._selectItem(this._sortedItems[i]);
      }
      // Don't update the anchor on shift+click to allow extending range
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle individual item
      if (this._selectedItems.has(item)) {
        this._deselectItem(item);
      } else {
        this._selectItem(item);
      }
      this._lastClickedAnchor = rowKey(item);
    } else {
      // Normal click: select only this item
      this._clearSelection();
      this._selectItem(item);
      this._lastClickedAnchor = rowKey(item);
    }
  }

  /**
   * The hover title of a restorable row: where it restores to, what it is,
   * and the trash that holds it.
   */
  private _itemTitle(item: ITrashItem, source?: string): string {
    const id = source ?? item.source ?? 'xdg';
    const entry = this._sources.find(known => known.id === id);
    const lines = [
      `Original: ${item.original_path}`,
      `Type: ${item.is_symlink ? 'Symbolic link' : item.is_dir ? 'Folder' : 'File'}`,
      `Size: ${item.size_formatted}`,
      `Deleted: ${this._formatDate(item.deletion_date)}`
    ];
    // The sources answer may not have arrived yet; no line beats 'undefined'
    if (entry !== undefined) {
      lines.push(`Trash: ${entry.label} on ${entry.mountpoint}`);
    }
    return lines.join('\n');
  }

  private _createItemElement(item: ITrashItem): HTMLDivElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'jp-TrashPanel-item';
    // An id derived from the row key is stable across every render, so
    // aria-activedescendant keeps naming the same row after a reload.
    itemEl.id = this._rowId(item);
    if (item.source !== undefined) {
      itemEl.dataset.source = item.source;
    }
    itemEl.setAttribute('role', 'option');
    itemEl.setAttribute('aria-selected', String(this._selectedItems.has(item)));
    if (this._selectedItems.has(item)) {
      itemEl.classList.add('jp-mod-selected');
    }
    itemEl.title = this._itemTitle(item);

    // Icon + Name column
    const nameCol = document.createElement('span');
    nameCol.className = 'jp-TrashPanel-col-name';

    const iconEl = document.createElement('span');
    iconEl.className = 'jp-TrashPanel-item-icon';
    // The folder icon marks a row that opens; a symlink is never followed
    if (item.is_dir && !item.is_symlink) {
      folderIcon.element({ container: iconEl });
    } else {
      fileIcon.element({ container: iconEl });
    }
    nameCol.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'jp-TrashPanel-item-name';
    nameEl.textContent = item.name;
    nameCol.appendChild(nameEl);

    itemEl.appendChild(nameCol);

    // Modified column
    const modifiedCol = document.createElement('span');
    modifiedCol.className = 'jp-TrashPanel-col-modified';
    modifiedCol.textContent = this._formatRelativeTime(item.deletion_date);
    modifiedCol.title = this._formatDate(item.deletion_date);
    itemEl.appendChild(modifiedCol);

    // Size column
    const sizeCol = document.createElement('span');
    sizeCol.className = 'jp-TrashPanel-col-size';
    sizeCol.textContent = item.size_formatted;
    itemEl.appendChild(sizeCol);

    // Click handler for selection
    itemEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.shiftKey) {
        e.preventDefault();
      }
    });
    itemEl.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      const index = this._sortedItems.indexOf(item);
      this._handleItemClick(item, index, e);
    });

    // Double-click opens a folder. A symlink is never followed.
    if (item.is_dir && !item.is_symlink) {
      itemEl.addEventListener('dblclick', () => this._openItem(item));
    }

    // Context menu
    itemEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();

      // If right-clicked item is not in selection, select only it
      if (!this._selectedItems.has(item)) {
        this._clearSelection();
        this._selectItem(item);
        this._lastClickedAnchor = rowKey(item);
      }
      // The row is active as after a click, so the focus the closing menu
      // returns, keyboard focus after Escape, does not activate the first row
      this._activePath = rowKey(item);
      this._renderActiveRow();

      this.node.classList.add('jp-mod-contextMenuOpen');
      this._contextMenu.open(e.clientX, e.clientY);
    });

    return itemEl;
  }

  private _rowId(item: ITrashItem): string {
    // Code units, not code points: astral characters must keep distinct ids.
    const units = rowKey(item)
      .split('')
      .map(c => c.charCodeAt(0).toString(36))
      .join('-');
    return `jp-trash-row-${units}`;
  }

  /**
   * The keyboard model of the list: arrows move the active row, Space
   * toggles its selection, Enter opens it and the menu keys show its menu.
   */
  private _handleListKeyDown(e: KeyboardEvent): void {
    const index = this._sortedItems.findIndex(
      item => rowKey(item) === this._activePath
    );
    const moved = movedIndex(e.key, index, this._sortedItems.length);
    if (moved !== null) {
      this._setActiveIndex(moved);
    } else if (index < 0) {
      return;
    } else if (e.key === ' ') {
      this._toggleSelection(this._sortedItems[index]);
    } else if (e.key === 'Enter') {
      this._openItem(this._sortedItems[index]);
    } else if (isMenuKey(e)) {
      this._openContextMenuAt(this._sortedItems[index]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private _setActiveIndex(index: number): void {
    if (this._sortedItems.length === 0) {
      return;
    }
    this._activePath = rowKey(this._sortedItems[index]);
    this._renderActiveRow();
    this._itemElements
      .get(this._sortedItems[index])
      ?.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * Repaint the active row after a render: a path the new list does not hold
   * is dropped, otherwise the row is marked active.
   */
  private _restoreActiveRow(): void {
    if (
      this._activePath !== null &&
      !this._sortedItems.some(row => rowKey(row) === this._activePath)
    ) {
      this._activePath = null;
      // The focused list fires no new focus event; apply the focus rule here
      if (this._list.matches(':focus-visible')) {
        this._setActiveIndex(0);
      }
    }
    this._renderActiveRow();
  }

  private _renderActiveRow(): void {
    for (const el of this._itemElements.values()) {
      el.classList.remove('jp-mod-active');
    }
    const item = this._sortedItems.find(
      row => rowKey(row) === this._activePath
    );
    const el = item === undefined ? undefined : this._itemElements.get(item);
    if (el === undefined) {
      this._list.removeAttribute('aria-activedescendant');
      return;
    }
    el.classList.add('jp-mod-active');
    this._list.setAttribute('aria-activedescendant', el.id);
  }

  private _toggleSelection(item: ITrashItem): void {
    if (this._selectedItems.has(item)) {
      this._deselectItem(item);
    } else {
      this._selectItem(item);
    }
    this._lastClickedAnchor = rowKey(item);
  }

  /** Enter on an active row does what a double-click does. */
  private _openItem(item: ITrashItem): void {
    if (item.is_dir && !item.is_symlink) {
      this._navigate(item.trash_path.split('/'), item.source ?? 'xdg');
    }
  }

  /** The menu keys open the row menu where the mouse would open it. */
  private _openContextMenuAt(item: ITrashItem): void {
    if (!this._selectedItems.has(item)) {
      this._clearSelection();
      this._selectItem(item);
      this._lastClickedAnchor = rowKey(item);
    }
    const el = this._itemElements.get(item);
    if (el === undefined) {
      return;
    }
    const rect = el.getBoundingClientRect();
    this.node.classList.add('jp-mod-contextMenuOpen');
    this._contextMenu.open(rect.left + 8, rect.bottom);
  }

  private _formatRelativeTime(isoDate: string): string {
    if (!isoDate) {
      return '';
    }
    try {
      const date = new Date(isoDate);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      const diffWeeks = Math.floor(diffDays / 7);
      const diffMonths = Math.floor(diffDays / 30);
      const diffYears = Math.floor(diffDays / 365);

      if (diffSecs < 60) {
        return 'just now';
      } else if (diffMins < 60) {
        return `${diffMins}m ago`;
      } else if (diffHours < 24) {
        return `${diffHours}h ago`;
      } else if (diffDays < 7) {
        return diffDays === 1 ? 'yesterday' : `${diffDays}d ago`;
      } else if (diffDays < 30) {
        return `${diffWeeks}w ago`;
      } else if (diffDays < 365) {
        return `${diffMonths}mo ago`;
      } else {
        return `${diffYears}y ago`;
      }
    } catch {
      return '';
    }
  }

  private _formatDate(isoDate: string): string {
    if (!isoDate) {
      return 'Unknown date';
    }
    try {
      const date = new Date(isoDate);
      return date.toLocaleString(navigator.language);
    } catch {
      return isoDate;
    }
  }

  /**
   * After an action changed the trash: take the rows `gone` names, by source
   * id ('xdg' for the XDG trash), out of the drawn lists and the summary at
   * once, then list the trash again in the background, the main listing
   * unless `main` is false. Each source's answer redraws its own rows;
   * answers that started before the action are dropped.
   */
  private _reloadChanged(
    gone: (source: string, item: ITrashItem) => boolean,
    main = true
  ): void {
    this._trashGen++;
    // A removed active row hands the active row to the first remaining row
    // after it, or the last one before it, so the reload neither drops it
    // nor scrolls the list to row 0
    const drawn = this._sortedItems;
    const kept = (row: ITrashItem) => !gone(row.source ?? 'xdg', row);
    const at = drawn.findIndex(row => rowKey(row) === this._activePath);
    if (at >= 0 && !kept(drawn[at])) {
      const next =
        drawn.slice(at + 1).find(kept) ??
        drawn.slice(0, at).reverse().find(kept);
      this._activePath = next === undefined ? null : rowKey(next);
    }
    const strip = (
      data: ITrashListResponse,
      source: string,
      nested = false
    ): ITrashListResponse => {
      const items = data.items.filter(item => !gone(source, item));
      if (items.length === data.items.length) {
        return data;
      }
      // The server's total is the sum of its rows' sizes
      const totalSize = items.reduce((sum, item) => sum + item.size, 0);
      // The source's count and size drop at once, until /sources answers. A
      // row inside a folder shrinks its top-level item, not the item count;
      // a listing newer than that answer can remove more than it counted.
      const count = nested ? 0 : data.items.length - items.length;
      const bytes = data.items.reduce((sum, item) => sum + item.size, 0);
      this._sources = this._sources.map(entry => {
        if (entry.id !== source) {
          return entry;
        }
        const left = Math.max(0, entry.total_bytes - bytes + totalSize);
        return {
          ...entry,
          item_count: Math.max(0, entry.item_count - count),
          total_size: formatSize(left),
          total_bytes: left
        };
      });
      return {
        items,
        item_count: items.length,
        total_size: totalSize,
        total_size_formatted: formatSize(totalSize)
      };
    };
    this._mainList = strip(
      this._mainList,
      this._pathSource,
      this._path.length > 0
    );
    for (const [id, listing] of this._sectionListings) {
      if (!(listing instanceof Error)) {
        this._sectionListings.set(id, strip(listing, id));
      }
    }
    this._renderSections();
    this._renderMain();
    if (!main) {
      void this._loadSources();
      return;
    }
    this._loadTrashContents().catch(error =>
      console.error('Failed to load trash:', error)
    );
  }

  /** Reload after an empty; the sources in `emptied` hold nothing now. */
  private _dropSources(emptied: Set<string>): void {
    this._sources = this._sources.map(source =>
      emptied.has(source.id)
        ? {
            ...source,
            item_count: 0,
            total_size: formatSize(0),
            total_bytes: 0
          }
        : source
    );
    this._reloadChanged(source => emptied.has(source));
  }

  private async _restoreItems(items: ITrashItem[]): Promise<void> {
    this._setLoading(true);
    const errors: string[] = [];
    const done = new Set<string>();
    try {
      for (const item of items) {
        try {
          await requestAPI<{ success: boolean; restored_to: string }>(
            'restore',
            this._serverSettings,
            {
              method: 'POST',
              // An XDG row has no source, so its body is the path alone
              body: JSON.stringify({
                trash_path: item.trash_path,
                source: item.source
              })
            }
          );
          done.add(`${item.source ?? 'xdg'}\0${item.trash_path}`);
        } catch (error: any) {
          errors.push(`${item.name}: ${error?.message || 'unknown error'}`);
        }
      }
      if (errors.length > 0) {
        showErrorMessage('Restore Failed', errors.join('\n'));
      }
      this._reloadChanged((source, row) =>
        done.has(`${source}\0${row.trash_path}`)
      );
    } finally {
      this._setLoading(false);
    }
  }

  private async _deleteItems(items: ITrashItem[]): Promise<void> {
    const count = items.length;
    const body =
      count === 1
        ? `Are you sure you want to permanently delete "${items[0].name}"? This cannot be undone.`
        : `Are you sure you want to permanently delete ${count} items? This cannot be undone.`;

    const result = await showDialog({
      title: trans.__('Delete Permanently'),
      body,
      buttons: [
        Dialog.cancelButton(),
        Dialog.warnButton({ label: trans.__('Delete') })
      ]
    });

    if (result.button.accept) {
      this._setLoading(true);
      const errors: string[] = [];
      const done = new Set<string>();
      try {
        for (const item of items) {
          try {
            await requestAPI<{ success: boolean }>(
              'delete',
              this._serverSettings,
              {
                method: 'POST',
                body: JSON.stringify({
                  trash_path: item.trash_path,
                  source: item.source
                })
              }
            );
            done.add(`${item.source ?? 'xdg'}\0${item.trash_path}`);
          } catch (error: any) {
            errors.push(`${item.name}: ${error?.message || 'unknown error'}`);
          }
        }
        if (errors.length > 0) {
          showErrorMessage('Delete Failed', errors.join('\n'));
        }
        this._reloadChanged((source, row) =>
          done.has(`${source}\0${row.trash_path}`)
        );
      } finally {
        this._setLoading(false);
      }
    }
  }

  /**
   * Empty every source, or only the entries under the workspace root. The
   * confirmation names the scope and every source's count and size, and the
   * request is sent only after it is accepted.
   */
  private async _cleanSources(scope: 'all' | 'workspace'): Promise<void> {
    const sources = await this._sourcesForDialog();
    const root = PageConfig.getOption('serverRoot');
    const title =
      scope === 'all'
        ? trans.__('Empty All Bins')
        : trans.__('Clean Workspace');
    const warning =
      scope === 'all'
        ? trans.__(
            'Every item in every trash source will be permanently deleted. This cannot be undone.'
          )
        : trans.__(
            'Only entries under %1 are removed, from every trash source. Every other entry stays.',
            root
          );
    const result = await showDialog({
      title,
      body: [
        warning,
        '',
        ...sources.map(source => this._sourceSummary(source))
      ].join('\n'),
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: title })]
    });
    if (!result.button.accept) {
      return;
    }

    this._setLoading(true);
    let response: ICleanResponse;
    try {
      response = await requestAPI<ICleanResponse>(
        'empty',
        this._serverSettings,
        { method: 'POST', body: JSON.stringify({ scope }) }
      );
    } catch (error: any) {
      showErrorMessage(
        trans.__('%1 Failed', title),
        error?.message || trans.__('Failed to clean the trash')
      );
      return;
    } finally {
      this._setLoading(false);
    }
    // The server enumerates again: a confirmed source it omits has vanished
    const confirmed = sources.filter(source => source.item_count > 0);
    const answered = new Set((response.sources ?? []).map(entry => entry.id));
    const missing = confirmed.filter(source => !answered.has(source.id));
    if (missing.length > 0) {
      response.sources = [
        ...(response.sources ?? []),
        ...missing.map(source => ({
          id: source.id,
          label: source.label,
          deleted_count: 0,
          errors: [trans.__('the source is no longer available')]
        }))
      ];
    }
    const clean = new Set(
      (response.sources ?? [])
        .filter(entry => entry.errors.length === 0)
        .map(entry => entry.id)
    );
    if (scope === 'all') {
      this._dropSources(clean);
    } else {
      this._reloadChanged(
        (source, item) => clean.has(source) && isUnder(item.original_path, root)
      );
    }
    await this._reportClean(response, scope);
  }

  /**
   * Empty one source after a confirmation naming it with its count and size,
   * then reload the listing and the sources.
   */
  private async _emptySource(id: string): Promise<void> {
    const source = this._sources.find(item => item.id === id);
    if (source === undefined) {
      return;
    }
    const title = trans.__('Empty Trash in %1', source.label);
    const result = await showDialog({
      title,
      body: [
        trans.__(
          'Every item in this trash source will be permanently deleted. This cannot be undone.'
        ),
        '',
        this._sourceSummary(source)
      ].join('\n'),
      buttons: [
        Dialog.cancelButton(),
        Dialog.warnButton({ label: trans.__('Empty') })
      ]
    });
    if (!result.button.accept) {
      return;
    }

    this._setLoading(true);
    try {
      const response = await requestAPI<ICleanResponse>(
        'empty',
        this._serverSettings,
        {
          method: 'POST',
          body: JSON.stringify({ scope: 'source', source: id })
        }
      );
      this._dropSources(new Set(response.success ? [id] : []));
      if (!response.success) {
        showErrorMessage(
          trans.__('%1 Failed', title),
          (response.errors ?? []).join('\n')
        );
      }
    } catch (error: any) {
      showErrorMessage(
        trans.__('%1 Failed', title),
        error?.message || trans.__('Failed to clean the trash')
      );
    } finally {
      this._setLoading(false);
    }
  }

  /** The sources for the confirmation dialog, as fresh as the server allows. */
  private async _sourcesForDialog(): Promise<ITrashSource[]> {
    try {
      return await requestAPI<ITrashSource[]>('sources', this._serverSettings);
    } catch {
      return this._sources;
    }
  }

  /** Report what each source deleted and how many entries the run left. */
  private async _reportClean(
    result: ICleanResponse,
    scope: 'all' | 'workspace'
  ): Promise<void> {
    const entries = result.sources ?? [];
    const lines = entries.map(entry => {
      const noun =
        entry.deleted_count === 1 ? trans.__('item') : trans.__('items');
      return trans.__(
        '%1: %2 %3 deleted',
        entry.label,
        entry.deleted_count,
        noun
      );
    });
    if (result.left_count !== undefined) {
      const noun =
        result.left_count === 1 ? trans.__('item') : trans.__('items');
      lines.push(trans.__('%1 %2 left', result.left_count, noun));
    }
    const errors: string[] = [];
    for (const entry of entries) {
      for (const message of entry.errors) {
        errors.push(trans.__('%1: %2', entry.label, message));
      }
    }
    const title =
      scope === 'all'
        ? trans.__('Empty All Bins')
        : trans.__('Clean Workspace');
    if (errors.length > 0) {
      showErrorMessage(
        trans.__('%1 Failed', title),
        [...lines, ...errors].join('\n')
      );
      return;
    }
    // The 140-character notification cap and unbounded sources mean totals
    // only; the confirmation lists each source with its count and size.
    const deletedNoun =
      result.deleted_count === 1 ? trans.__('item') : trans.__('items');
    let message = trans.__('%1 %2 deleted', result.deleted_count, deletedNoun);
    if (result.left_count !== undefined) {
      const leftNoun =
        result.left_count === 1 ? trans.__('item') : trans.__('items');
      message = trans.__(
        '%1; %2 %3 left',
        message,
        result.left_count,
        leftNoun
      );
    }
    Notification.emit(message, 'success', { autoClose: 3000 });
  }

  /**
   * Start auto-refresh interval.
   */
  private _startAutoRefresh(): void {
    this._stopAutoRefresh();
    this._refreshIntervalId = setInterval(() => {
      this._refreshInBackground();
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Stop auto-refresh interval.
   */
  private _stopAutoRefresh(): void {
    if (this._refreshIntervalId !== null) {
      clearInterval(this._refreshIntervalId);
      this._refreshIntervalId = null;
    }
  }

  /**
   * Handle `after-show` messages - refresh and start auto-refresh.
   */
  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this.refresh();
    this._startAutoRefresh();
  }

  /**
   * Handle `before-hide` messages - stop auto-refresh.
   */
  protected onBeforeHide(msg: Message): void {
    this._stopAutoRefresh();
    super.onBeforeHide(msg);
  }

  /**
   * Handle `resize` messages - end a gesture at rest and repaint the open
   * section, so the new geometry applies before the next wheel.
   */
  protected onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg);
    this._abortHarmonica();
    const openId = this._openId();
    const source = this._sources.find(item => item.id === openId);
    const parts = openId === null ? undefined : this._sectionParts.get(openId);
    if (source !== undefined && parts !== undefined) {
      this._paintSection(source, parts);
    }
    this._updateShort();
  }

  /**
   * Dispose of the widget and clean up resources.
   */
  dispose(): void {
    this._stopAutoRefresh();
    this._stopSpring();
    this.node.removeEventListener('wheel', this._onWheel);
    if (this._warmMarkTimer !== null) {
      clearTimeout(this._warmMarkTimer);
      this._warmMarkTimer = null;
    }
    super.dispose();
  }
}
