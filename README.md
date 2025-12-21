# jupyterlab_trash_mgmt_extension

[![GitHub Actions](https://github.com/stellarshenson/jupyterlab_trash_mgmt_extension/actions/workflows/build.yml/badge.svg)](https://github.com/stellarshenson/jupyterlab_trash_mgmt_extension/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/jupyterlab_trash_mgmt_extension.svg)](https://www.npmjs.com/package/jupyterlab_trash_mgmt_extension)
[![PyPI version](https://img.shields.io/pypi/v/jupyterlab-trash-mgmt-extension.svg)](https://pypi.org/project/jupyterlab-trash-mgmt-extension/)
[![Total PyPI downloads](https://static.pepy.tech/badge/jupyterlab-trash-mgmt-extension)](https://pepy.tech/project/jupyterlab-trash-mgmt-extension)
[![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4-orange.svg)](https://jupyterlab.readthedocs.io/en/stable/)
[![Brought To You By KOLOMOLO](https://img.shields.io/badge/Brought%20To%20You%20By-KOLOMOLO-00ffff?style=flat)](https://kolomolo.com)
[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat)](https://www.paypal.com/donate/?hosted_button_id=B4KPBJDLLXTSA)

A dedicated left panel for managing your JupyterLab trash. See what's taking up space, restore files you need, or empty the bin entirely.

![Trash Management Panel](.resources/screenshot-trash.png)

## Features

- **Trash panel in sidebar** - Accessible alongside file browser, kernels, git, and extensions panels
- **Storage usage display** - See how much space deleted files occupy
- **Individual item management** - Remove or restore specific files from trash
- **Empty bin** - Clear all deleted files at once
- **Server-side integration** - Python backend for reliable trash operations

## Installation

Requires JupyterLab 4.0.0 or higher.

```bash
pip install jupyterlab_trash_mgmt_extension
```

## Uninstall

```bash
pip uninstall jupyterlab_trash_mgmt_extension
```

---

_Built because I kept running out of disk space and blaming everything except my own hoarding of failed notebooks._
