import argparse
import json
import os
import sys
from pathlib import Path

import requests


DEFAULT_API = "https://18.185.59.156"
# No hardcoded fallback — this was a real leaked key sitting in a public repo.
# Set KYC_API_KEY or pass --api-key explicitly.
DEFAULT_KEY = os.environ.get("KYC_API_KEY") or ""


def parse_args():
    ap = argparse.ArgumentParser(description="Send the latest capture to the KYC verify API")
    ap.add_argument("--api", default=DEFAULT_API, help="Base API URL (default: %(default)s)")
    ap.add_argument("--api-key", default=DEFAULT_KEY, help="X-Api-Key header (env KYC_API_KEY overrides)")
    ap.add_argument("--capture-dir", default=Path(__file__).parent / "captures", type=Path,
                    help="Directory containing saved captures")
    ap.add_argument("--meta", type=Path, help="Specific *_meta.json to use; defaults to latest in capture dir")
    ap.add_argument("--user-ref", default="cli_run", help="User reference to pass to the API")
    return ap.parse_args()


def pick_meta(capture_dir: Path, meta_path: Path | None) -> Path:
    if meta_path:
        if not meta_path.exists():
            sys.exit(f"Meta file not found: {meta_path}")
        return meta_path
    candidates = sorted(capture_dir.glob("*_meta.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        sys.exit(f"No *_meta.json files in {capture_dir}")
    return candidates[0]


def coerce_country(meta: dict) -> str:
    country = meta.get("country")
    if isinstance(country, dict):
        return country.get("code2") or country.get("code3") or country.get("name") or ""
    return country or ""


def coerce_doc_type(meta: dict) -> str:
    return meta.get("doc_type") or meta.get("docType") or ""


def collect_id_image(meta: dict, capture_dir: Path) -> Path:
    files = meta.get("id_files") or []
    if isinstance(files, list) and files:
        candidate = files[0].get("file") if isinstance(files[0], dict) else None
        if candidate:
            path = capture_dir / candidate
            if path.exists():
                return path
    fallback = sorted(capture_dir.glob("*_id_front.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
    if fallback:
        return fallback[0]
    sys.exit("No ID front image found in captures.")


def collect_liveness_frames(meta: dict, capture_dir: Path, limit: int = 5) -> list[Path]:
    frames = []
    for entry in meta.get("saved_frames") or []:
        name = entry.get("file") if isinstance(entry, dict) else None
        if not name:
            continue
        path = capture_dir / name
        if path.exists():
            frames.append(path)
    if not frames:
        frames = sorted(capture_dir.glob("*_frame_*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
    return frames[:limit]


def build_request(meta: dict, capture_dir: Path, user_ref: str):
    country  = coerce_country(meta)
    doc_type = coerce_doc_type(meta)
    if not country or not doc_type:
        sys.exit("Country or doc_type missing in meta; cannot build payload.")

    id_image = collect_id_image(meta, capture_dir)
    frames   = collect_liveness_frames(meta, capture_dir)
    if not frames:
        sys.exit("No liveness frames found in captures.")

    data = {
        "country":   country,
        "doc_type":  doc_type,
        "mode":      "3",
        "user_ref":  user_ref,
        "issue_year": str(meta.get("issue_year") or 2025),
    }

    handles = []
    files = []
    try:
        fh = open(id_image, "rb"); handles.append(fh)
        files.append(("id_image", (id_image.name, fh, "image/jpeg")))
        for i, path in enumerate(frames):
            fh = open(path, "rb"); handles.append(fh)
            files.append(("liveness_frames", (path.name, fh, "image/jpeg")))
    except Exception:
        for h in handles:
            h.close()
        raise

    return data, files, handles


def main():
    args = parse_args()
    if not args.api_key:
        sys.exit("API key is required; set --api-key or KYC_API_KEY.")

    meta_path = pick_meta(args.capture_dir, args.meta)
    with meta_path.open("r", encoding="utf-8") as fh:
        meta = json.load(fh)

    data, files, handles = build_request(meta, args.capture_dir, args.user_ref)

    # The API box's cert is self-signed (no domain to issue a CA-trusted one
    # against) — pin it explicitly rather than disabling verification, so
    # this still rejects an active MITM presenting a different certificate.
    cert_path = Path(__file__).parent / "aws_admin_cert.pem"
    verify = str(cert_path) if cert_path.exists() else True

    try:
        resp = requests.post(
            f"{args.api}/api/v1/verify",
            headers={"X-Api-Key": args.api_key},
            data=data,
            files=files,
            timeout=120,
            verify=verify,
        )
        print(f"HTTP {resp.status_code}")
        try:
            print(json.dumps(resp.json(), indent=2))
        except Exception:
            print(resp.text)
        resp.raise_for_status()
    finally:
        for h in handles:
            try:
                h.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
