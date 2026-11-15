"""Add source-backed BI metadata to the existing FRMF SQLite database.

This is an incremental development step, not a replacement importer.
It verifies that the source matches the existing database, makes a local
backup, then updates metadata in one transaction. Existing tables, events,
views and application code are preserved.

Age means completed years ON THE MATCH DATE, calculated from the supplied
birthDate. Exact birth dates and licence numbers are NOT copied into SQLite.
Anonymized source attributes are demonstration values, not verified facts
about real people. No cloud services or model APIs are called.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/raw/Matches_30J_FEMININ_D1.json"
DEFAULT_DB = ROOT / "data/processed/frmf.db"

# Compare only the columns the original importer writes. IDs identify rows.
BASE_COLUMNS = {
    "teams": ("team_id", "name"),
    "players": ("player_id", "first_name", "last_name", "position"),
    "matches": (
        "match_id", "round", "season", "match_date", "home_team_id",
        "away_team_id", "home_score", "away_score",
    ),
    "rosters": ("match_id", "team_id", "player_id", "role", "position", "captain"),
    "goals": ("match_id", "player_id", "team_id", "type", "minute"),
    "cards": ("match_id", "player_id", "type", "minute", "reason"),
    "injuries": ("match_id", "player_id", "team_id", "minute", "reason"),
    "substitutions": ("match_id", "player_in_id", "player_out_id", "minute"),
}

# Added columns are descriptive metadata, not newly invented sporting events.
EXTRA_COLUMNS = {
    "matches": {
        "competition_id": "INTEGER",
        "competition_name": "TEXT",
        "round_number": "INTEGER",
        "match_status": "TEXT",
        "stadium_id": "INTEGER",
        "stadium_name": "TEXT",
        "scheduled_kickoff": "TEXT",
        "reported_start_time": "TEXT",
        "reported_end_time": "TEXT",
        "closed_door": "INTEGER",
    },
    "rosters": {
        "age_at_match": "INTEGER",
        "nationality_source": "TEXT",
        "shirt_number": "TEXT",
    },
}


def quote_name(name: str) -> str:
    """Quote an SQL identifier; SQL values are passed with ? placeholders."""
    return '"' + name.replace('"', '""') + '"'


def load_matches(path: Path) -> list[dict]:
    """Load this small NDJSON snapshot: one JSON object per nonblank line."""
    matches = []
    seen_ids = set()
    with path.open(encoding="utf-8-sig") as source:
        # enumerate(..., start=1) gives useful line numbers for parse errors.
        for line_number, line in enumerate(source, start=1):
            line = line.strip()  # Remove surrounding whitespace/newlines.
            if not line:
                continue  # Skip blank lines.
            try:
                match = json.loads(line)  # JSON text -> Python dictionary.
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON at source line {line_number}.") from error
            if not isinstance(match, dict) or "match_id" not in match:
                raise ValueError(f"Expected a match object at source line {line_number}.")
            match_id = str(match["match_id"])
            if match_id in seen_ids:
                raise ValueError("Source contains repeated match IDs; reconcile exports first.")
            seen_ids.add(match_id)
            matches.append(match)
    if not matches:
        raise ValueError("Source contains no match records.")
    return matches


def expected_base_rows(matches: list[dict]) -> dict[str, Counter]:
    """Independently reproduce the original import contract for comparison.

    Counter is a multiset: duplicate event rows are counted, not removed.
    This guards against combining metadata from a new export with old stats.
    """
    expected = {table: Counter() for table in BASE_COLUMNS}
    teams, players = {}, {}
    for match in matches:
        mid = str(match["match_id"])
        for side in ("homeTeam", "awayTeam"):
            # setdefault retains the first value, as the original importer did.
            tid = match[f"{side}_id"]
            teams.setdefault(tid, (tid, match[side]))
        expected["matches"][(
            mid, match["round"], match["season"], match["match_date"],
            match["homeTeam_id"], match["awayTeam_id"],
            match["homeTeamScore"], match["awayTeamScore"],
        )] += 1
        for side in ("homeTeam", "awayTeam"):
            lineup = match["lineups"][side]
            tid = lineup["team_id"]
            if tid != match[f"{side}_id"]:
                raise ValueError("Source lineup team disagrees with match metadata.")
            for role, source_key in (("starter", "starters"), ("substitute", "substitutes")):
                for player in lineup[source_key]:
                    pid = player["joueur_id"]
                    players.setdefault(pid, (
                        pid, player.get("firstName"), player.get("lastName"),
                        player.get("position"),
                    ))
                    expected["rosters"][(
                        mid, tid, pid, role, player.get("position"),
                        int(player.get("captain", False)),
                    )] += 1
        events = match["events"]
        for goal in events["goals"]:
            expected["goals"][(mid, goal["scorer"]["joueur_id"], goal["team_id"],
                               goal["type"], int(goal["minute"]))] += 1
        for card in events["cards"]:
            reason = card["motifs"][0]["title"] if card.get("motifs") else None
            expected["cards"][(mid, card["user_id"], card["type"],
                               int(card["minute"]), reason)] += 1
        for injury in events["injuries"]:
            expected["injuries"][(mid, injury["joueur_id"], injury["team_id"],
                                  int(injury["minute"]), injury.get("reason"))] += 1
        for sub in events["substitutions"]:
            expected["substitutions"][(mid, sub["playerIn"]["joueur_id"],
                                       sub["playerOut"]["joueur_id"], int(sub["minute"]))] += 1
    expected["teams"].update(teams.values())
    expected["players"].update(players.values())
    return expected


def verify_base(conn: sqlite3.Connection, expected: dict[str, Counter]) -> None:
    """Require equality of imported values, not just equality of row counts."""
    for table, columns in BASE_COLUMNS.items():
        column_sql = ", ".join(quote_name(column) for column in columns)
        observed = Counter(conn.execute(f"SELECT {column_sql} FROM {quote_name(table)}"))
        if observed != expected[table]:
            raise ValueError(
                f"Source/DB mismatch in {table}. No metadata was saved. "
                "Check that both describe the same export; do not overwrite manually corrected data."
            )


def age_on_match_date(raw_birth_date: str | None, match_date: str) -> int | None:
    """Completed calendar years on the match date; missing stays None, not 0."""
    if not raw_birth_date:
        return None
    born = date.fromisoformat(raw_birth_date)
    played = date.fromisoformat(match_date)
    if born > played:
        raise ValueError("A source birth date occurs after its match date.")
    # Subtract one year if the birthday has not happened yet that year.
    return played.year - born.year - ((played.month, played.day) < (born.month, born.day))


def metadata_rows(matches: list[dict]) -> tuple[list[tuple], list[tuple]]:
    """Prepare source-backed metadata; do not infer first/return leg."""
    match_rows, roster_rows = [], []
    competition_labels = {}
    for match in matches:
        mid = str(match["match_id"])
        round_text = str(match["round"])
        round_match = re.fullmatch(r"J(\d+)", round_text)
        # Numeric rounds allow J2 to sort before J10. Other labels stay text.
        round_number = int(round_match.group(1)) if round_match else None
        competition_id, label = match["competition_id"], match["competition"]
        if competition_id in competition_labels and competition_labels[competition_id] != label:
            raise ValueError("One competition ID has conflicting labels; ask the source owner.")
        competition_labels[competition_id] = label
        match_rows.append((
            competition_id, label, round_number, match["match_status"],
            match.get("stadium_id"), match.get("stadium"), match.get("match_time"),
            match.get("startTime"), match.get("endTime"),
            int(match["closed_door"]) if match.get("closed_door") is not None else None,
            mid,
        ))
        for side in ("homeTeam", "awayTeam"):
            lineup = match["lineups"][side]
            for role in ("starters", "substitutes"):
                for player in lineup[role]:
                    roster_rows.append((
                        age_on_match_date(player.get("birthDate"), match["match_date"]),
                        player.get("nationality"), player.get("shirtNumber"),
                        mid, lineup["team_id"], player["joueur_id"],
                    ))
    return match_rows, roster_rows


def ensure_columns(conn: sqlite3.Connection) -> None:
    """ALTER TABLE adds only absent columns, making repeated runs safe."""
    for table, definitions in EXTRA_COLUMNS.items():
        existing = {
            row[1]: row[2].upper()
            for row in conn.execute(f"PRAGMA table_info({quote_name(table)})")
        }
        for column, sql_type in definitions.items():
            if column not in existing:
                conn.execute(
                    f"ALTER TABLE {quote_name(table)} "
                    f"ADD COLUMN {quote_name(column)} {sql_type}"
                )
            elif existing[column] != sql_type:
                raise ValueError(f"Unexpected type for {table}.{column}; no changes saved.")


def make_backup(conn: sqlite3.Connection, db_path: Path) -> Path:
    """SQLite's backup API copies the DB, including existing views, locally."""
    directory = db_path.parent / "backups"
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_path = directory / f"{db_path.stem}_before_metadata_{stamp}.db"
    backup_conn = sqlite3.connect(backup_path)
    try:
        conn.backup(backup_conn)
    finally:
        backup_conn.close()
    return backup_path


def enrich(source_path: Path, db_path: Path) -> dict:
    matches = load_matches(source_path)
    expected = expected_base_rows(matches)
    match_rows, roster_rows = metadata_rows(matches)
    if not db_path.is_file():
        raise FileNotFoundError("Existing frmf.db not found. This script does not create a blank DB.")

    # mode=rw allows our migration to update an EXISTING DB, not create a new one.
    # This developer-only connection is separate from the AI read-only executor.
    conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=rw", uri=True, timeout=10)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        verify_base(conn, expected)
        backup_path = make_backup(conn, db_path)
        conn.execute("BEGIN IMMEDIATE")  # Start one transaction before any schema changes.
        try:
            verify_base(conn, expected)  # Recheck after obtaining the write lock.
            ensure_columns(conn)
            conn.executemany("""
                UPDATE matches SET
                    competition_id=?, competition_name=?, round_number=?,
                    match_status=?, stadium_id=?, stadium_name=?, scheduled_kickoff=?,
                    reported_start_time=?, reported_end_time=?, closed_door=?
                WHERE match_id=?
            """, match_rows)
            conn.executemany("""
                UPDATE rosters SET age_at_match=?, nationality_source=?, shirt_number=?
                WHERE match_id=? AND team_id=? AND player_id=?
            """, roster_rows)
            verify_base(conn, expected)  # Assert all previously imported values remain unchanged.
            if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Database integrity check failed.")
            conn.commit()  # Save only after every operation/check succeeds.
        except BaseException:
            conn.rollback()  # Undo ALL metadata/schema changes on error or interruption.
            raise
        return {
            "matches": len(match_rows),
            "roster_rows": len(roster_rows),
            "competition_seasons": len({(m["competition_id"], m["season"]) for m in matches}),
            "backup": backup_path,
        }
    finally:
        conn.close()  # Always release the DB connection, including on errors.


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Path to the original NDJSON")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to the existing SQLite database")
    args = parser.parse_args()
    try:
        result = enrich(args.source, args.db)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f"STOPPED: {error}", file=sys.stderr)
        sys.exit(1)
    print("Metadata upgrade complete.")
    print(f"Matches enriched: {result['matches']}")
    print(f"Player-match roster rows enriched: {result['roster_rows']}")
    print(f"Competition/season combinations: {result['competition_seasons']}")
    print("Previously imported data and existing SQL views preserved.")
    print("Age is at match date; exact birth dates and licences were not imported.")
    print(f"Local backup: {result['backup']}")
    print("Next: include these fields in the detailed Power BI views/exports.")


if __name__ == "__main__":
    main()
