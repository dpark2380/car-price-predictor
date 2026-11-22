# scraper/api_usage.py
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

USAGE_PATH = Path("data/api_usage.json")
NY_TZ = ZoneInfo("America/New_York")


def _today_key() -> str:
    return datetime.now(NY_TZ).strftime("%Y-%m-%d")


def _read_usage() -> dict:
    if not USAGE_PATH.exists():
        return {"days": {}, "total": 0}
    try:
        return json.loads(USAGE_PATH.read_text())
    except Exception:
        # If file is corrupted, don't crash the pipeline
        return {"days": {}, "total": 0}


def _atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True))
    os.replace(tmp_path, path)


def increment_call(n: int = 1) -> None:
    """Add n MarketCheck calls to today's total in data/api_usage.json:
    {"total": 123, "days": {"2026-02-27": {"total": 12}}}"""
    if n <= 0:
        return

    usage = _read_usage()
    usage.setdefault("total", 0)
    day_obj = usage.setdefault("days", {}).setdefault(_today_key(), {"total": 0})
    usage["total"] += n
    day_obj["total"] = day_obj.get("total", 0) + n

    _atomic_write(USAGE_PATH, usage)


def month_total() -> int:
    """Calls recorded so far this calendar month (New York time, like the day keys)."""
    month = _today_key()[:7]
    return sum(int(d.get("total", 0)) for day, d in _read_usage().get("days", {}).items()
               if day.startswith(month))
