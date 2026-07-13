# Git workflow for this folder

This folder is a **standalone git repository** — it has its own `.git`,
separate from the larger `id/` project tree it happens to sit inside. It is
not a subfolder of some bigger monorepo history; as far as git is concerned,
`development/web/` *is* the repo root.

This matches how the rest of the project is organized: each piece (this
capture app, the verification API, the admin dashboard, the database
scripts, ...) lives in its own folder locally and pushes to its own
dedicated repo. Nothing here points outward at sibling folders, and nothing
outside this folder should assume it can `git add`/`git commit` on its
behalf — nesting this repo's history inside another one would defeat the
whole point.

## Remote

- **origin** → `https://github.com/Tblqck/Id_verification.git`
- **branch** → `main`
- **visibility** → public

## Everyday workflow

Run all git commands *from inside this folder* (`development/web/`), not
from the parent `id/` directory — that parent has its own separate,
unrelated repo (or none at all) and knows nothing about this one.

```bash
cd development/web        # if you're not already here
git status                 # see what changed
git add <files>             # stage specific files (avoid `git add -A`
                             # blindly — check status first)
git commit -m "..."
git push origin main
```

That's it. Because this folder's root is the repo root, whatever's at the
top level here (`index.html`, `server.py`, `scripts/`, ...) is exactly what
Render (or anyone else) sees at the top level of the GitHub repo. No path
prefix, no wrapper folder.

## Deployment (Render)

The `id-verification` Render service should have its **Root Directory**
left **blank** (repo root) — not `web`, not `development/web`. Since this
repo's root already *is* the app, Render just needs:

- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `python server.py`

If a past deploy failure mentioned a Root Directory that no longer exists,
that setting needs clearing in the Render dashboard — this file can't do
that part for you.

## What's gitignored here

- `_cert.pem` / `_key.pem` — local self-signed HTTPS cert for `start.bat`,
  regenerated per machine, never shared.
- `captures/` — real applicant photos saved by `server.py` during local
  testing. Never committed; purge this folder locally once you're done
  testing rather than letting real biometric data sit around.
- `mediapipe-tasks-vision-*.tgz` — the source tarball for the vendored
  MediaPipe WASM bundle already unpacked into `liveness/`.
- `*.log` — local server logs.
- `__pycache__/`, `.claude/` — routine local clutter.

## Why this folder, specifically

`development/web/` is the *only* thing that needs to exist for this app to
run: the three-step capture flow (`index.html` → `id-capture.html` →
`liveness.html` → `handoff.html`), its `scripts/`/`styles/`/`liveness/`
assets, and `server.py`, which serves all of it and proxies `/verify`,
`/save`, and `/session-status` to the real verification API on EC2. Nothing
outside this folder is required to build, run, or deploy it.
