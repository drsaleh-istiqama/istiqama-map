#!/usr/bin/env python3
"""Download only selected members of a remote ZIP archive using HTTP range requests.

Slow field connections make full toolchain archives (hundreds of MB, mostly GUI tools and
docs we never use) impractical. This tool reads the remote central directory, computes the
byte ranges of the wanted members, downloads just those ranges into a sparse local copy of
the archive and extracts them.

Usage:
  zip_range_fetch.py <url> <dest_dir> --include <regex> [--exclude <regex>] [--list]
                     [--cache <file>] [--seed <partial_file>] [--strip <n>] [--workers 4]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import os
import re
import sys
import time
import urllib.request
import zipfile

UA = {"User-Agent": "istiqama-map-setup/1.0"}


def http_size(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def fetch_range(url: str, start: int, end: int, fh_path: str, attempts: int = 8) -> int:
    """Fetch bytes [start, end) into the cache file at the same offsets. Resumes on failure."""
    pos = start
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={pos}-{end - 1}"})
            with urllib.request.urlopen(req, timeout=90) as r, open(fh_path, "r+b") as fh:
                fh.seek(pos)
                while True:
                    chunk = r.read(64 * 1024)
                    if not chunk:
                        break
                    fh.write(chunk)
                    pos += len(chunk)
            if pos >= end:
                return end - start
        except Exception as exc:  # noqa: BLE001 - retry on any network error
            time.sleep(min(30, 2 * (attempt + 1)))
            last = exc
    raise RuntimeError(f"range {start}-{end} failed at {pos}: {last}")


def merge(ranges: list[tuple[int, int]], gap: int) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for s, e in sorted(ranges):
        if out and s - out[-1][1] <= gap:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return out


def subtract(ranges: list[tuple[int, int]], have: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out = []
    for s, e in ranges:
        cur = s
        for hs, he in sorted(have):
            if he <= cur or hs >= e:
                continue
            if hs > cur:
                out.append((cur, hs))
            cur = max(cur, he)
        if cur < e:
            out.append((cur, e))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("dest")
    ap.add_argument("--include", required=True)
    ap.add_argument("--exclude", default=None)
    ap.add_argument("--list", action="store_true", help="only list what would be fetched")
    ap.add_argument("--cache", default=None, help="sparse local copy of the archive")
    ap.add_argument("--seed", default=None, help="partial sequential download to reuse")
    ap.add_argument("--strip", type=int, default=0, help="strip leading path components")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    size = http_size(args.url)
    cache = args.cache or os.path.join(args.dest, os.path.basename(args.url) + ".sparse")
    os.makedirs(os.path.dirname(os.path.abspath(cache)), exist_ok=True)
    have: list[tuple[int, int]] = []
    state = cache + ".ranges"
    if not os.path.exists(cache):
        with open(cache, "wb") as fh:
            fh.truncate(size)
    elif os.path.exists(state):
        for line in open(state):
            s, e = line.split()
            have.append((int(s), int(e)))
    if args.seed and os.path.exists(args.seed) and not any(h[0] == 0 for h in have):
        n = os.path.getsize(args.seed)
        n -= n % 65536  # the tail of an in-flight download may be incomplete
        with open(args.seed, "rb") as src, open(cache, "r+b") as dst:
            left = n
            while left > 0:
                buf = src.read(min(1 << 20, left))
                if not buf:
                    break
                dst.write(buf)
                left -= len(buf)
        have.append((0, n))
        with open(state, "a") as fh:
            fh.write(f"0 {n}\n")

    def record(s: int, e: int) -> None:
        have.append((s, e))
        with open(state, "a") as fh:
            fh.write(f"{s} {e}\n")

    # central directory: last 128 KiB is enough to find the EOCD, then fetch the full CD.
    tail = (max(0, size - 128 * 1024), size)
    for s, e in subtract([tail], have):
        fetch_range(args.url, s, e, cache)
        record(s, e)
    with open(cache, "rb") as fh:
        fh.seek(tail[0])
        blob = fh.read()
    eocd = blob.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("EOCD not found")
    cd_size = int.from_bytes(blob[eocd + 12:eocd + 16], "little")
    cd_off = int.from_bytes(blob[eocd + 16:eocd + 20], "little")
    for s, e in subtract([(cd_off, size)], have):
        fetch_range(args.url, s, e, cache)
        record(s, e)

    inc = re.compile(args.include)
    exc = re.compile(args.exclude) if args.exclude else None
    zf = zipfile.ZipFile(cache)
    members = [m for m in zf.infolist() if inc.search(m.filename) and not (exc and exc.search(m.filename))]
    wanted = [(m.header_offset, m.header_offset + 30 + len(m.filename.encode()) + 1024 + m.compress_size)
              for m in members if not m.is_dir()]
    wanted = [(s, min(e, cd_off)) for s, e in wanted]
    todo = subtract(merge(wanted, 128 * 1024), have)
    total = sum(e - s for s, e in todo)
    comp = sum(m.compress_size for m in members)
    print(f"archive {size / 1e6:.1f} MB; selected {len(members)} members "
          f"({comp / 1e6:.1f} MB compressed); to download now: {total / 1e6:.1f} MB in {len(todo)} ranges",
          flush=True)
    if args.list:
        for m in members[:4000]:
            print(f"{m.compress_size:>10} {m.filename}")
        return 0

    # split big ranges so several workers make progress and failures cost little
    parts: list[tuple[int, int]] = []
    for s, e in todo:
        while e - s > 4 << 20:
            parts.append((s, s + (4 << 20)))
            s += 4 << 20
        parts.append((s, e))
    done = 0
    t0 = time.time()
    with cf.ThreadPoolExecutor(args.workers) as pool:
        futs = {pool.submit(fetch_range, args.url, s, e, cache): (s, e) for s, e in parts}
        for fut in cf.as_completed(futs):
            s, e = futs[fut]
            fut.result()
            record(s, e)
            done += e - s
            rate = done / max(1, time.time() - t0) / 1024
            print(f"  {done / 1e6:7.1f} / {total / 1e6:.1f} MB  ({rate:.0f} KB/s)", flush=True)

    os.makedirs(args.dest, exist_ok=True)
    n = 0
    for m in members:
        parts_ = m.filename.split("/")[args.strip:]
        if not parts_ or not parts_[-1] and m.is_dir() is False:
            continue
        target = os.path.join(args.dest, *parts_)
        if m.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(m) as src, open(target, "wb") as dst:
            while True:
                buf = src.read(1 << 20)
                if not buf:
                    break
                dst.write(buf)
        n += 1
    print(f"extracted {n} files to {args.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
