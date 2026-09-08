import json
import sqlite3
from pathlib import Path

# Project paths
ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data/raw/Matches_30J_FEMININ_D1.json"
DB_PATH = ROOT / "data/processed/frmf.db"
SCHEMA_PATH = ROOT / "sql/schema.sql"


def read_matches():
    # NDJSON = one JSON match per line
    with DATA_PATH.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()  # remove surrounding whitespace
            if line:
                yield json.loads(line)  # return one parsed match at a time


def main():
    # Rebuild database from scratch during development
    if DB_PATH.exists():
        DB_PATH.unlink()

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Opening a missing SQLite file creates it
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")

    # Create database tables
    with SCHEMA_PATH.open("r", encoding="utf-8") as file:
        conn.executescript(file.read())

    for match in read_matches():
        match_id = match["match_id"]

        # Teams
        conn.execute(
            "INSERT OR IGNORE INTO teams (team_id, name) VALUES (?, ?)",
            (match["homeTeam_id"], match["homeTeam"]),
        )
        conn.execute(
            "INSERT OR IGNORE INTO teams (team_id, name) VALUES (?, ?)",
            (match["awayTeam_id"], match["awayTeam"]),
        )

        # Matches
        conn.execute(
            """
            INSERT INTO matches (
                match_id, round, season, match_date,
                home_team_id, away_team_id,
                home_score, away_score
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                match_id,
                match["round"],
                match["season"],
                match["match_date"],
                match["homeTeam_id"],
                match["awayTeam_id"],
                match["homeTeamScore"],
                match["awayTeamScore"],
            ),
        )

        # Players + match rosters
        for side in ("homeTeam", "awayTeam"):
            lineup = match["lineups"][side]
            team_id = lineup["team_id"]

            for role, players in (
                ("starter", lineup["starters"]),
                ("substitute", lineup["substitutes"]),
            ):
                for player in players:
                    player_id = player["joueur_id"]

                    conn.execute(
                        """
                        INSERT OR IGNORE INTO players
                        (player_id, first_name, last_name, position)
                        VALUES (?, ?, ?, ?)
                        """,
                        (
                            player_id,
                            player.get("firstName"),
                            player.get("lastName"),
                            player.get("position"),
                        ),
                    )

                    conn.execute(
                        """
                        INSERT INTO rosters
                        (match_id, team_id, player_id, role, position, captain)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            match_id,
                            team_id,
                            player_id,
                            role,
                            player.get("position"),
                            int(player.get("captain", False)),
                        ),
                    )

        events = match["events"]

        # Goals
        for goal in events["goals"]:
            conn.execute(
                """
                INSERT INTO goals
                (match_id, player_id, team_id, type, minute)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    match_id,
                    goal["scorer"]["joueur_id"],
                    goal["team_id"],
                    goal["type"],
                    int(goal["minute"]),
                ),
            )

        # Cards
        for card in events["cards"]:
            reason = card["motifs"][0]["title"] if card.get("motifs") else None

            conn.execute(
                """
                INSERT INTO cards
                (match_id, player_id, type, minute, reason)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    match_id,
                    card["user_id"],
                    card["type"],
                    int(card["minute"]),
                    reason,
                ),
            )

        # Injuries
        for injury in events["injuries"]:
            conn.execute(
                """
                INSERT INTO injuries
                (match_id, player_id, team_id, minute, reason)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    match_id,
                    injury["joueur_id"],
                    injury["team_id"],
                    int(injury["minute"]),
                    injury.get("reason"),
                ),
            )

        # Substitutions
        for sub in events["substitutions"]:
            conn.execute(
                """
                INSERT INTO substitutions
                (match_id, player_in_id, player_out_id, minute)
                VALUES (?, ?, ?, ?)
                """,
                (
                    match_id,
                    sub["playerIn"]["joueur_id"],
                    sub["playerOut"]["joueur_id"],
                    int(sub["minute"]),
                ),
            )

    conn.commit()
    conn.close()

    print(f"Database created: {DB_PATH}")


if __name__ == "__main__":
    main()
