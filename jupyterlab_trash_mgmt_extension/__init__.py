try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_trash_mgmt_extension' outside a proper installation.")
    __version__ = "dev"
from traitlets import List, Unicode
from traitlets.config import Configurable

from .routes import resolve_locations, setup_route_handlers


class TrashManagement(Configurable):
    """Server options of the trash panel."""

    locations = List(
        Unicode(),
        default_value=[],
        config=True,
        help=(
            "Folders added to the monitored trash folders. The XDG trash (the main "
            "list) and the notebook root are always monitored. The panel lists the "
            ".Trash-<uid> or .Trash/<uid> trash folder of each folder as a section after "
            "the notebook root, in this order. '~' is expanded; a relative path resolves "
            "against the server root_dir. A change needs a server restart."
        ),
    )


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "@stellarshenson/jupyterlab-trash-mgmt-extension"
    }]


def _jupyter_server_extension_points():
    return [{
        "module": "jupyterlab_trash_mgmt_extension"
    }]


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    options = TrashManagement(parent=server_app)
    server_app.web_app.settings['trash_locations'] = resolve_locations(
        ['.'] + options.locations, server_app.root_dir
    )
    setup_route_handlers(server_app.web_app)
    name = "jupyterlab_trash_mgmt_extension"
    server_app.log.info(f"Registered {name} server extension")
