import { Widget } from '@lumino/widgets';
import { showDialog, Dialog, showErrorMessage } from '@jupyterlab/apputils';
import { Menu } from '@lumino/widgets';
import { CommandRegistry } from '@lumino/commands';
import { Message } from '@lumino/messaging';
import { ServerConnection } from '@jupyterlab/services';
import { requestAPI } from './request';
import { trashIcon, folderIcon, fileIcon, refreshIcon } from './icon';

// Auto-refresh interval: 1/6 minute = 10 seconds
const REFRESH_INTERVAL_MS = 10000;

interface ITrashItem {
  name: string;
  trash_path: string;
  original_path: string;
  deletion_date: string;
  size: number;
  size_formatted: string;
  is_dir: boolean;
  is_symlink: boolean;
}

interface ITrashListResponse {
  items: ITrashItem[];
  total_size: number;
  total_size_formatted: string;
  item_count: number;
}

type SortColumn = 'name' | 'modified' | 'size';
type SortDirection = 'asc' | 'desc';

export class TrashWidget extends Widget {
  private _header: HTMLDivElement;
  private _summary: HTMLDivElement;
  private _summaryText: HTMLSpanElement;
  private _breadcrumb: HTMLDivElement;
  private _columnHeader: HTMLDivElement;
  private _list: HTMLDivElement;
  private _emptyMessage: HTMLDivElement;
  private _loadingVeil: HTMLDivElement;
  private _emptyBtn: HTMLButtonElement;
  private _refreshBtn: HTMLButtonElement;
  private _commands: CommandRegistry;
  private _contextMenu: Menu;
  // True while the menu opened from the keyboard is showing
  private _menuOpenedByKeyboard = false;
  private _selectedItems: Set<ITrashItem> = new Set();
  // The row a shift-click ranges from, held by path because sorting moves rows
  private _lastClickedAnchor: string | null = null;
  // The row arrow navigation treats as current, held by path because sorting
  // and every reload rebuild the rows
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
  // False until the first list has arrived
  private _loaded = false;
  // List requests in flight, and the sequence number of the newest one
  private _pendingLoads = 0;
  private _loadSeq = 0;
  // Refreshes that currently keep the refresh icon turning
  private _spinCount = 0;

  constructor(serverSettings: ServerConnection.ISettings) {
    super();
    this._serverSettings = serverSettings;
    this.id = 'jp-trash-panel';
    this.title.icon = trashIcon;
    this.title.caption = 'Trash';
    this.addClass('jp-TrashPanel');

    // Set up commands for context menu
    this._commands = new CommandRegistry();
    this._setupCommands();
    this._contextMenu = new Menu({ commands: this._commands });
    this._contextMenu.addItem({ command: 'trash:restore' });
    this._contextMenu.addItem({ command: 'trash:delete' });

    // Clear visual state when menu closes (keep selection) and give the
    // keyboard focus the menu took back to the list it was opened from
    this._contextMenu.aboutToClose.connect(() => {
      this.node.classList.remove('jp-mod-contextMenuOpen');
      if (!this._menuOpenedByKeyboard) {
        return;
      }
      this._menuOpenedByKeyboard = false;
      this._focusListOrRefresh();
    });

    // Create header: title on the left, action icons on the right. It is
    // built once, so the refresh button keeps its spinning state across loads.
    this._header = document.createElement('div');
    this._header.className = 'jp-TrashPanel-header';

    const title = document.createElement('span');
    title.className = 'jp-TrashPanel-title';
    title.textContent = 'Trash Management';
    this._header.appendChild(title);

    this._emptyBtn = document.createElement('button');
    this._emptyBtn.className =
      'jp-TrashPanel-header-button jp-TrashPanel-header-button-danger';
    this._emptyBtn.title = 'Empty Trash';
    this._emptyBtn.hidden = true;
    trashIcon.element({ container: this._emptyBtn });
    this._emptyBtn.addEventListener('click', () => this._emptyTrash());
    this._header.appendChild(this._emptyBtn);

    // Refresh is appended last, so it is the rightmost icon
    this._refreshBtn = document.createElement('button');
    this._refreshBtn.className = 'jp-TrashPanel-header-button';
    this._refreshBtn.title = 'Refresh';
    refreshIcon.element({ container: this._refreshBtn });
    this._refreshBtn.addEventListener('click', () => this.refresh());
    this._header.appendChild(this._refreshBtn);

    this.node.appendChild(this._header);

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

    // Create list container. It is the single tab stop of the keyboard model:
    // rows are options exposed through aria-activedescendant, never tabindex.
    this._list = document.createElement('div');
    this._list.className = 'jp-TrashPanel-list';
    this._list.tabIndex = 0;
    this._list.setAttribute('role', 'listbox');
    this._list.setAttribute('aria-multiselectable', 'true');
    this._list.setAttribute('aria-label', 'Trash items');
    this._list.addEventListener('keydown', (e: KeyboardEvent) =>
      this._handleListKeyDown(e)
    );
    this.node.appendChild(this._list);

    // Create empty message
    this._emptyMessage = document.createElement('div');
    this._emptyMessage.className = 'jp-TrashPanel-empty';
    this._emptyMessage.textContent = 'Trash is empty';
    this._emptyMessage.style.display = 'none';
    this.node.appendChild(this._emptyMessage);

    // Create loading veil - visible by default, until the first load ends
    this._loadingVeil = document.createElement('div');
    this._loadingVeil.className = 'jp-TrashPanel-loading';
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
  }

  /**
   * Reload the panel on a user action. Lists the folder in view unless
   * another location is given.
   */
  async refresh(path: string[] = this._path): Promise<void> {
    // The veil covers the whole panel, header included, so it is raised only
    // while there is no list to show yet; a later refresh turns the icon alone.
    const cold = !this._loaded;
    if (cold) {
      this._setLoading(true);
    }
    this._setRefreshSpinning(true);
    const minSpin = new Promise<void>(resolve =>
      window.setTimeout(resolve, 500)
    );
    try {
      await Promise.all([this._loadTrashContents(path), minSpin]);
    } catch (error) {
      console.error('Failed to load trash:', error);
      showErrorMessage('Trash Error', 'Failed to load trash contents');
    } finally {
      this._setRefreshSpinning(false);
      if (cold) {
        this._setLoading(false);
      }
    }
  }

  private _setRefreshSpinning(on: boolean): void {
    this._spinCount += on ? 1 : -1;
    this._refreshBtn.classList.toggle('jp-mod-spinning', this._spinCount > 0);
  }

  private _setLoading(on: boolean): void {
    this._loadingVeil.hidden = !on;
  }

  /**
   * Background refresh without veil or icon spin - used for auto-refresh.
   */
  private async _refreshInBackground(): Promise<void> {
    // A load in flight already carries the newest location; do not race it
    if (this._pendingLoads > 0) {
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
   * `path` is shortened to that parent.
   */
  private async _fetchList(path: string[]): Promise<ITrashListResponse> {
    const endPoint =
      path.length > 0
        ? `list?path=${encodeURIComponent(path.join('/'))}`
        : 'list';
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
      return this._fetchList(path);
    }
  }

  /**
   * Load a location from the API and render it. Defaults to the folder in
   * view.
   */
  private async _loadTrashContents(path: string[] = this._path): Promise<void> {
    const seq = ++this._loadSeq;
    const target = [...path];
    let data: ITrashListResponse;
    this._pendingLoads++;
    try {
      data = await this._fetchList(target);
    } finally {
      this._pendingLoads--;
    }
    // A newer load has started since; its result is the one to show
    if (seq !== this._loadSeq) {
      return;
    }

    // The selection and the shift-click anchor are kept by trash path while
    // the location stays the same; a move to another folder clears both.
    const sameLocation = target.join('/') === this._path.join('/');
    const selected = new Set(
      sameLocation ? [...this._selectedItems].map(item => item.trash_path) : []
    );
    const anchor = sameLocation ? this._lastClickedAnchor : null;

    this._path = target;
    this._loaded = true;
    this._items = data.items;
    this._selectedItems = new Set(
      this._items.filter(item => selected.has(item.trash_path))
    );
    this._renderSummary(data);
    const hadCrumbFocus = this._renderBreadcrumb();
    this._renderColumnHeader();
    this._renderItems();
    // A crumb that is gone or no longer focusable still held the focus; the
    // new location takes it, so the keyboard continues from its list.
    if (hadCrumbFocus) {
      this._focusListOrRefresh();
    }
    this._lastClickedAnchor =
      anchor !== null && this._items.some(item => item.trash_path === anchor)
        ? anchor
        : null;
  }

  private _renderSummary(data: ITrashListResponse): void {
    const count = data.item_count;
    const noun = count === 1 ? 'item' : 'items';
    this._summaryText.textContent = `${count} ${noun} \u00B7 ${data.total_size_formatted}`;
    // Inside a folder the trash holds at least that folder
    this._emptyBtn.hidden = this._path.length === 0 && count === 0;
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
    if (restore instanceof HTMLButtonElement && !this._breadcrumb.hidden) {
      restore.focus();
      return false;
    }
    return focused >= 0;
  }

  /** Focus the list, or the refresh button when the list is hidden. */
  private _focusListOrRefresh(): void {
    const target =
      this._list.style.display === 'none' ? this._refreshBtn : this._list;
    target.focus();
  }

  /**
   * Show another location: a folder inside the trash, or the top level for
   * an empty path.
   */
  private _navigate(path: string[]): void {
    void this.refresh(path);
  }

  private _renderColumnHeader(): void {
    this._columnHeader.innerHTML = '';

    const createHeader = (
      label: string,
      column: SortColumn,
      className: string
    ) => {
      const header = document.createElement('span');
      header.className = `${className} jp-TrashPanel-sortable`;
      header.textContent = label;

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
      // claims an order the list does not have; trash_path breaks it.
      return order !== 0 ? order : a.trash_path.localeCompare(b.trash_path);
    });

    return items;
  }

  private _renderItems(): void {
    this._list.innerHTML = '';
    this._itemElements.clear();

    if (this._items.length === 0) {
      this._emptyMessage.textContent =
        this._path.length > 0 ? 'Folder is empty' : 'Trash is empty';
      this._emptyMessage.style.display = 'flex';
      this._columnHeader.style.display = 'none';
      // A hidden element cannot hold the focus; hand it to the header
      if (document.activeElement === this._list) {
        this._refreshBtn.focus();
      }
      this._list.style.display = 'none';
      this._sortedItems = [];
      this._restoreActiveRow();
      return;
    }

    this._emptyMessage.style.display = 'none';
    this._columnHeader.style.display = 'flex';
    this._list.style.display = 'block';

    this._sortedItems = this._getSortedItems();
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
    this._activePath = item.trash_path;
    this._renderActiveRow();
    // Resolve the anchor by path: a sort change reorders the rows between clicks
    const anchorIndex =
      this._lastClickedAnchor === null
        ? -1
        : this._sortedItems.findIndex(
            row => row.trash_path === this._lastClickedAnchor
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
      this._lastClickedAnchor = item.trash_path;
    } else {
      // Normal click: select only this item
      this._clearSelection();
      this._selectItem(item);
      this._lastClickedAnchor = item.trash_path;
    }
  }

  private _createItemElement(item: ITrashItem): HTMLDivElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'jp-TrashPanel-item';
    // An id derived from the path is stable across every render, so
    // aria-activedescendant keeps naming the same row after a reload.
    itemEl.id = this._rowId(item);
    itemEl.setAttribute('role', 'option');
    itemEl.setAttribute('aria-selected', String(this._selectedItems.has(item)));
    if (this._selectedItems.has(item)) {
      itemEl.classList.add('jp-mod-selected');
    }
    itemEl.title = [
      `Original: ${item.original_path}`,
      `Type: ${item.is_symlink ? 'Symbolic link' : item.is_dir ? 'Folder' : 'File'}`,
      `Size: ${item.size_formatted}`,
      `Deleted: ${this._formatDate(item.deletion_date)}`
    ].join('\n');

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
      itemEl.addEventListener('dblclick', () =>
        this._navigate(item.trash_path.split('/'))
      );
    }

    // Context menu
    itemEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();

      // If right-clicked item is not in selection, select only it
      if (!this._selectedItems.has(item)) {
        this._clearSelection();
        this._selectItem(item);
        this._lastClickedAnchor = item.trash_path;
      }

      this.node.classList.add('jp-mod-contextMenuOpen');
      this._menuOpenedByKeyboard = false;
      this._contextMenu.open(e.clientX, e.clientY);
    });

    return itemEl;
  }

  private _rowId(item: ITrashItem): string {
    // Code units, not code points: astral characters must keep distinct ids.
    const units = item.trash_path
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
      item => item.trash_path === this._activePath
    );
    switch (e.key) {
      case 'ArrowDown':
        this._setActiveIndex(index < 0 ? 0 : index + 1);
        break;
      case 'ArrowUp':
        this._setActiveIndex(
          index < 0 ? this._sortedItems.length - 1 : index - 1
        );
        break;
      case 'Home':
        this._setActiveIndex(0);
        break;
      case 'End':
        this._setActiveIndex(this._sortedItems.length - 1);
        break;
      case ' ':
        if (index < 0) {
          return;
        }
        this._toggleSelection(this._sortedItems[index]);
        break;
      case 'Enter':
        if (index < 0) {
          return;
        }
        this._openItem(this._sortedItems[index]);
        break;
      case 'F10':
        if (!e.shiftKey || index < 0) {
          return;
        }
        this._openContextMenuAt(this._sortedItems[index]);
        break;
      case 'ContextMenu':
        if (index < 0) {
          return;
        }
        this._openContextMenuAt(this._sortedItems[index]);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private _setActiveIndex(index: number): void {
    if (this._sortedItems.length === 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(index, this._sortedItems.length - 1));
    this._activePath = this._sortedItems[clamped].trash_path;
    this._renderActiveRow();
    this._itemElements
      .get(this._sortedItems[clamped])
      ?.scrollIntoView?.({ block: 'nearest' });
  }

  /**
   * Repaint the active row after a render: a path the new list does not hold
   * is dropped, otherwise the row is marked active.
   */
  private _restoreActiveRow(): void {
    if (
      this._activePath !== null &&
      !this._sortedItems.some(row => row.trash_path === this._activePath)
    ) {
      this._activePath = null;
    }
    this._renderActiveRow();
  }

  private _renderActiveRow(): void {
    for (const el of this._itemElements.values()) {
      el.classList.remove('jp-mod-active');
    }
    const item = this._sortedItems.find(
      row => row.trash_path === this._activePath
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
    this._lastClickedAnchor = item.trash_path;
  }

  /** Enter on an active row does what a double-click does. */
  private _openItem(item: ITrashItem): void {
    if (item.is_dir && !item.is_symlink) {
      this._navigate(item.trash_path.split('/'));
    }
  }

  /** The menu keys open the row menu where the mouse would open it. */
  private _openContextMenuAt(item: ITrashItem): void {
    if (!this._selectedItems.has(item)) {
      this._clearSelection();
      this._selectItem(item);
      this._lastClickedAnchor = item.trash_path;
    }
    const el = this._itemElements.get(item);
    if (el === undefined) {
      return;
    }
    const rect = el.getBoundingClientRect();
    this.node.classList.add('jp-mod-contextMenuOpen');
    this._menuOpenedByKeyboard = true;
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
      return date.toLocaleString();
    } catch {
      return isoDate;
    }
  }

  private async _restoreItems(items: ITrashItem[]): Promise<void> {
    this._setLoading(true);
    const errors: string[] = [];
    try {
      for (const item of items) {
        try {
          await requestAPI<{ success: boolean; restored_to: string }>(
            'restore',
            this._serverSettings,
            {
              method: 'POST',
              body: JSON.stringify({ trash_path: item.trash_path })
            }
          );
        } catch (error: any) {
          errors.push(`${item.name}: ${error?.message || 'unknown error'}`);
        }
      }
      if (errors.length > 0) {
        showErrorMessage('Restore Failed', errors.join('\n'));
      }
      await this._loadTrashContents();
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
      title: 'Delete Permanently',
      body,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Delete' })]
    });

    if (result.button.accept) {
      this._setLoading(true);
      const errors: string[] = [];
      try {
        for (const item of items) {
          try {
            await requestAPI<{ success: boolean }>(
              'delete',
              this._serverSettings,
              {
                method: 'POST',
                body: JSON.stringify({ trash_path: item.trash_path })
              }
            );
          } catch (error: any) {
            errors.push(`${item.name}: ${error?.message || 'unknown error'}`);
          }
        }
        if (errors.length > 0) {
          showErrorMessage('Delete Failed', errors.join('\n'));
        }
        await this._loadTrashContents();
      } finally {
        this._setLoading(false);
      }
    }
  }

  private async _emptyTrash(): Promise<void> {
    const result = await showDialog({
      title: 'Empty Trash',
      body: 'Are you sure you want to permanently delete all items in the trash? This cannot be undone.',
      buttons: [
        Dialog.cancelButton(),
        Dialog.warnButton({ label: 'Empty Trash' })
      ]
    });

    if (result.button.accept) {
      this._setLoading(true);
      try {
        const result = await requestAPI<{
          success: boolean;
          deleted_count: number;
          errors?: string[];
        }>('empty', this._serverSettings, { method: 'POST' });
        await this._loadTrashContents();
        if (!result.success) {
          showErrorMessage(
            'Empty Trash Failed',
            (result.errors ?? []).join('\n')
          );
        }
      } catch (error: any) {
        const message = error?.message || 'Failed to empty trash';
        showErrorMessage('Empty Trash Failed', message);
      } finally {
        this._setLoading(false);
      }
    }
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
   * Dispose of the widget and clean up resources.
   */
  dispose(): void {
    this._stopAutoRefresh();
    super.dispose();
  }
}
