"""
scraper/dealer_sites.py — which dealer websites are reachable.

A listing's "View on the dealer's website" link is useless when the dealer's
whole site is down, which a live check found for about a quarter of dealer
sites. The pipeline checks each dealer host once a day (a TCP connect, no
page fetch) and the API hides listings on hosts that are down. Training is
unaffected: this only changes what the public site shows.
"""

import json
import socket
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

DEALER_SITES_PATH = Path("data/dealer_sites.json")


def host_of(url: str | None) -> str | None:
    try:
        return urlparse(url).hostname if url else None
    except ValueError:
        return None


def _reachable(host: str, timeout: float, ports=(443,)) -> bool:
    for port in ports:
        try:
            socket.create_connection((host, port), timeout=timeout).close()
            return True
        except OSError:
            pass
    return False


def find_down(hosts: set[str]) -> list[str]:
    """Hosts that accept no connection. A quick pass, then a slower retry of
    the failures (HTTPS or HTTP) so a momentary blip doesn't hide a dealer."""
    hosts = sorted(h for h in hosts if h)
    with ThreadPoolExecutor(32) as ex:
        first = dict(zip(hosts, ex.map(lambda h: _reachable(h, 8), hosts)))
    maybe = [h for h, ok in first.items() if not ok]
    with ThreadPoolExecutor(16) as ex:
        retry = dict(zip(maybe, ex.map(lambda h: _reachable(h, 15, (443, 80)), maybe)))
    return sorted(h for h, ok in retry.items() if not ok)


def save_down(down: list[str], checked: int, path: Path = DEALER_SITES_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"checked_at": datetime.now(timezone.utc).isoformat(), "hosts_checked": checked, "down": down}, indent=2))
    tmp.replace(path)


def load_down(path: Path = DEALER_SITES_PATH) -> set[str]:
    """Hosts found down by the last check; empty if there was none."""
    try:
        return set(json.loads(path.read_text()).get("down", []))
    except (OSError, ValueError):
        return set()
