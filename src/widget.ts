import { Widget } from '@lumino/widgets';
import { showDialog, Dialog, showErrorMessage } from '@jupyterlab/apputils';
import { requestAPI } from './request';
import {
  trashIcon,
  folderIcon,
  fileIcon,
  restoreIcon,
  deleteIcon,
  refreshIcon
} from './icon';

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

export class TrashWidget extends Widget {
  private _header: HTMLDivElement;
  private _list: HTMLDivElement;
  private _emptyMessage: HTMLDivElement;

  constructor() {
    super();
    this.id = 'jp-trash-panel';
    this.title.icon = trashIcon;
    this.title.caption = 'Trash';
    this.addClass('jp-TrashPanel');

    // Create header
    this._header = document.createElement('div');
    this._header.className = 'jp-TrashPanel-header';
    this.node.appendChild(this._header);

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

    // Initial load
    this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const data = await requestAPI<ITrashListResponse>('list');
      this._renderHeader(data);
      this._renderItems(data.items);
    } catch (error) {
      console.error('Failed to load trash:', error);
      showErrorMessage('Trash Error', 'Failed to load trash contents');
    }
  }

  private _renderHeader(data: ITrashListResponse): void {
    this._header.innerHTML = '';

    // Size info
    const sizeInfo = document.createElement('div');
    sizeInfo.className = 'jp-TrashPanel-header-info';
    sizeInfo.innerHTML = `<span class="jp-TrashPanel-header-count">${data.item_count} items</span>
      <span class="jp-TrashPanel-header-size">${data.total_size_formatted}</span>`;
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
      emptyBtn.className = 'jp-TrashPanel-header-button jp-TrashPanel-header-button-danger';
      emptyBtn.title = 'Empty Trash';
      emptyBtn.textContent = 'Empty';
      emptyBtn.addEventListener('click', () => this._emptyTrash());
      actions.appendChild(emptyBtn);
    }

    this._header.appendChild(actions);
  }

  private _renderItems(items: ITrashItem[]): void {
    this._list.innerHTML = '';

    if (items.length === 0) {
      this._emptyMessage.style.display = 'flex';
      this._list.style.display = 'none';
      return;
    }

    this._emptyMessage.style.display = 'none';
    this._list.style.display = 'block';

    for (const item of items) {
      const itemEl = this._createItemElement(item);
      this._list.appendChild(itemEl);
    }
  }

  private _createItemElement(item: ITrashItem): HTMLDivElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'jp-TrashPanel-item';

    // Icon
    const iconEl = document.createElement('div');
    iconEl.className = 'jp-TrashPanel-item-icon';
    if (item.is_dir) {
      folderIcon.element({ container: iconEl });
    } else {
      fileIcon.element({ container: iconEl });
    }
    itemEl.appendChild(iconEl);

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'jp-TrashPanel-item-content';

    const nameEl = document.createElement('div');
    nameEl.className = 'jp-TrashPanel-item-name';
    nameEl.textContent = item.name;
    nameEl.title = item.original_path;
    contentEl.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'jp-TrashPanel-item-meta';
    const dateStr = this._formatDate(item.deletion_date);
    metaEl.textContent = `${item.size_formatted} - ${dateStr}`;
    contentEl.appendChild(metaEl);

    itemEl.appendChild(contentEl);

    // Actions
    const actionsEl = document.createElement('div');
    actionsEl.className = 'jp-TrashPanel-item-actions';

    // Restore button
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'jp-TrashPanel-item-button';
    restoreBtn.title = 'Restore';
    restoreIcon.element({ container: restoreBtn });
    restoreBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._restoreItem(item);
    });
    actionsEl.appendChild(restoreBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'jp-TrashPanel-item-button jp-TrashPanel-item-button-danger';
    deleteBtn.title = 'Delete Permanently';
    deleteIcon.element({ container: deleteBtn });
    deleteBtn.addEventListener('click', e => {
      e.stopPropagation();
      this._deleteItem(item);
    });
    actionsEl.appendChild(deleteBtn);

    itemEl.appendChild(actionsEl);

    return itemEl;
  }

  private _formatDate(isoDate: string): string {
    if (!isoDate) {
      return 'Unknown date';
    }
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
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
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Empty Trash' })]
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
}
