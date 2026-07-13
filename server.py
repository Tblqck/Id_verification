#!/usr/bin/env python3
"""
KYC Verification server.

Serves the production/web folder.
POST /save  -> writes face JPEG + metadata JSON to captures/,
               then forwards summary + photos to Telegram.

Environment variables:
  PORT                 (set automatically by Render)
  TELEGRAM_BOT_TOKEN   Telegram bot token
  TELEGRAM_CHAT_ID     Telegram chat/channel ID to receive captures
"""

import http.server
import json
import base64
import binascii
import sys
import os
import threading
import mimetypes
import urllib.parse
from datetime import datetime
from pathlib import Path

# Ensure WASM and MediaPipe task files are served with correct types
mimetypes.add_type('application/wasm',         '.wasm')
mimetypes.add_type('application/octet-stream', '.task')
mimetypes.add_type('text/javascript',          '.mjs')

try:
    import requests as _req
    HAS_REQUESTS = True
except ImportError:
    import urllib.request as _urllib
    HAS_REQUESTS = False

PORT  = int(os.environ.get('PORT', 5000))
ROOT  = Path(__file__).parent
SAVES = ROOT / 'captures'

TELEGRAM_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT  = os.environ.get('TELEGRAM_CHAT_ID', '')

EC2_VERIFY_URL = os.environ.get('EC2_VERIFY_URL', 'https://18.185.59.156/api/v1/verify')
EC2_SESSION_STATUS_URL = EC2_VERIFY_URL.rsplit('/', 1)[0] + '/session-status'
# No hardcoded fallback — this was a real leaked key sitting in a public repo.
EC2_API_KEY    = os.environ.get('EC2_API_KEY', '')

# The API box's cert is self-signed (no domain to issue a CA-trusted one
# against) — pin it explicitly rather than disabling verification, so this
# still rejects an active MITM presenting a different certificate.
_CERT_PATH   = Path(__file__).parent / 'aws_admin_cert.pem'
EC2_TLS_VERIFY = str(_CERT_PATH) if _CERT_PATH.exists() else True


# ── Telegram ──────────────────────────────────────────────────────────────────

def _tg(method: str, **kwargs):
    url = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/{method}'
    try:
        if HAS_REQUESTS:
            _req.post(url, timeout=15, **kwargs)
        elif 'json' in kwargs:
            data = json.dumps(kwargs['json']).encode()
            req  = _urllib.Request(url, data=data, headers={'Content-Type': 'application/json'})
            _urllib.urlopen(req, timeout=15)
    except Exception as exc:
        print(f'  [TG] {exc}')


def _md_escape(value) -> str:
    """Escape Telegram legacy-Markdown metacharacters so a client-supplied
    value (this is fed from the unauthenticated /save and /verify payloads)
    can't break out of the intended `code span` and inject arbitrary
    formatting — e.g. a fake clickable [text](url) link — into the ops
    Telegram chat."""
    s = str(value)
    for ch in ('\\', '`', '*', '_', '[', ']'):
        s = s.replace(ch, '\\' + ch)
    return s


def _send_photo_tg(uri: str, caption: str):
    if not HAS_REQUESTS:
        return
    blob = _decode_data_uri(uri)
    if blob:
        _tg('sendPhoto',
            data={'chat_id': TELEGRAM_CHAT, 'caption': caption},
            files={'photo': ('photo.jpg', blob, 'image/jpeg')})


def notify_telegram(data: dict):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        return

    mode = _md_escape(data.get('mode', 'unknown'))
    ts   = _md_escape(data.get('captured_at') or data.get('timestamp') or 'N/A')

    lines = [f'*KYC Capture* — `{mode}`', f'Time: `{ts}`']

    if data.get('country'):
        lines.append(f'Country: `{_md_escape(data["country"])}`')
    if data.get('doc_type'):
        lines.append(f'Doc type: `{_md_escape(data["doc_type"])}`')

    lighting = data.get('lighting_score')
    if lighting is not None:
        lines.append(f'Lighting: `{lighting:.0%}`')

    motion    = data.get('motion') or {}
    yaw_range = motion.get('yaw_range')
    if yaw_range is not None:
        lines.append(f'Yaw range: `{yaw_range:.1f}°`')

    challenges = data.get('challenges') or []
    if challenges:
        passed = sum(1 for c in challenges if c.get('status') == 'done')
        lines.append(f'Challenges: `{passed}/{len(challenges)} passed`')

    tz = (data.get('device') or {}).get('timezone')
    if tz:
        lines.append(f'TZ: `{_md_escape(tz)}`')

    _tg('sendMessage', json={
        'chat_id':    TELEGRAM_CHAT,
        'text':       '\n'.join(lines),
        'parse_mode': 'Markdown',
    })

    face_uri = data.get('face_frame') or ((data.get('face_frames') or [None])[0])
    if face_uri:
        _send_photo_tg(face_uri, f'Face capture · {mode}')

    id_uri = data.get('id_frame')
    if id_uri:
        _send_photo_tg(id_uri, 'ID document — front')

    id_back_uri = data.get('id_frame_back')
    if id_back_uri:
        _send_photo_tg(id_back_uri, 'ID document — back')


def notify_telegram_result(result: dict):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        return

    verdict  = _md_escape((result.get('overall_verdict') or 'unknown').upper())
    score    = result.get('overall_score')
    verified = result.get('verified')
    passed   = 'PASS' in verdict or verified is True

    icon  = '✅' if passed else '❌'
    lines = [f'{icon} *KYC Result* — `{verdict}`']

    if score is not None:
        lines.append(f'Overall score: `{score:.0%}`')

    # Tamper index
    tampered = 'TAMPERED' in verdict
    doc_r    = result.get('document') or {}
    if not tampered and doc_r.get('verdict') == 'fail' and (doc_r.get('score') or 1) < 0.35:
        tampered = True
    lines.append(f'Tamper check: `{"⚠️ TAMPERED" if tampered else "clean"}`')

    # Sub-scores
    face_r = result.get('face') or {}
    if face_r.get('score') is not None:
        lines.append(f'Face match: `{face_r["score"]:.0%}`  ({_md_escape(face_r.get("verdict", ""))})')

    live_r = result.get('liveness') or {}
    if live_r.get('score') is not None:
        lines.append(f'Liveness: `{"live" if live_r.get("is_live") else "spoof"}`  score `{live_r["score"]:.0%}`')

    if doc_r.get('verdict'):
        lines.append(f'Document ref: `{_md_escape(doc_r["verdict"])}`  refs `{doc_r.get("refs_checked", 0)}`')

    # Extracted fields — MRZ first, OCR fallback
    mrz_fields = (result.get('mrz') or {}).get('fields') or {}
    ocr_fields = result.get('ocr_fields') or {}
    fields     = {**ocr_fields, **mrz_fields}  # MRZ wins on conflict

    def _f(key, *aliases):
        for k in (key, *aliases):
            v = fields.get(k)
            if v:
                return str(v)
        return None

    extracted = []
    surname    = _f('surname', 'last_name')
    given      = _f('given_names', 'given_name', 'first_name')
    doc_no     = _f('doc_number', 'document_number', 'id_number')
    dob        = _f('birth_date', 'date_of_birth', 'dob')
    expiry     = _f('expiry_date', 'date_of_expiry', 'expiry')
    nationality = _f('nationality', 'country')

    if surname or given:
        extracted.append(f'Name: `{_md_escape(" ".join(filter(None, [surname, given])))}`')
    if doc_no:
        extracted.append(f'Doc No: `{_md_escape(doc_no)}`')
    if dob:
        extracted.append(f'DOB: `{_md_escape(dob)}`')
    if expiry:
        extracted.append(f'Expiry: `{_md_escape(expiry)}`')
    if nationality:
        extracted.append(f'Nationality: `{_md_escape(nationality)}`')

    if extracted:
        lines.append('')
        lines.append('*Extracted Fields*')
        lines.extend(extracted)

    if result.get('result_id'):
        lines.append(f'\nRef: `{result["result_id"]}`')

    _tg('sendMessage', json={
        'chat_id':    TELEGRAM_CHAT,
        'text':       '\n'.join(lines),
        'parse_mode': 'Markdown',
    })


def _forward_verify(raw: bytes, content_type: str, session_token: str = ''):
    """Runs in a background thread — the browser has already moved on."""
    try:
        headers = {'Content-Type': content_type, 'X-Api-Key': EC2_API_KEY}
        # Generate Link's single-use token, if the browser sent one — this
        # is what lets a hosted capture session (no firm API key available
        # to the browser) still get attributed to the right firm.
        if session_token:
            headers['X-Session-Token'] = session_token
        resp = _req.post(
            EC2_VERIFY_URL,
            data=raw,
            headers=headers,
            timeout=120,
            verify=EC2_TLS_VERIFY,
        )
        try:
            result = resp.json()
        except Exception:
            print(f'  [VERIFY] non-JSON response, status {resp.status_code}')
            return
        notify_telegram_result(result)
    except Exception as exc:
        print(f'  [VERIFY ERR] {exc}')


# ── Request handler ──────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        # Large static model files — cache aggressively
        if self.path.endswith(('.wasm', '.task', '.mjs')):
            self.send_header('Cache-Control', 'public, max-age=86400')
        # App code — always fresh
        elif self.path.endswith(('.js', '.css', '.html')):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _is_captures_path(self) -> bool:
        # SimpleHTTPRequestHandler serves ROOT statically with directory
        # listing on — without this, every face/ID photo and PII-bearing
        # meta.json ever saved to captures/ is publicly downloadable with
        # no auth. Decode + normalize first so encoding tricks (%2e%2e,
        # backslashes) can't slip past a naive prefix check.
        decoded = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        normalized = os.path.normpath(decoded).replace('\\', '/')
        return normalized == '/captures' or normalized.startswith('/captures/')

    def do_GET(self):
        if self.path.startswith('/session-status'):
            self._handle_session_status()
            return
        if self._is_captures_path():
            self.send_response(403)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"Forbidden"}')
            return
        super().do_GET()

    def do_HEAD(self):
        if self._is_captures_path():
            self.send_response(403)
            self.end_headers()
            return
        super().do_HEAD()

    def do_POST(self):
        if self.path == '/save':
            self._handle_save()
        elif self.path == '/verify':
            self._handle_verify()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_save(self):
        length = int(self.headers.get('Content-Length', 0))
        raw    = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            files   = save_capture(payload)
            threading.Thread(target=notify_telegram, args=(payload,), daemon=True).start()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True, 'files': files}).encode())
        except Exception as exc:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(exc)}).encode())
            print(f'  [ERR] {exc}')

    def _handle_verify(self):
        if not HAS_REQUESTS:
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'requests not installed'}).encode())
            return
        length        = int(self.headers.get('Content-Length', 0))
        raw           = self.rfile.read(length)
        content_type  = self.headers.get('Content-Type', '')
        session_token = self.headers.get('X-Session-Token', '')

        # A verification link is now required — walk-up verification with
        # no link is no longer allowed. The frontend already blocks entry
        # without a token, but this is the actual security boundary: it
        # doesn't matter what called this endpoint, nothing gets forwarded
        # to the real API without a token attached.
        if not session_token:
            self.send_response(403)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': False, 'error': 'A valid verification link is required.'}).encode())
            return

        # The EC2 pipeline (OCR in particular) can take 30-60s+. The browser
        # doesn't wait on or display the verdict, so don't make it hold the
        # connection open for the full pipeline — forward it in the
        # background and let the user leave the page immediately. The
        # result still reaches the operator via Telegram once it lands.
        threading.Thread(
            target=_forward_verify,
            args=(raw, content_type, session_token),
            daemon=True,
        ).start()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'status': 'processing'}).encode())

    def _handle_session_status(self):
        # Read-only pre-check the frontend calls before showing any capture
        # UI, so a dead/made-up token bounces to a "link expired" screen
        # immediately instead of failing at the very last /verify submit.
        # Synchronous (unlike /verify) — the page needs the answer to decide
        # what to render.
        query = urllib.parse.urlsplit(self.path).query
        token = urllib.parse.parse_qs(query).get('token', [''])[0]

        result = {"valid": False, "reason": "missing"}
        if token and HAS_REQUESTS:
            try:
                resp = _req.get(
                    EC2_SESSION_STATUS_URL,
                    params={'token': token},
                    timeout=15,
                    verify=EC2_TLS_VERIFY,
                )
                result = resp.json()
            except Exception as exc:
                print(f'  [SESSION-STATUS ERR] {exc}')
                result = {"valid": False, "reason": "check_failed"}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def log_message(self, fmt, *args):
        ts = datetime.now().strftime('%H:%M:%S')
        # Render (and any reverse proxy) terminates the real client connection,
        # so self.client_address is the proxy's own address, not the visitor's.
        # The real origin is in X-Forwarded-For (client, then any hops), set by
        # the proxy — take the first entry.
        forwarded = self.headers.get('X-Forwarded-For', '')
        ip = forwarded.split(',')[0].strip() if forwarded else self.client_address[0]
        print(f'  [{ts}] {ip} {fmt % args}')


# ── File saving ──────────────────────────────────────────────────────────────

def save_capture(data: dict) -> list:
    SAVES.mkdir(exist_ok=True)
    ts    = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    saved = []

    frames = data.get('face_frames')
    if not isinstance(frames, list):
        frames = []
    if not frames and data.get('face_frame'):
        frames = [data['face_frame']]

    pack         = data.get('capture_pack') or []
    saved_frames = []

    for idx, uri in enumerate(frames):
        blob = _decode_data_uri(uri)
        if not blob:
            continue
        meta = pack[idx] if idx < len(pack) and isinstance(pack[idx], dict) else {}
        safe = _slugify(meta.get('type') or f'frame_{idx + 1}')
        path = SAVES / f'{ts}_{idx + 1:02d}_{safe}.jpg'
        path.write_bytes(blob)
        kb   = path.stat().st_size // 1024
        print(f'  -> {path.name}  ({kb} KB)')
        saved.append(path.name)
        saved_frames.append({
            'index': idx,
            'type':  meta.get('type'),
            'label': meta.get('label'),
            'file':  path.name,
        })

    meta_data = {k: v for k, v in data.items()
                 if k not in {'face_frame', 'face_frames', 'id_frame', 'id_frame_back'}}
    meta_data['saved_frames'] = saved_frames

    id_files = []

    id_front = data.get('id_frame')
    if isinstance(id_front, str):
        blob = _decode_data_uri(id_front)
        if blob:
            name = f'{ts}_id_front.jpg'
            path = SAVES / name
            path.write_bytes(blob)
            kb = path.stat().st_size // 1024
            print(f'  -> {path.name}  ({kb} KB)')
            saved.append(name)
            id_files.append({'side': 'front', 'file': name})

    id_back = data.get('id_frame_back')
    if isinstance(id_back, str):
        blob = _decode_data_uri(id_back)
        if blob:
            name = f'{ts}_id_back.jpg'
            path = SAVES / name
            path.write_bytes(blob)
            kb = path.stat().st_size // 1024
            print(f'  -> {path.name}  ({kb} KB)')
            saved.append(name)
            id_files.append({'side': 'back', 'file': name})

    if id_files:
        meta_data['id_files'] = id_files

    meta_path = SAVES / f'{ts}_meta.json'
    meta_path.write_text(json.dumps(meta_data, indent=2), encoding='utf-8')
    print(f'  -> {meta_path.name}')
    saved.append(meta_path.name)

    return saved


def _decode_data_uri(uri: str):
    if not isinstance(uri, str) or not uri.strip():
        return None
    payload = uri.split(',', 1)[1] if ',' in uri else uri
    try:
        return base64.b64decode(payload)
    except (binascii.Error, ValueError):
        return None


def _slugify(value: str) -> str:
    if not isinstance(value, str) or not value:
        return 'frame'
    cleaned = ''.join(ch.lower() if ch.isalnum() else '_' for ch in value)
    return cleaned.strip('_') or 'frame'


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    tg_status = 'configured' if TELEGRAM_TOKEN else 'NOT configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'
    print()
    print('  +--------------------------------------------------+')
    print('  |  KYC Verify  (HTTP - Render handles SSL)          |')
    print('  +--------------------------------------------------+')
    print(f'  |  Port     : {PORT}')
    print(f'  |  Saves    : {SAVES}')
    print(f'  |  Telegram : {tg_status}')
    print('  |  Ctrl+C to stop')
    print('  +--------------------------------------------------+')
    print()

    # ThreadingHTTPServer, not plain HTTPServer — /session-status blocks on a
    # synchronous EC2 round-trip (up to 15s); a single-threaded server would
    # stall every other visitor's request for that whole window.
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Server stopped.')
        sys.exit(0)
