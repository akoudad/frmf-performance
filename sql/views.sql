CREATE VIEW IF NOT EXISTS v_player_goals AS
SELECT
    p.player_id,
    p.first_name,
    p.last_name,
    COUNT(*) AS goals
FROM goals g
JOIN players p ON p.player_id = g.player_id
WHERE g.type IN ('REGULAR', 'PENALTY')
GROUP BY p.player_id, p.first_name, p.last_name;


CREATE VIEW IF NOT EXISTS v_player_cards AS
SELECT
    p.player_id,
    p.first_name,
    p.last_name,
    SUM(CASE WHEN c.type = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_cards,
    SUM(CASE WHEN c.type = 'RED' THEN 1 ELSE 0 END) AS red_cards
FROM cards c
JOIN players p ON p.player_id = c.player_id
GROUP BY p.player_id, p.first_name, p.last_name;


CREATE VIEW IF NOT EXISTS v_team_injuries AS
SELECT
    t.team_id,
    t.name,
    COUNT(*) AS injury_events
FROM injuries i
JOIN teams t ON t.team_id = i.team_id
GROUP BY t.team_id, t.name;
