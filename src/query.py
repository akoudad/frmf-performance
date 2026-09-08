import argparse
import sqlite3
from pathlib import Path

# Locate our SQLite database from anywhere inside the project
ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data/processed/frmf.db"


def run_query(sql):
    # Open database and return rows using column names
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(sql).fetchall()
    conn.close()

    return rows


def print_rows(rows):
    if not rows:
        print("No results.")
        return

    # Print each database row as readable key/value pairs
    for row in rows:
        print(" | ".join(f"{key}: {row[key]}" for key in row.keys()))


def main():
    parser = argparse.ArgumentParser(
        description="Query FRMF football analytics"
    )

    parser.add_argument(
        "command",
        choices=["top-scorers", "red-cards", "injuries"],
        help="Analytics query to run",
    )

    args = parser.parse_args()

    if args.command == "top-scorers":
        sql = """
        SELECT first_name, last_name, goals
        FROM v_player_goals
        ORDER BY goals DESC
        LIMIT 10
        """

    elif args.command == "red-cards":
        sql = """
        SELECT first_name, last_name, red_cards
        FROM v_player_cards
        ORDER BY red_cards DESC
        LIMIT 10
        """

    elif args.command == "injuries":
        sql = """
        SELECT name, injury_events
        FROM v_team_injuries
        ORDER BY injury_events DESC
        """

    print_rows(run_query(sql))


if __name__ == "__main__":
    main()
