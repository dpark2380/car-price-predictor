"""env_utils.py — env var helpers that treat missing/blank values as unset."""

import os


def env_int(name: str, default: int) -> int:
    """int(os.getenv(name)), falling back to default if unset OR blank."""
    val = os.getenv(name)
    if val is None or val.strip() == "":
        return default
    return int(val)
