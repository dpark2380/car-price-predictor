# scraper/api_usage.py
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

USAGE_PATH = Path("data/api_usage.json")
NY_TZ = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class ApiCallEvent:
    provider: str
    endpoint: str


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


def increment_call(event: ApiCallEvent, n: int = 1) -> None:
    """
    Increment usage counters for an API call.
    Stored in data/api_usage.json.

    Structure:
    {
      "total": 123,
      "days": {
        "2026-02-27": {
          "total": 12,
          "providers": {"marketcheck": 12},
          "endpoints": {"/search/car/active": 6, "/search/car/recent": 6}
        }
      }
    }
    """
    if n <= 0:
        return

    usage = _read_usage()
    day = _today_key()

    usage.setdefault("total", 0)
    usage.setdefault("days", {})

    day_obj = usage["days"].setdefault(day, {})
    day_obj.setdefault("total", 0)
    day_obj.setdefault("providers", {})
    day_obj.setdefault("endpoints", {})

    usage["total"] += n
    day_obj["total"] += n

    prov = event.provider.lower().strip() or "unknown"
    ep = event.endpoint.strip() or "unknown"

    day_obj["providers"][prov] = int(day_obj["providers"].get(prov, 0)) + n
    day_obj["endpoints"][ep] = int(day_obj["endpoints"].get(ep, 0)) + n

    _atomic_write(USAGE_PATH, usage)