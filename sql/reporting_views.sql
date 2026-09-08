DROP VIEW IF EXISTS v_player_match;
DROP VIEW IF EXISTS v_team_match;


CREATE VIEW v_player_match AS
WITH goal_stats AS (
    SELECT
        match_id,
        player_id,
        SUM(CASE WHEN type IN ('REGULAR', 'PENALTY') THEN 1 ELSE 0 END) AS goals,
        SUM(CASE WHEN type = 'OWN_GOAL' THEN 1 ELSE 0 END) AS own_goals
    FROM goals
    GROUP BY match_id, player_id
),

card_stats AS (
    SELECT
        match_id,
        player_id,
        SUM(CASE WHEN type = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_cards,
        SUM(CASE WHEN type = 'RED' THEN 1 ELSE 0 END) AS red_cards
    FROM cards
    GROUP BY match_id, player_id
),

injury_stats AS (
    SELECT
        match_id,
        player_id,
        COUNT(*) AS injury_events
    FROM injuries
    GROUP BY match_id, player_id
),

sub_in_stats AS (
    SELECT
        match_id,
        player_in_id AS player_id,
        1 AS subbed_in
    FROM substitutions
    GROUP BY match_id, player_in_id
)

SELECT
    r.match_id,
    r.player_id,
    p.first_name,
    p.last_name,
    r.team_id,
    t.name AS team_name,
    m.round,
    m.season,
    m.match_date,
    r.role,
    r.position,
    r.captain,

    COALESCE(g.goals, 0) AS goals,
    COALESCE(g.own_goals, 0) AS own_goals,
    COALESCE(c.yellow_cards, 0) AS yellow_cards,
    COALESCE(c.red_cards, 0) AS red_cards,
    COALESCE(i.injury_events, 0) AS injury_events,
    COALESCE(s.subbed_in, 0) AS subbed_in

FROM rosters r
JOIN players p ON p.player_id = r.player_id
JOIN teams t ON t.team_id = r.team_id
JOIN matches m ON m.match_id = r.match_id

LEFT JOIN goal_stats g
    ON g.match_id = r.match_id
    AND g.player_id = r.player_id

LEFT JOIN card_stats c
    ON c.match_id = r.match_id
    AND c.player_id = r.player_id

LEFT JOIN injury_stats i
    ON i.match_id = r.match_id
    AND i.player_id = r.player_id

LEFT JOIN sub_in_stats s
    ON s.match_id = r.match_id
    AND s.player_id = r.player_id;


CREATE VIEW v_team_match AS
WITH team_rows AS (

    SELECT
        m.match_id,
        m.round,
        m.season,
        m.match_date,

        m.home_team_id AS team_id,
        m.away_team_id AS opponent_id,

        m.home_score AS goals_for,
        m.away_score AS goals_against,

        'HOME' AS venue_role

    FROM matches m

    UNION ALL

    SELECT
        m.match_id,
        m.round,
        m.season,
        m.match_date,

        m.away_team_id AS team_id,
        m.home_team_id AS opponent_id,

        m.away_score AS goals_for,
        m.home_score AS goals_against,

        'AWAY' AS venue_role

    FROM matches m
),

discipline AS (
    SELECT
        c.match_id,
        r.team_id,

        SUM(CASE WHEN c.type = 'YELLOW' THEN 1 ELSE 0 END) AS yellow_cards,
        SUM(CASE WHEN c.type = 'RED' THEN 1 ELSE 0 END) AS red_cards

    FROM cards c
    JOIN rosters r
        ON r.match_id = c.match_id
        AND r.player_id = c.player_id

    GROUP BY c.match_id, r.team_id
),

injury_stats AS (
    SELECT
        match_id,
        team_id,
        COUNT(*) AS injury_events
    FROM injuries
    GROUP BY match_id, team_id
)

SELECT
    tr.match_id,
    tr.round,
    tr.season,
    tr.match_date,

    tr.team_id,
    t.name AS team_name,

    tr.opponent_id,
    opponent.name AS opponent_name,

    tr.venue_role,
    tr.goals_for,
    tr.goals_against,

    CASE
        WHEN tr.goals_for > tr.goals_against THEN 'WIN'
        WHEN tr.goals_for < tr.goals_against THEN 'LOSS'
        ELSE 'DRAW'
    END AS result,

    COALESCE(d.yellow_cards, 0) AS yellow_cards,
    COALESCE(d.red_cards, 0) AS red_cards,
    COALESCE(i.injury_events, 0) AS injury_events

FROM team_rows tr

JOIN teams t
    ON t.team_id = tr.team_id

JOIN teams opponent
    ON opponent.team_id = tr.opponent_id

LEFT JOIN discipline d
    ON d.match_id = tr.match_id
    AND d.team_id = tr.team_id

LEFT JOIN injury_stats i
    ON i.match_id = tr.match_id
    AND i.team_id = tr.team_id;
