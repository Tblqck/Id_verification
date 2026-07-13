# API Flow — `production/web`

How a verification request gets from the browser to the EC2 inference server
and back. Written after reading the live server source over SSH on
2026-07-06 — treat this as ground truth over `CAPTURE_SYSTEM.md`, which
documents the older `pipeline.html` flow that is no longer linked from the
live UI.

## 1. Two deployment topologies

This folder's code supports two different ways of running, and it matters
which one you think you're looking at:

| | **A — Split (this folder's actual setup)** | **B — Self-hosted (EC2 container)** |
|---|---|---|
| Frontend served by | `server.py` (plain `http.server`, port 5000) | The FastAPI app itself (`production/api/main.py`) |
| API served by | Remote EC2 box, called cross-network | Same process, same origin |
| Browser calls | `/save`, `/verify` (relative, on `server.py`) | Would need `/api/v1/save`, `/api/v1/verify` |
| Heavy deps (opencv, onnxruntime, tesseract, rapidocr) | Not needed here | Needed, baked into the Docker image |

**This folder runs topology A.** `server.py` is a thin static file server
+ reverse proxy meant to be deployed somewhere light (Render — see the
"Render handles SSL" comment in `server.py`), while the actual ML pipeline
runs separately on an EC2 instance in Docker. The HTML pages hardcode
`/save` and `/verify` because they assume `server.py` (or something
API-compatible with it) is what's in front of them — those routes do
**not** exist at those paths if you point a browser straight at the EC2
box; there it's `/api/v1/save` and `/api/v1/verify`.

## 2. The live user-facing flow

```
index.html  →  id-capture.html  →  liveness.html
(pick country   (capture ID       (liveness challenge,
 + doc type)     front/back)       then submits everything)
```

State is passed between pages via `sessionStorage` key `kyc-flow-v2`
(see `scripts/state.js`). `liveness.html` is a hard dependency on
`sess.idFrame` existing — it redirects back to `index.html` if not.

`pipeline.html` / `scripts/pipeline.js` and `handoff.html` /
`scripts/handoff.js` are **not** part of this flow — nothing links to them
except `sw.js`'s precache list. `pipeline.js` never calls `/verify` at all
(only `/save`); `handoff.html` is a leftover manual-review/debug page that
dumps the raw JSON payload to the screen. Ignore both unless told
otherwise.

## 3. What `liveness.js` actually sends

On the final challenge frame, `emit()` in `scripts/liveness.js`:

1. Fires `POST /save` (fire-and-forget, JSON body) — this is purely local
   archival + Telegram notification of the *capture*, handled entirely by
   `server.py`'s own `_handle_save`. It never reaches the EC2 box.
2. Calls `sendToVerify(payload)`, which builds a **multipart/form-data**
   request and `POST`s it to `window.VERIFY_API_URL` (`/verify`).

`server.py`'s `_handle_verify` proxies that request byte-for-byte
(same body, same `Content-Type` incl. boundary) to
`EC2_VERIFY_URL` (default `http://18.185.59.156/api/v1/verify`), adding an
`X-Api-Key` header. It returns the EC2 response straight back to the
browser, and separately fires `notify_telegram_result()` with whatever
JSON came back.

## 4. The `/api/v1/verify` contract (from the EC2 source, `routers/verify.py`)

Multipart form fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `country` | Form string | yes | ISO alpha-2, e.g. `"NG"`. `normalizeCountry()` in `liveness.js` pulls `.code2` off the country object stored in session. |
| `doc_type` | Form string | yes | One of `passport`, `national_id`, `drivers_license`, `residence_permit` — matches `data-type` attributes in `index.html` exactly. |
| `id_image` | File | yes | Front of ID. Server 422s if missing. |
| `id_image_back` | File | no | Back of ID, if captured. |
| `mode` | Form int | no (default 1) | `liveness.js` hardcodes `"3"` — id + liveness-frames mode. |
| `liveness_frames` | File[] | mode 3: yes, 1–5 | `liveness.js` sends `payload.face_frames.slice(0, 5)`. Server 400s on 0 or >5. |
| `selfie` / `holding_photo` | File | mode 1/2 only | Unused by this flow (mode is always 3). |
| `user_ref` | Form string | no (default `"anonymous"`) | Sent as `navigator.userAgent`. |
| `issue_year` | Form int | no (default 2020) | `liveness.js` defaults to `2025` if `id_quality.issue_year` isn't set — nothing in the current UI actually collects this, so it's always the fallback. Cosmetic; only affects OCR blueprint calibration. |

Response JSON includes `ok`, `verified`, `overall_score`, `overall_verdict`,
`document`, `face`, `ocr_fields`, `mrz` (passports), `liveness` (mode 3),
`result_id`. **The browser now ignores all of this** — see §6.

The `X-Api-Key` header `server.py` sends is currently **not checked by the
EC2 API at all** (no auth dependency/middleware in `main.py` or
`verify.py`). It's harmless to keep sending but don't rely on it as a
security boundary.

## 5. Known-good values, verified live on 2026-07-06

- EC2 public IP: **`18.185.59.156`** (was previously hardcoded as the dead
  `3.72.34.178` in both `server.py` and `send_to_api.py` — fixed). This is
  the box's current public IP, not a confirmed Elastic IP — if the
  instance is ever stopped/restarted, re-verify with
  `curl http://<ip>/health`.
- Confirmed working end-to-end against the live API using the sample
  capture in `captures/2026-07-05_21-48-37_*`, both directly
  (`send_to_api.py`) and through `server.py`'s `/verify` proxy — both
  returned `HTTP 200` with real OCR (`HANSON`, `ABASIEKEME EMMANUE`, etc.),
  face-match, and liveness scores.
- Every call to `/api/v1/verify` writes a row to the EC2's Supabase-backed
  DB and fires a real Telegram notification — there is no "dry run" mode.
  Don't hit it with test data unless you mean to.

## 6. Result is intentionally not shown to the user

`showDone()` in `liveness.js` no longer inspects the `/verify` response —
it just flips from the "We are verifying your identity…" overlay to a
static "Verification submitted" screen regardless of pass/fail/tamper
verdict. The real verdict still reaches the operator via the EC2 server's
own Telegram notification (`_tg_result` in `routers/verify.py`); the
end-user browser is deliberately blind to it.

## 7. Debugging / replay tool

`send_to_api.py` replays the most recent (or a specified) `*_meta.json` +
its saved frames from `captures/` straight against `/api/v1/verify`,
bypassing the browser and `server.py` entirely:

```
python send_to_api.py --user-ref manual_test
python send_to_api.py --meta captures/2026-07-05_21-48-37_meta.json
```

Remember this hits the **live** API — same caveat as above.
