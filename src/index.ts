import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { isTrashEnabled } from './request';
import { TrashWidget } from './widget';

/**
 * Command IDs for trash management.
 */
namespace CommandIDs {
  export const refresh = 'trash:refresh';
  export const empty = 'trash:empty';
}

/**
 * Initialization data for the jupyterlab_trash_mgmt_extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_trash_mgmt_extension:plugin',
  description:
    'JupyterLab extension for trash management with a dedicated sidebar panel',
  autoStart: true,
  requires: [ILabShell],
  activate: async (app: JupyterFrontEnd, labShell: ILabShell) => {
    console.log(
      'JupyterLab extension jupyterlab_trash_mgmt_extension is activated!'
    );

    // Check if trash functionality is enabled on the server
    const trashEnabled = await isTrashEnabled();
    if (!trashEnabled) {
      console.log(
        'Trash functionality is disabled (delete_to_trash=False). Trash panel will not be shown.'
      );
      return;
    }

    const { commands } = app;

    // Create the trash widget
    const widget = new TrashWidget();

    // Add to left sidebar
    labShell.add(widget, 'left', { rank: 600 });

    // Register refresh command
    commands.addCommand(CommandIDs.refresh, {
      label: 'Refresh Trash',
      caption: 'Refresh the trash panel contents',
      execute: () => {
        widget.refresh();
      }
    });

    // Register empty command
    commands.addCommand(CommandIDs.empty, {
      label: 'Empty Trash',
      caption: 'Permanently delete all items in trash',
      execute: () => {
        // The widget handles the confirmation dialog internally
        (widget as any)._emptyTrash();
      }
    });
  }
};

export default plugin;
