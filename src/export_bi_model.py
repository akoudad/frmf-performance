"""Export five detailed, ID-safe tables for the FRMF Power BI model.

Save as src/export_bi_model.py and run from the project folder:
    python -m src.export_bi_model

Prerequisites: the existing DB, enrich_metadata.py, and reporting_views.sql.
Uses the same v_player_match/v_team_match views as the assistant, checks them
against base records, then exports CSVs. Does NOT rebuild/update the database,
change the assistant, upload data, or refresh an existing Power BI report.
All generated files belong in the Git-ignored data/ folder.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data/processed/frmf.db"
EXPORT_DIR = ROOT / "data/exports/bi_model"

# dim = one identity/context row. fact = one observation at a stated grain.
# Keep IDs for relationships; the unique player_label is for chart display.
EXPORTS = {
    "dim_player": """
        SELECT player_id, first_name, last_name,
               TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS player_name,
               TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
                   || ' · ' || CAST(player_id AS TEXT) AS player_label
        FROM players ORDER BY player_id
    """,
    "dim_team": """
        SELECT team_id, name AS team_name,
               name || ' · ' || CAST(team_id AS TEXT) AS team_label
        FROM teams ORDER BY team_id
    """,
    "dim_match": """
        SELECT m.match_id, m.competition_id, m.competition_name, m.season,
               m.round AS round_label, m.round_number, m.match_date,
               m.match_status, m.stadium_id, m.stadium_name,
               m.scheduled_kickoff, m.reported_start_time, m.reported_end_time,
               m.closed_door, m.home_team_id, h.name AS home_team_name,
               m.away_team_id, a.name AS away_team_name,
               h.name || ' vs ' || a.name || ' · ' || m.match_id AS match_label
        FROM matches m
        JOIN teams h ON h.team_id = m.home_team_id
        JOIN teams a ON a.team_id = m.away_team_id
        ORDER BY m.match_date, m.round_number, m.match_id
    """,
    "fact_player_match": """
        SELECT v.match_id, v.player_id, v.team_id,
               v.role, v.position, v.captain AS captain_selection,
               r.age_at_match, r.nationality_source, r.shirt_number,
               1 AS squad_selection,
               CASE WHEN v.role = 'starter' THEN 1 ELSE 0 END AS starter_selection,
               CASE WHEN v.role = 'substitute' THEN 1 ELSE 0 END AS bench_selection,
               v.subbed_in AS recorded_sub_in,
               v.goals AS recorded_goals, v.own_goals AS own_goal_records,
               v.yellow_cards AS recorded_yellow_cards,
               v.red_cards AS recorded_red_cards,
               v.injury_events AS recorded_injury_events
        FROM v_player_match v
        JOIN rosters r ON r.match_id = v.match_id
                      AND r.team_id = v.team_id AND r.player_id = v.player_id
        ORDER BY v.match_id, v.team_id, v.player_id
    """,
    "fact_team_match": """
        SELECT v.match_id, v.team_id, v.opponent_id, v.opponent_name,
               v.venue_role,
               1 AS recorded_match,
               v.goals_for AS reported_goals_for,
               v.goals_against AS reported_goals_against,
               v.goals_for - v.goals_against AS goal_difference,
               v.result AS reported_result,
               CASE WHEN v.result = 'WIN' THEN 1 ELSE 0 END AS win_flag,
               CASE WHEN v.result = 'DRAW' THEN 1 ELSE 0 END AS draw_flag,
               CASE WHEN v.result = 'LOSS' THEN 1 ELSE 0 END AS loss_flag,
               CASE WHEN v.goals_against = 0 THEN 1 ELSE 0 END AS clean_sheet_flag,
               v.yellow_cards AS recorded_yellow_cards,
               v.red_cards AS recorded_red_cards,
               v.injury_events AS recorded_injury_events
        FROM v_team_match v ORDER BY v.match_id, v.team_id
    """,
}

# These model-building instructions carry no record-level values.
MODEL_NOTES = """# FRMF detailed Power BI export

## Scope
Five CSV tables for the current supplied snapshot. Import them TOGETHER into
one authorized Power BI semantic model. This script does not refresh cloud
copies. Existing prototype CSV files and reports have not been changed.

## Relationships (one-to-many, active, SINGLE direction from dimension to fact)
- dim_player.player_id -> fact_player_match.player_id
- dim_team.team_id -> fact_player_match.team_id
- dim_team.team_id -> fact_team_match.team_id
- dim_match.match_id -> fact_player_match.match_id
- dim_match.match_id -> fact_team_match.match_id

Do not relate the two facts directly. Do not automatically create additional
active relationships on home_team_id, away_team_id, or opponent_id. They are
context/role columns here. Later an explicit Opponent dimension can be added
for head-to-head comparison; do not make a second ambiguous team filter path.
Do not relate dimensions to the old totals tables to build these report pages.

## Types and filtering
Set match_id to Text in ALL three related tables. Use Whole number for player_id
and team_id in all related tables; do NOT summarize IDs. Match date = Date.
Round number = Whole number. Sort round_label by round_number after confirming
that each label maps to one number. Unnumbered future competition stages need
an explicit stage/order mapping, not a guessed number.
Shirt number and nationality_source are Text, age_at_match is Whole number.
Source kickoff/end times are reported metadata, not reliable event durations.

Use dim_match.competition_name, season, round_number and match_date for shared
filters. dim_team filters both facts. dim_player and player-specific properties
filter PLAYER analysis only; they must not imply that team results or team
conceded goals are attributable to one player. Age, nationality and position
are recorded at each match, not timeless player attributes.

A team filter does not directly filter dim_player under these one-way links.
For a team roster visual, include a fact measure such as Squad selections and
filter that visual to > 0. Do not enable bidirectional relationships as a shortcut.
Likewise, use a fact-based measure to restrict match lists to a selected team.

## Suggested measures (DAX to create later, not applied by this script)
Matches = DISTINCTCOUNT(fact_team_match[match_id])
Team matches = COUNTROWS(fact_team_match)
Selected players = DISTINCTCOUNT(fact_player_match[player_id])
Squad selections = SUM(fact_player_match[squad_selection])
Team goals = SUM(fact_team_match[reported_goals_for])
Player goals = SUM(fact_player_match[recorded_goals])
Goals per match = DIVIDE([Team goals], [Matches])
Wins = SUM(fact_team_match[win_flag])
Win rate = DIVIDE([Wins], [Team matches])

One match has TWO team rows, so COUNTROWS(fact_team_match) is NOT the league's
match count. Win rate uses team-match opportunities, not distinct league games.
Do not sum counts from both facts. Player goals and team reported scores are
different metrics: own-goal records are excluded from player goals and the
source's own-goal attribution is unresolved. Rates should be ratios of sums
under the selected filters, not averages of precomputed row ratios.

## Source limitations remain
Recorded goals = REGULAR + PENALTY, by player ID. Same-name players stay distinct.
Use player_label on chart axes; names alone can merge different people.
Recorded cards do not establish suspensions. Injury events do not establish
current injury status or days unavailable. Zero means no matching RECORDED event,
not proof of complete capture. Squad selection or bench selection is not an
appearance. Timings/dismissals conflict, so minutes/per-90 remain unavailable.
Age is completed years AT THE MATCH DATE from demonstration birth dates; never
label it current age. Exact birth dates and licences are not included.
Detailed event timelines remain in SQLite and are not among these five CSVs.

There is currently one competition-season. These filters prepare for more, but
new data still needs a reviewed import/ID/update contract. IDs are assumed
unique within the current source namespace. Do not concatenate unrelated exports
from different systems using bare numeric IDs. Unknown or unplayed match statuses
need a reviewed metric contract; this exporter deliberately refuses them for now.

## Development workflow
The old ingest.py deletes and rebuilds the DB. It would remove enrichment and
reporting views. Do not run it as the routine refresh until it is consolidated.
For this step: enrich existing DB -> check views -> export detailed model.
No external service is called. Upload/export permissions are separate from Git
privacy. Keep these generated files in ignored local storage.
"""


def require(condition: bool, message: str) -> None:
    """Use real checks, not assert (which Python can disable)."""
    if not condition:
        raise ValueError(message)


def fetch(conn: sqlite3.Connection, sql: str) -> tuple[list[str], list[dict]]:
    cursor = conn.execute(sql)
    columns = [c[0] for c in cursor.description]
    return columns, [dict(row) for row in cursor.fetchall()]


def indexed(rows: list[dict], columns: tuple[str, ...], label: str) -> dict:
    """Require one non-null key per row, so joins cannot silently multiply it."""
    result = {}
    for row in rows:
        key = tuple(row[column] for column in columns)
        require(all(value is not None for value in key), f"Null key in {label}.")
        require(key not in result, f"Duplicate key in {label}.")
        result[key] = row
    return result


def check_prerequisites(conn: sqlite3.Connection) -> None:
    require(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
            "Database integrity check failed.")
    # First access validates that these are the existing views, not newly invented ones.
    for name in ("v_player_match", "v_team_match"):
        found = conn.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name=?", (name,)).fetchone()
        require(found is not None,
                f"Missing {name}. Load sql/reporting_views.sql before exporting.")
    for table, needed in {
        "matches": {"competition_id", "competition_name", "round_number", "match_status",
                    "stadium_id", "stadium_name", "scheduled_kickoff", "reported_start_time",
                    "reported_end_time", "closed_door"},
        "rosters": {"age_at_match", "nationality_source", "shirt_number"},
    }.items():
        existing = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
        require(needed <= existing,
                f"Missing metadata in {table}; run python -m src.enrich_metadata first.")
    require(conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] > 0,
            "The database contains no matches.")
    # Our current views assume scores are final. Reject new statuses instead of guessing.
    invalid = conn.execute("""
        SELECT COUNT(*) FROM matches
        WHERE match_status IS NULL OR match_status != 'PLAYED'
           OR home_score IS NULL OR away_score IS NULL
           OR home_score < 0 OR away_score < 0
           OR competition_id IS NULL OR competition_name IS NULL OR season IS NULL
    """).fetchone()[0]
    require(invalid == 0, "Missing competition metadata or unplayed/invalid scores: review the import before exporting.")


def validate(conn: sqlite3.Connection, tables: dict[str, tuple[list[str], list[dict]]]) -> None:
    """Check every exported fact's grain and event counts against base-table records.

    These are import/model checks, NOT a certification of sporting correctness.
    Known source chronology/own-goal problems are preserved, not silently fixed.
    """
    rows = {name: data[1] for name, data in tables.items()}
    players = indexed(rows["dim_player"], ("player_id",), "dim_player")
    teams = indexed(rows["dim_team"], ("team_id",), "dim_team")
    match_dim = indexed(rows["dim_match"], ("match_id",), "dim_match")
    player_facts = indexed(rows["fact_player_match"], ("match_id", "team_id", "player_id"), "fact_player_match")
    team_facts = indexed(rows["fact_team_match"], ("match_id", "team_id"), "fact_team_match")
    indexed(rows["dim_player"], ("player_label",), "player display labels")
    require(set(players) == {(r[0],) for r in conn.execute("SELECT player_id FROM players")}, "Player export coverage mismatch.")
    require(set(teams) == {(r[0],) for r in conn.execute("SELECT team_id FROM teams")}, "Team export coverage mismatch.")
    matches = {r["match_id"]: dict(r) for r in conn.execute("SELECT * FROM matches")}
    require(set(match_dim) == {(mid,) for mid in matches}, "Match export coverage mismatch.")
    rosters = [dict(r) for r in conn.execute("SELECT * FROM rosters")]
    expected_rosters = indexed(rosters, ("match_id", "team_id", "player_id"), "source rosters")
    membership = indexed(rosters, ("match_id", "player_id"), "player's team in a match")
    require(set(player_facts) == set(expected_rosters), "Player-match export coverage mismatch.")
    expected_team_keys = {(m["match_id"], m[side + "_team_id"]) for m in matches.values() for side in ("home", "away")}
    require(set(team_facts) == expected_team_keys, "Team-match export coverage mismatch.")

    player_counts, team_counts = defaultdict(Counter), defaultdict(Counter)

    def roster_for(mid, pid):
        require((mid, pid) in membership, "An event participant has no matching roster record.")
        return membership[(mid, pid)]

    # Count each base event once, before combining metrics. This avoids join fan-out.
    for g in conn.execute("SELECT * FROM goals"):
        roster_for(g["match_id"], g["player_id"])
        require(g["type"] in {"REGULAR", "PENALTY", "OWN_GOAL"}, "Unknown goal type; update the metric contract.")
        metric = "own_goal_records" if g["type"] == "OWN_GOAL" else "recorded_goals"
        player_counts[(g["match_id"], g["player_id"])][metric] += 1
    for c in conn.execute("SELECT * FROM cards"):
        r = roster_for(c["match_id"], c["player_id"])
        require(c["type"] in {"RED", "YELLOW"}, "Unknown card type; update the metric contract.")
        metric = "recorded_red_cards" if c["type"] == "RED" else "recorded_yellow_cards"
        player_counts[(c["match_id"], c["player_id"])][metric] += 1
        team_counts[(c["match_id"], r["team_id"])][metric] += 1
    for i in conn.execute("SELECT * FROM injuries"):
        r = roster_for(i["match_id"], i["player_id"])
        require(i["team_id"] == r["team_id"], "Injury team disagrees with match roster.")
        player_counts[(i["match_id"], i["player_id"])]["recorded_injury_events"] += 1
        team_counts[(i["match_id"], i["team_id"])]["recorded_injury_events"] += 1
    subins = Counter()
    for s in conn.execute("SELECT * FROM substitutions"):
        incoming = roster_for(s["match_id"], s["player_in_id"])
        outgoing = roster_for(s["match_id"], s["player_out_id"])
        require(incoming["team_id"] == outgoing["team_id"], "Substitution crosses teams.")
        subins[(s["match_id"], s["player_in_id"])] += 1
    require(all(n == 1 for n in subins.values()), "Repeated sub-in requires a reviewed participation definition.")

    player_metrics = ("recorded_goals", "own_goal_records", "recorded_yellow_cards", "recorded_red_cards", "recorded_injury_events")
    for key, f in player_facts.items():
        mid, tid, pid = key
        r = expected_rosters[key]
        require((pid,) in players and (tid,) in teams and mid in matches, "Broken player fact relationship.")
        m = matches[mid]
        require(tid in {m["home_team_id"], m["away_team_id"]}, "Roster team is not a match participant.")
        require(r["role"] in {"starter", "substitute"}, "Unknown roster role.")
        require(all(f[metric] == player_counts[(mid, pid)][metric] for metric in player_metrics),
                "Player event totals in reporting view disagree with base tables.")
        require(f["recorded_sub_in"] == subins[(mid, pid)], "Sub-in view disagrees with base records.")
        require(f["squad_selection"] == 1 and f["starter_selection"] == int(r["role"] == "starter")
                and f["bench_selection"] == int(r["role"] == "substitute"), "Selection flags disagree with roster.")
        require(f["captain_selection"] == r["captain"], "Captain flag mismatch.")
        for column in ("role", "position", "age_at_match", "nationality_source", "shirt_number"):
            require(f[column] == r[column], f"Roster metadata mismatch: {column}.")

    for (mid, tid), f in team_facts.items():
        m = matches[mid]
        require(m["home_team_id"] != m["away_team_id"], "A match lists the same team twice.")
        home = tid == m["home_team_id"]
        gf = m["home_score"] if home else m["away_score"]
        ga = m["away_score"] if home else m["home_score"]
        opponent = m["away_team_id"] if home else m["home_team_id"]
        result = "WIN" if gf > ga else "LOSS" if gf < ga else "DRAW"
        expected = {
            "opponent_id": opponent, "opponent_name": teams[(opponent,)]["team_name"],
            "venue_role": "HOME" if home else "AWAY", "recorded_match": 1,
            "reported_goals_for": gf, "reported_goals_against": ga,
            "goal_difference": gf - ga, "reported_result": result,
            "win_flag": int(gf > ga), "draw_flag": int(gf == ga),
            "loss_flag": int(gf < ga), "clean_sheet_flag": int(ga == 0),
        }
        for metric in ("recorded_yellow_cards", "recorded_red_cards", "recorded_injury_events"):
            expected[metric] = team_counts[(mid, tid)][metric]
        require(all(f[k] == v for k, v in expected.items()), "Team reporting view disagrees with base records.")


def export_model(db_path: Path, output: Path) -> dict[str, int]:
    require(db_path.is_file(), "Existing database not found; no empty DB will be created.")
    # URL-encode paths safely, including spaces, and open the DB read-only.
    conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row  # Access returned columns by name, not numeric position.
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")  # All exports read one consistent DB snapshot.
        check_prerequisites(conn)
        tables = {name: fetch(conn, query) for name, query in EXPORTS.items()}
        validate(conn, tables)
    finally:
        conn.close()

    # Nothing is written until all queries and validation checks have succeeded.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".bi-export-", dir=output.parent) as tmp:
        staging = Path(tmp)
        for name, (columns, rows) in tables.items():
            # UTF-8 with BOM lets Power BI recognize accents on upload.
            with (staging / f"{name}.csv").open("w", encoding="utf-8-sig", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=columns)
                writer.writeheader()   # One line of column names.
                writer.writerows(rows) # Data rows. None becomes blank, not fake zero.
        (staging / "MODEL_NOTES.md").write_text(MODEL_NOTES, encoding="utf-8")
        counts = {name: len(data[1]) for name, data in tables.items()}
        (staging / "export_info.json").write_text(json.dumps({
            "exported_at_utc": datetime.now(timezone.utc).isoformat(),
            "model_version": 1,
            "rows": counts,
            "validation": "Unique grains, roster references and per-entity event counts checked against base tables.",
            "source_caveat": "Demo snapshot: sporting validity, own-goal attribution and timing unresolved.",
        }, indent=2) + "\n", encoding="utf-8")
        output.mkdir(parents=True, exist_ok=True)
        # Replace each generated file only after its complete content is written.
        # Reimport all five CSVs together; Power BI's cloud copy is not auto-refreshed.
        for path in sorted(staging.iterdir()):
            os.replace(path, output / path.name)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DB_PATH, help="Existing enriched SQLite database")
    parser.add_argument("--output", type=Path, default=EXPORT_DIR, help="Folder for generated BI files")
    args = parser.parse_args()
    try:
        counts = export_model(args.db, args.output)
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f"STOPPED: {error}", file=sys.stderr)
        sys.exit(1)
    print("Detailed BI export complete.")
    for name, count in counts.items():
        print(f"{name}.csv: {count:,} rows")
    print("Checks passed: unique keys, roster links and per-row metrics.")
    print("Database and existing AI code unchanged.")
    print(f"Files: {args.output}")
    print("Next: import the five CSVs into one approved Power BI model; use MODEL_NOTES.md for relationships.")


if __name__ == "__main__":
    main()
