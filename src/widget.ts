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
  private _breadcrumb: HTMLDivElement;
  private _columnHeader: HTMLDivElement;
  private _list: HTMLDivElement;
  private _emptyMessage: HTMLDivElement;
  private _loadingVeil: HTMLDivElement;
  private _emptyBtn: HTMLButtonElement;
  private _refreshBtn: HTMLButtonElement;
  private _commands: CommandRegistry;
  private _contextMenu: Menu;
  private _selectedItems: Set<ITrashItem> = new Set();
  private _lastClickedIndex: number = -1;
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

    // Clear visual state when menu closes (keep selection)
    this._contextMenu.aboutToClose.connect(() => {
      this.node.classList.remove('jp-mod-contextMenuOpen');
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

    // Create summary bar: item count and total size of the listed location
    this._summary = document.createElement('div');
    this._summary.className = 'jp-TrashPanel-summary';
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

    // Create list container
    this._list = document.createElement('div');
    this._list.className = 'jp-TrashPanel-list';
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
    const anchor = sameLocation
      ? this._sortedItems[this._lastClickedIndex]?.trash_path
      : undefined;

    this._path = target;
    this._loaded = true;
    this._items = data.items;
    this._selectedItems = new Set(
      this._items.filter(item => selected.has(item.trash_path))
    );
    this._renderSummary(data);
    this._renderBreadcrumb();
    this._renderColumnHeader();
    this._renderItems();
    this._lastClickedIndex = this._sortedItems.findIndex(
      item => item.trash_path === anchor
    );
  }

  private _renderSummary(data: ITrashListResponse): void {
    const count = data.item_count;
    const noun = count === 1 ? 'item' : 'items';
    this._summary.textContent = `${count} ${noun} \u00B7 ${data.total_size_formatted}`;
    // Inside a folder the trash holds at least that folder
    this._emptyBtn.hidden = this._path.length === 0 && count === 0;
  }

  private _renderBreadcrumb(): void {
    this._breadcrumb.innerHTML = '';
    this._breadcrumb.hidden = this._path.length === 0;

    const labels = ['Trash', ...this._path];
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
    });
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
      switch (this._sortColumn) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'modified':
          return dir * a.deletion_date.localeCompare(b.deletion_date);
        case 'size':
          return dir * (a.size - b.size);
        default:
          return 0;
      }
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
      this._list.style.display = 'none';
      this._sortedItems = [];
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
  }

  private _clearSelection(): void {
    for (const item of this._selectedItems) {
      const el = this._itemElements.get(item);
      if (el) {
        el.classList.remove('jp-mod-selected');
      }
    }
    this._selectedItems.clear();
  }

  private _selectItem(item: ITrashItem): void {
    this._selectedItems.add(item);
    const el = this._itemElements.get(item);
    if (el) {
      el.classList.add('jp-mod-selected');
    }
  }

  private _deselectItem(item: ITrashItem): void {
    this._selectedItems.delete(item);
    const el = this._itemElements.get(item);
    if (el) {
      el.classList.remove('jp-mod-selected');
    }
  }

  private _handleItemClick(item: ITrashItem, index: number, e: MouseEvent) {
    if (e.shiftKey && this._lastClickedIndex >= 0) {
      // Shift+click: range select from last clicked to current
      const start = Math.min(this._lastClickedIndex, index);
      const end = Math.max(this._lastClickedIndex, index);

      if (!e.ctrlKey && !e.metaKey) {
        this._clearSelection();
      }

      for (let i = start; i <= end; i++) {
        this._selectItem(this._sortedItems[i]);
      }
      // Don't update _lastClickedIndex on shift+click to allow extending range
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle individual item
      if (this._selectedItems.has(item)) {
        this._deselectItem(item);
      } else {
        this._selectItem(item);
      }
      this._lastClickedIndex = index;
    } else {
      // Normal click: select only this item
      this._clearSelection();
      this._selectItem(item);
      this._lastClickedIndex = index;
    }
  }

  private _createItemElement(item: ITrashItem): HTMLDivElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'jp-TrashPanel-item';
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
        this._lastClickedIndex = this._sortedItems.indexOf(item);
      }

      this.node.classList.add('jp-mod-contextMenuOpen');
      this._contextMenu.open(e.clientX, e.clientY);
    });

    return itemEl;
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
