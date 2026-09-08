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
        SELECT *
        FROM v_player_goals
        ORDER BY goals DESC
    """,

    "player_cards.csv": """
        SELECT *
        FROM v_player_cards
        ORDER BY red_cards DESC, yellow_cards DESC
    """,

    "team_injuries.csv": """
        SELECT *
        FROM v_team_injuries
        ORDER BY injury_events DESC
    """,

    "matches.csv": """
        SELECT
            m.match_id,
            m.round,
            m.season,
            m.match_date,
            home.name AS home_team,
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

    # cursor.description contains the SQL column names
    columns = [column[0] for column in cursor.description]

    path = EXPORT_DIR / filename

    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)

        writer.writerow(columns)   # CSV header
        writer.writerows(rows)     # CSV data

    print(f"Exported {filename}: {len(rows)} rows")


def main():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)

    for filename, sql in EXPORTS.items():
        export_csv(conn, filename, sql)

    conn.close()


if __name__ == "__main__":
    main()
