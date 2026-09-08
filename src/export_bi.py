import csv
import sqlite3
from pathlib import Path

# Project paths
ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data/processed/frmf.db"
EXPORT_DIR = ROOT / "data/exports"


# CSV filename -> SQL query used to generate it
EXPORTS = {
    "player_goals.csv": """
        SELECT
            player_id,
            first_name || ' ' || last_name || ' · ' || player_id AS player_label,
            goals,
            ROW_NUMBER() OVER (
                ORDER BY goals DESC, player_id ASC
            ) AS rank
        FROM v_player_goals
        ORDER BY rank
    """,

    "player_cards.csv": """
        SELECT
            player_id,
            first_name || ' ' || last_name || ' · ' || player_id AS player_label,
            yellow_cards,
            red_cards
        FROM v_player_cards
        ORDER BY red_cards DESC, yellow_cards DESC, player_id ASC
    """,

    "team_injuries.csv": """
        SELECT
            team_id,
            name AS team_name,
            injury_events
        FROM v_team_injuries
        ORDER BY injury_events DESC, team_id ASC
    """,

    "matches.csv": """
        SELECT
            m.match_id,
            m.round,
            m.season,
            m.match_date,
            m.home_team_id,
            home.name AS home_team,
            m.away_team_id,
            away.name AS away_team,
            m.home_score,
            m.away_score
        FROM matches m
        JOIN teams home ON home.team_id = m.home_team_id
        JOIN teams away ON away.team_id = m.away_team_id
        ORDER BY m.match_date, m.match_id
    """
}


def export_csv(conn, filename, sql):
    cursor = conn.execute(sql)
    rows = cursor.fetchall()

    # Get SQL column names automatically
    columns = [column[0] for column in cursor.description]

    path = EXPORT_DIR / filename

    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)

        writer.writerow(columns)   # CSV header
        writer.writerows(rows)     # CSV rows

    print(f"Exported {filename}: {len(rows)} rows")


def main():
    # Make sure export folder exists
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    # Connect to our SQLite database
    conn = sqlite3.connect(DB_PATH)

    # Generate every Power BI CSV
    for filename, sql in EXPORTS.items():
        export_csv(conn, filename, sql)

    conn.close()


if __name__ == "__main__":
    main()