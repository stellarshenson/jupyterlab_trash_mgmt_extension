<!-- Import workspace-level CLAUDE.md configuration -->
<!-- See /home/lab/workspace/.claude/CLAUDE.md for complete rules -->

# Project-Specific Configuration

This file extends workspace-level configuration with project-specific rules.

## Project Context

JupyterLab extension for trash/bin management. Provides a dedicated left panel (alongside file browser, kernels, git, extensions) for managing deleted files.

**Technology Stack**:

- TypeScript frontend extension with JupyterLab 4.0+ API
- Python server extension using Jupyter Server
- BSD-3-Clause license

**Package Names**:

- npm: `jupyterlab_trash_mgmt_extension`
- PyPI: `jupyterlab-trash-mgmt-extension`
- GitHub repo: `stellarshenson/jupyterlab_trash_mgmt_extension`

## Mandatory Installation

Always install packages using `make install` to ensure both `package.json` and `package-lock.json` are properly managed.
