PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
    team_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    position TEXT
);

CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    round TEXT,
    season TEXT,
    match_date TEXT,
    home_team_id INTEGER,
    away_team_id INTEGER,
    home_score INTEGER,
    away_score INTEGER,
    FOREIGN KEY (home_team_id) REFERENCES teams(team_id),
    FOREIGN KEY (away_team_id) REFERENCES teams(team_id)
);

CREATE TABLE IF NOT EXISTS rosters (
    match_id TEXT,
    team_id INTEGER,
    player_id INTEGER,
    role TEXT,
    position TEXT,
    captain INTEGER,
    PRIMARY KEY (match_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT,
    player_id INTEGER,
    team_id INTEGER,
    type TEXT,
    minute INTEGER
);

CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT,
    player_id INTEGER,
    type TEXT,
    minute INTEGER,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS injuries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT,
    player_id INTEGER,
    team_id INTEGER,
    minute INTEGER,
    reason TEXT
);

CREATE TABLE IF NOT EXISTS substitutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT,
    player_in_id INTEGER,
    player_out_id INTEGER,
    minute INTEGER
);
