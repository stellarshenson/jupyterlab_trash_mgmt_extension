import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { nullTranslator } from '@jupyterlab/translation';

import { isTrashEnabled } from './request';
// eslint-disable-next-line jupyter/prefer-lazy-imports -- the panel widget is created in activate(); it is the extension's purpose
import { TrashWidget } from './widget';

const trans = nullTranslator.load('jupyterlab_trash_mgmt_extension');

/**
 * Command IDs for trash management.
 */
namespace CommandIDs {
  export const refresh = 'trash:refresh';
  export const empty = 'trash:empty';
}

/**
 * Initialization data for the @stellarshenson/jupyterlab-trash-mgmt-extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@stellarshenson/jupyterlab-trash-mgmt-extension:plugin',
  description:
    'JupyterLab extension for trash management with a dedicated sidebar panel',
  autoStart: true,
  requires: [ILabShell],
  activate: async (app: JupyterFrontEnd, labShell: ILabShell) => {
    console.log(
      'JupyterLab extension @stellarshenson/jupyterlab-trash-mgmt-extension is activated!'
    );

    // Check if trash functionality is enabled on the server
    const serverSettings = app.serviceManager.serverSettings;
    const trashEnabled = await isTrashEnabled(serverSettings);
    if (!trashEnabled) {
      console.log(
        'Trash functionality is disabled (delete_to_trash=False). Trash panel will not be shown.'
      );
      return;
    }

    const { commands } = app;

    // Create the trash widget
    const widget = new TrashWidget(serverSettings);

    // Add to left sidebar
    labShell.add(widget, 'left', { rank: 600 });

    // Register refresh command
    commands.addCommand(CommandIDs.refresh, {
      label: trans.__('Refresh Trash'),
      caption: trans.__('Refresh the trash panel contents'),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => {
        widget.refresh();
      }
    });

    // Register empty command
    commands.addCommand(CommandIDs.empty, {
      label: trans.__('Empty Trash'),
      caption: trans.__('Permanently delete all items in trash'),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => {
        // The widget handles the confirmation dialog internally
        (widget as any)._emptyTrash();
      }
    });
  }
};

export default plugin;
