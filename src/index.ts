import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ICommandPalette } from '@jupyterlab/apputils';
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
  export const cleanAll = 'trash:clean-all';
  export const cleanWorkspace = 'trash:clean-workspace';
  export const showVolumes = 'trash:show-volumes';
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
  optional: [ICommandPalette],
  activate: async (
    app: JupyterFrontEnd,
    labShell: ILabShell,
    palette: ICommandPalette | null
  ) => {
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
        (widget as any)._cleanSources('all');
      }
    });

    // Register empty all bins command
    commands.addCommand(CommandIDs.cleanAll, {
      label: trans.__('Empty All Bins'),
      caption: trans.__('Permanently delete every item in every trash source'),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => {
        // The widget handles the confirmation dialog internally
        (widget as any)._cleanSources('all');
      }
    });

    // Register clean workspace command
    commands.addCommand(CommandIDs.cleanWorkspace, {
      label: trans.__('Clean Workspace'),
      caption: trans.__(
        'Permanently delete the trash entries under the workspace root'
      ),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => {
        // The widget handles the confirmation dialog internally
        (widget as any)._cleanSources('workspace');
      }
    });

    // Register the Show Volumes toggle; the panel header menu holds it too
    commands.addCommand(CommandIDs.showVolumes, {
      label: trans.__('Show Volumes'),
      caption: trans.__('Show each trash source as its own section'),
      describedBy: { args: { type: 'object', properties: {} } },
      isToggled: () => widget.showVolumes,
      execute: () => {
        widget.toggleShowVolumes();
      }
    });

    // The palette is the only place the two cleans can be started from
    for (const command of Object.values(CommandIDs)) {
      palette?.addItem({ command, category: trans.__('Trash') });
    }
  }
};

export default plugin;
