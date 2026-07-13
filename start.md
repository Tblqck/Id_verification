# Liveness Pipeline Launcher (`start.bat`)

This document describes everything the `start.bat` script does when launching the Liveness pipeline from `production/web2/web/start.bat`.

## Prerequisites Checked
- **Python**: The script looks for `py.exe` first and falls back to `python`. If neither is found, it instructs you to install Python from https://python.org with the “Add to PATH” option enabled.

## Packages Installed
- **cryptography**: Installed (or upgraded if already present) via `pip install cryptography --quiet --disable-pip-version-check`. (Left in place for compatibility, though the server itself runs plain HTTP locally.)

## Runtime Flow
1. Set the console title to “Liveness Pipeline” and switch to the script directory.
2. Verify Python is available (`py` or `python`).
3. Install the `cryptography` package quietly to satisfy HTTPS requirements.
4. After a 3-second delay, open `http://localhost:5000/index.html` in the default browser. You can opt-in to `https://` navigation with `--https` or `FORCE_HTTPS=1` if you terminate TLS elsewhere; the bundled server itself stays on HTTP.
5. Launch `server.py` with the discovered Python interpreter; this console becomes the log output for the backend server.
6. When `server.py` exits, the script prints a blank line and calls `pause` so you can review the logs before closing.

## Notes
- The script only installs `cryptography`; other dependencies must already be satisfied by your Python environment or managed inside `server.py`.
- Because the browser opens automatically, ensure certificates are trusted or manually proceed if your browser warns about the self-signed cert.
- The backend server runs HTTP only. If you need to open the page with `https://` (e.g., behind a local reverse proxy that terminates TLS), start with `start.bat --https` or set `FORCE_HTTPS=1` to adjust only the browser URL.
