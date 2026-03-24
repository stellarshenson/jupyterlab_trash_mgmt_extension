<!-- @import /home/lab/workspace/.claude/CLAUDE.md -->

# Project-Specific Configuration

This file imports workspace-level configuration from `/home/lab/workspace/.claude/CLAUDE.md`.
All workspace rules apply. Project-specific rules below strengthen or extend them.

The workspace `/home/lab/workspace/.claude/` directory contains additional instruction files
(MERMAID.md, NOTEBOOK.md, DATASCIENCE.md, GIT.md, and others) referenced by CLAUDE.md.
Consult workspace CLAUDE.md and the .claude directory to discover all applicable standards.

## Mandatory Bans (Reinforced)

The following workspace rules are STRICTLY ENFORCED for this project:

- **No automatic git tags** - only create tags when user explicitly requests
- **No automatic version changes** - only modify version in package.json/pyproject.toml/etc. when user explicitly requests
- **No automatic publishing** - never run `make publish`, `npm publish`, `twine upload`, or similar without explicit user request
- **No manual package installs if Makefile exists** - use `make install` or equivalent Makefile targets, not direct `pip install`/`uv install`/`npm install`
- **No automatic git commits or pushes** - only when user explicitly requests

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
