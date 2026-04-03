#!/usr/bin/env python3
"""Maintenance utility for deep research memory.

Moves invalid, duplicate, stale, or low-quality generated memory into memory_archive.
This keeps active memory high-signal while preserving old files for inspection.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

BASE = Path(__file__).parent
MEMORY_DIR = BASE / "memory"
ARCHIVE_DIR = BASE / "memory_archive"
ARCHIVE_DIR.mkdir(exist_ok=True)

MAX_AGE_DAYS = 7
MIN_SUMMARY_LEN = 120
MIN_FINDINGS = 1
MIN_FACTS = 2


def parse_ts(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def quality_score(mem: Dict[str, Any]) -> int:
    summary = (mem.get("summary") or "").strip()
    findings = mem.get("findings", [])
    facts = sum(len(f.get("key_facts", [])) for f in findings if isinstance(f, dict))
    score = 0
    if len(summary) >= MIN_SUMMARY_LEN:
        score += 1
    if len(findings) >= MIN_FINDINGS:
        score += 1
    if facts >= MIN_FACTS:
        score += 1
    return score


def archive(path: Path, reason: str) -> None:
    target = ARCHIVE_DIR / f"{path.stem}__{reason}{path.suffix}"
    i = 1
    while target.exists():
        target = ARCHIVE_DIR / f"{path.stem}__{reason}_{i}{path.suffix}"
        i += 1
    path.rename(target)


def main() -> None:
    if not MEMORY_DIR.exists():
        print("memory directory not found")
        return

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=MAX_AGE_DAYS)

    entries = []
    for p in MEMORY_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            archive(p, "invalid_json")
            continue

        query = (data.get("query") or "").strip().lower()
        ts = parse_ts(data.get("timestamp", "")) or datetime.fromtimestamp(0, timezone.utc)
        entries.append((p, data, query, ts))

    # Keep highest quality latest file per query.
    best_by_query: Dict[str, tuple] = {}
    for p, data, query, ts in entries:
        key = query or p.stem
        candidate = (quality_score(data), ts, p, data)
        existing = best_by_query.get(key)
        if existing is None or candidate[0] > existing[0] or (candidate[0] == existing[0] and candidate[1] > existing[1]):
            best_by_query[key] = candidate

    keep_paths = {v[2] for v in best_by_query.values()}

    archived = 0
    for p, data, query, ts in entries:
        if p not in keep_paths:
            archive(p, "duplicate")
            archived += 1
            continue

        if ts < cutoff:
            archive(p, "stale")
            archived += 1
            continue

        if quality_score(data) < 3:
            archive(p, "low_quality")
            archived += 1
            continue

        # Extra filter for trivial one-hop factual prompts polluting memory.
        q = query
        if q.startswith("what is the") or q.startswith("who is the"):
            archive(p, "trivial_prompt")
            archived += 1

    print(f"Memory maintenance complete. Archived {archived} files.")


if __name__ == "__main__":
    main()
