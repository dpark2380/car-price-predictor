"""
db/validation.py — runs db/validation.sql and returns its counts.
Run standalone: PYTHONPATH=. python3 -m db.validation
"""

from pathlib import Path

from sqlalchemy import text

VALIDATION_SQL = Path(__file__).with_name("validation.sql")


def run_validation(session) -> dict[str, int]:
    """Execute each statement in validation.sql; merge their single-row results."""
    sql = "\n".join(l for l in VALIDATION_SQL.read_text().splitlines() if not l.strip().startswith("--"))
    counts: dict[str, int] = {}
    for stmt in filter(str.strip, sql.split(";")):
        row = session.execute(text(stmt)).mappings().one()
        counts.update({k: int(v or 0) for k, v in row.items()})
    return counts


if __name__ == "__main__":
    from db.models import init_db, get_session

    for name, n in run_validation(get_session(init_db())).items():
        print(f"{name:<36} {n}")
