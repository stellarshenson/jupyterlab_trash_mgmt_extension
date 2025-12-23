import { Widget } from '@lumino/widgets';
import { showDialog, Dialog, showErrorMessage } from '@jupyterlab/apputils';
import { Menu } from '@lumino/widgets';
import { CommandRegistry } from '@lumino/commands';
import { Message } from '@lumino/messaging';
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
  private _columnHeader: HTMLDivElement;
  private _list: HTMLDivElement;
  private _emptyMessage: HTMLDivElement;
  private _commands: CommandRegistry;
  private _contextMenu: Menu;
  private _selectedItem: ITrashItem | null = null;
  private _selectedElement: HTMLElement | null = null;
  private _items: ITrashItem[] = [];
  private _sortColumn: SortColumn = 'modified';
  private _sortDirection: SortDirection = 'desc';
  private _refreshIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
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

    // Clear selection when menu closes
    this._contextMenu.aboutToClose.connect(() => {
      this.node.classList.remove('jp-mod-contextMenuOpen');
      if (this._selectedElement) {
        this._selectedElement.classList.remove('jp-mod-selected');
        this._selectedElement = null;
      }
    });

    // Create header
    this._header = document.createElement('div');
    this._header.className = 'jp-TrashPanel-header';
    this.node.appendChild(this._header);

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

    // Note: Initial load is handled in onAfterShow() when panel becomes visible
  }

  private _setupCommands(): void {
    this._commands.addCommand('trash:restore', {
      label: 'Restore',
      execute: () => {
        if (this._selectedItem) {
          this._restoreItem(this._selectedItem);
        }
      }
    });

    this._commands.addCommand('trash:delete', {
      label: 'Delete Permanently',
      execute: () => {
        if (this._selectedItem) {
          this._deleteItem(this._selectedItem);
        }
      }
    });
  }

  async refresh(): Promise<void> {
    try {
      const data = await requestAPI<ITrashListResponse>('list');
      this._items = data.items;
      this._renderHeader(data);
      this._renderColumnHeader();
      this._renderItems();
    } catch (error) {
      console.error('Failed to load trash:', error);
      showErrorMessage('Trash Error', 'Failed to load trash contents');
    }
  }

  private _renderHeader(data: ITrashListResponse): void {
    this._header.innerHTML = '';

    // Size info - compact single line
    const sizeInfo = document.createElement('span');
    sizeInfo.className = 'jp-TrashPanel-header-info';
    sizeInfo.textContent = `${data.item_count} items (${data.total_size_formatted})`;
    this._header.appendChild(sizeInfo);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'jp-TrashPanel-header-actions';

    // Refresh button
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'jp-TrashPanel-header-button';
    refreshBtn.title = 'Refresh';
    refreshIcon.element({ container: refreshBtn });
    refreshBtn.addEventListener('click', () => this.refresh());
    actions.appendChild(refreshBtn);

    // Empty trash button
    if (data.item_count > 0) {
      const emptyBtn = document.createElement('button');
      emptyBtn.className =
        'jp-TrashPanel-header-button jp-TrashPanel-header-button-danger';
      emptyBtn.title = 'Empty Trash';
      trashIcon.element({ container: emptyBtn });
      emptyBtn.addEventListener('click', () => this._emptyTrash());
      actions.appendChild(emptyBtn);
    }

    this._header.appendChild(actions);
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
      createHeader('Modified', 'modified', 'jp-TrashPanel-col-modified')
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

    if (this._items.length === 0) {
      this._emptyMessage.style.display = 'flex';
      this._columnHeader.style.display = 'none';
      this._list.style.display = 'none';
      return;
    }

    this._emptyMessage.style.display = 'none';
    this._columnHeader.style.display = 'flex';
    this._list.style.display = 'block';

    const sortedItems = this._getSortedItems();
    for (const item of sortedItems) {
      const itemEl = this._createItemElement(item);
      this._list.appendChild(itemEl);
    }
  }

  private _createItemElement(item: ITrashItem): HTMLDivElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'jp-TrashPanel-item';
    itemEl.title = [
      `Original: ${item.original_path}`,
      `Type: ${item.is_dir ? 'Folder' : 'File'}`,
      `Size: ${item.size_formatted}`,
      `Deleted: ${this._formatDate(item.deletion_date)}`
    ].join('\n');

    // Icon + Name column
    const nameCol = document.createElement('span');
    nameCol.className = 'jp-TrashPanel-col-name';

    const iconEl = document.createElement('span');
    iconEl.className = 'jp-TrashPanel-item-icon';
    if (item.is_dir) {
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

    // Context menu
    itemEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();

      // Clear previous selection
      if (this._selectedElement) {
        this._selectedElement.classList.remove('jp-mod-selected');
      }

      // Set new selection
      this._selectedItem = item;
      this._selectedElement = itemEl;
      itemEl.classList.add('jp-mod-selected');
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
        return diffMins === 1 ? '1 minute ago' : `${diffMins} minutes ago`;
      } else if (diffHours < 24) {
        return diffHours === 1 ? '1 hour ago' : `${diffHours} hours ago`;
      } else if (diffDays < 7) {
        return diffDays === 1 ? 'yesterday' : `${diffDays} days ago`;
      } else if (diffWeeks < 4) {
        return diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`;
      } else if (diffMonths < 12) {
        return diffMonths === 1 ? '1 month ago' : `${diffMonths} months ago`;
      } else {
        return diffYears === 1 ? '1 year ago' : `${diffYears} years ago`;
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

  private async _restoreItem(item: ITrashItem): Promise<void> {
    try {
      await requestAPI<{ success: boolean; restored_to: string }>('restore', {
        method: 'POST',
        body: JSON.stringify({ trash_path: item.trash_path })
      });
      await this.refresh();
    } catch (error: any) {
      const message = error?.message || 'Failed to restore item';
      showErrorMessage('Restore Failed', message);
    }
  }

  private async _deleteItem(item: ITrashItem): Promise<void> {
    const result = await showDialog({
      title: 'Delete Permanently',
      body: `Are you sure you want to permanently delete "${item.name}"? This cannot be undone.`,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Delete' })]
    });

    if (result.button.accept) {
      try {
        await requestAPI<{ success: boolean }>('delete', {
          method: 'POST',
          body: JSON.stringify({ trash_path: item.trash_path })
        });
        await this.refresh();
      } catch (error: any) {
        const message = error?.message || 'Failed to delete item';
        showErrorMessage('Delete Failed', message);
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
      try {
        await requestAPI<{ success: boolean; deleted_count: number }>('empty', {
          method: 'POST'
        });
        await this.refresh();
      } catch (error: any) {
        const message = error?.message || 'Failed to empty trash';
        showErrorMessage('Empty Trash Failed', message);
      }
    }
  }

  /**
   * Start auto-refresh interval.
   */
  private _startAutoRefresh(): void {
    this._stopAutoRefresh();
    this._refreshIntervalId = setInterval(() => {
      this.refresh();
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
