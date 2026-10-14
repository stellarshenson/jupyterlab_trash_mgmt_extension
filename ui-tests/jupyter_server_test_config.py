"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
import os
from tempfile import mkdtemp

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# `or`, not a get() default: an exported-but-empty JUPYTER_TEST_PORT would
# raise here while Playwright waited on the default port.
c.ServerApp.port = int(os.environ.get("JUPYTER_TEST_PORT") or "8888")

# The test server keeps its settings out of the developer's own
# ~/.jupyter/lab/user-settings folder.
c.LabApp.user_settings_dir = mkdtemp(prefix="galata-settings-")

# The GalaxaHub message-of-the-day extension, where it is installed, opens a
# tab at lab start, and Galata then waits for the Launcher until the test
# times out. traitlets ignores the line where the extension is not installed,
# as in CI.
c.GalaxaHubMotd.open_on_start = False

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
