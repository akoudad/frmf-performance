"""Build the pilot's read-only snapshot exclusively from approved synthetic CSVs."""
import argparse
import csv
import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from source_catalog import CatalogError, build_source_catalog, current_fingerprint

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BASE = ROOT / "data/synthetic/bi_model"
catalog_bundle = build_source_catalog(ROOT, BASE)
effective_sources = {table["name"]: ROOT / table["source"]["path"] for table in catalog_bundle["sourceCatalog"]["tables"]}
sources = []


def require_unique(rows, columns, name):
    keys = [tuple(row[column] for column in columns) for row in rows]
    if any(any(not value for value in key) for key in keys) or len(set(keys)) != len(keys):
        raise CatalogError(f"Duplicate or empty keys in {name}: {', '.join(columns)}")


def require_reference(rows, column, known, name, optional=False):
    if any(row[column] not in known and not (optional and not row[column]) for row in rows):
        raise CatalogError(f"Unresolved reference in {name}.{column}")


def read(name, upgraded=False):
    # The same overlay policy applies to every table, including newly connected dimensions.
    if name not in effective_sources:
        raise CatalogError(f"Required synthetic source table is missing: {name}")
    path = effective_sources[name]
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows or not all(row["is_synthetic"] == "1" for row in rows):
        raise CatalogError(f"Expected non-empty synthetic rows in {name}")
    sources.append({"path": str(path.relative_to(ROOT)), "rows": len(rows),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return rows


competitions = read("dim_competition")
competition_by_id = {row["competition_id"]: row for row in competitions}
assert len(competition_by_id) == len(competitions), "Duplicate competition IDs"
assert all(row["category"] in {"MEN", "WOMEN"} and row["age_group"] in {"SENIOR", "U19"}
           for row in competitions), "Unsupported competition category or age group"
teams = read("dim_team")
players = read("dim_player")
match_rows = read("dim_match", True)
require_unique(match_rows, ["match_id"], "dim_match")
matches = {row["match_id"]: row for row in match_rows}
team_rows = read("fact_team_match")
player_rows = read("fact_player_match", True)
events = read("fact_match_event", True)
editions = read("dim_edition")
edition_keys = {(row["season"], row["competition_id"]) for row in editions}
assert len(edition_keys) == len(editions), "Duplicate competition editions"
assert all(row["competition_id"] in competition_by_id and row["status"] in {"COMPLETE", "PARTIAL", "UPCOMING"}
           for row in editions), "Unsupported edition status or competition"
assert all((row["season"], row["competition_id"]) in edition_keys for row in matches.values()), "Match edition metadata is missing"
team_names = {row["team_id"]: row["team_short_name"] for row in teams}
player_names = {row["player_id"]: row["player_name"] for row in players}

# Reject duplicate identities and broken relationships before aggregation can hide them.
for rows, keys, name in [(competitions, ["competition_id"], "dim_competition"), (teams, ["team_id"], "dim_team"),
                         (players, ["player_id"], "dim_player"), (events, ["event_id"], "fact_match_event"),
                         (team_rows, ["match_id", "team_id"], "fact_team_match"),
                         (player_rows, ["match_id", "player_id"], "fact_player_match")]:
    require_unique(rows, keys, name)
require_reference(match_rows, "competition_id", competition_by_id, "dim_match")
for column in ("home_team_id", "away_team_id"):
    require_reference(match_rows, column, team_names, "dim_match")
for rows, name in [(team_rows, "fact_team_match"), (player_rows, "fact_player_match"), (events, "fact_match_event")]:
    require_reference(rows, "match_id", matches, name)
    require_reference(rows, "team_id", team_names, name)
    if any(row["team_id"] not in {matches[row["match_id"]]["home_team_id"], matches[row["match_id"]]["away_team_id"]} for row in rows):
        raise CatalogError(f"Team is outside its match participants in {name}")
require_reference(player_rows, "player_id", player_names, "fact_player_match")
for column in ("player_id", "secondary_player_id"):
    require_reference(events, column, player_names, "fact_match_event", optional=True)
require_reference(events, "beneficiary_team_id", team_names, "fact_match_event", optional=True)
player_matches = {(row["match_id"], row["player_id"]): row for row in player_rows}

# Independently reconcile the new assist column with goal-event credits.
credits = defaultdict(int)
for row in events:
    if row["event_type"] == "GOAL" and row["secondary_player_id"]:
        assert row["event_detail"] == "REGULAR"
        credits[(row["match_id"], row["secondary_player_id"])] += 1
assist_credits = sum(credits.values())
for key in credits:
    if key not in player_matches or player_matches[key]["recorded_appearance"] != "1":
        raise CatalogError("An assist credit has no matching actual player appearance")
for row in player_rows:
    if int(row["recorded_assists"] or 0) != credits[(row["match_id"], row["player_id"])]:
        raise CatalogError("Recorded assists do not reconcile with goal-event credits")

player_groups = {}
team_assists = defaultdict(int)
team_assist_coverage = defaultdict(list)
for row in player_rows:
    match = matches[row["match_id"]]
    if row["recorded_appearance"] != "1" or match["match_status"] != "PLAYED":
        continue
    key = (row["player_id"], row["team_id"], match["season"], match["competition_id"])
    if key not in player_groups:
        player_groups[key] = {"playerId": key[0], "player": player_names[key[0]],
                              "teamId": key[1], "team": team_names[key[1]],
                              "season": key[2], "competitionId": key[3],
                              "competition": match["competition_name"], "appearances": 0,
                              "goals": 0, "assists": 0, "yellowCards": 0, "redCards": 0,
                              "goalsComplete": True, "assistsComplete": True, "cardsComplete": True,
                              "matchIds": []}
    group = player_groups[key]
    group["appearances"] += 1
    group["matchIds"].append(row["match_id"])
    for metric, field in [("goals", "recorded_goals"), ("assists", "recorded_assists"),
                          ("yellowCards", "recorded_yellow_cards"), ("redCards", "recorded_red_cards")]:
        group[metric] += int(row[field] or 0)
    for feed in ["goals", "assists", "cards"]:
        group[f"{feed}Complete"] &= row[f"{feed}_available"] == "1" and match[f"{feed}_available"] == "1"
    team_assists[(row["match_id"], row["team_id"])] += int(row["recorded_assists"] or 0)
    team_assist_coverage[(row["match_id"], row["team_id"])].append(row["assists_available"] == "1")

team_groups = {}
for row in team_rows:
    match = matches[row["match_id"]]
    if row["recorded_match"] != "1" or match["match_status"] != "PLAYED":
        continue
    key = (row["team_id"], match["season"], match["competition_id"])
    if key not in team_groups:
        team_groups[key] = {"teamId": key[0], "team": team_names[key[0]], "season": key[1],
                            "competitionId": key[2], "competition": match["competition_name"],
                            "played": 0, "goalsFor": 0, "goalsAgainst": 0, "assists": 0,
                            "wins": 0, "draws": 0, "losses": 0, "goalsComplete": True,
                            "assistsComplete": True, "matchIds": []}
    group = team_groups[key]
    group["played"] += 1
    group["matchIds"].append(row["match_id"])
    for metric, field in [("goalsFor", "reported_goals_for"), ("goalsAgainst", "reported_goals_against"),
                          ("wins", "win_flag"), ("draws", "draw_flag"), ("losses", "loss_flag")]:
        group[metric] += int(row[field] or 0)
    side = (row["match_id"], row["team_id"])
    group["assists"] += team_assists[side]
    group["goalsComplete"] &= row["goals_available"] == "1" and match["goals_available"] == "1"
    group["assistsComplete"] &= bool(team_assist_coverage[side]) and all(team_assist_coverage[side]) and match["assists_available"] == "1"

assert all(group["competitionId"] in competition_by_id for group in player_groups.values()), "Unresolved player-group competition"
assert all(group["competitionId"] in competition_by_id for group in team_groups.values()), "Unresolved team-group competition"

data = {
    "provenance": {"dataset": "FRMF Synthetic V4 + V5 primary-assists augmentation",
                   "snapshotDate": catalog_bundle["snapshotDate"], "isSynthetic": True,
                   "assistCredits": assist_credits, "sources": sources},
    # Category and age group describe the competition, never inferred from names.
    "competitions": [{"id": r["competition_id"], "name": r["name"],
                      "category": r["category"], "ageGroup": r["age_group"]} for r in competitions],
    "editions": [{"season": r["season"], "competitionId": r["competition_id"],
                  "competition": competition_by_id[r["competition_id"]]["name"], "status": r["status"]} for r in editions],
    "teams": [{"id": r["team_id"], "name": r["team_short_name"],
               "aliases": list(set([r["team_name"], r["team_label"]]))} for r in teams],
    "players": [{"id": r["player_id"], "name": r["player_name"]} for r in players],
    "seasons": sorted(set(r["season"] for r in matches.values())),
    "playerGroups": list(player_groups.values()), "teamGroups": list(team_groups.values()),
}
data.update({key: catalog_bundle[key] for key in ["sourceCatalog", "sourceTables", "sourceVersion", "sourceFingerprint"]})
if current_fingerprint(ROOT, catalog_bundle["sourceFingerprint"]) != catalog_bundle["sourceFingerprint"]:
    raise CatalogError("Sources changed during snapshot construction; retry after the edits finish")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, default=HERE / "synthetic-snapshot.json", help="Write an atomic candidate snapshot to this path")
output = parser.parse_args().output.resolve()
output.parent.mkdir(parents=True, exist_ok=True)
temporary = None
try:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, prefix=f".{output.name}.", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, output)
except BaseException:
    if temporary is not None:
        temporary.unlink(missing_ok=True)
    raise
print(json.dumps({"playerGroups": len(player_groups), "teamGroups": len(team_groups), "assistCredits": assist_credits,
                  "sourceTables": len(catalog_bundle["sourceCatalog"]["tables"]), "sourceVersion": catalog_bundle["sourceVersion"]}))
