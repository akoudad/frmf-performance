# Metric definitions

These rules describe the included synthetic demonstration. The initial source-import pipeline in `src/` uses its own source contract; missing fields in that extract must not be inferred from the synthetic data.

| Indicator | Definition |
| --- | --- |
| Matches | Distinct played fixtures. A match creates two team-match rows. |
| Squad selections | Players listed for a match, including unused substitutes. |
| Appearances | Recorded starts and substitute appearances. Excludes unused substitutes. |
| Player goals | Regular and penalty goals credited to the player. Excludes own goals and shootout kicks. |
| Team goals | Reported goals for that side, including an opponent's own goal. Shootouts remain separate. |
| Goal difference | Goals for minus goals against within the same scope. |
| Win rate | Wins divided by played team-match records. An empty denominator remains unknown. |
| Goals per appearance | Combined goals divided by combined appearances. Do not average intermediate rates. |
| Primary assists | One eligible teammate credited on a regular goal under the V5 simulation rules. Penalties, own goals and shootout kicks receive none. |
| Cards | Recorded yellow and red card events. These are not official suspension or eligibility decisions. |
| Injury observations | Recorded incidents, with feed coverage shown. Not a diagnosis or current medical status. |
| Demonstration points | Three points per win and one per draw. Standings then use goal difference and goals scored; exact ties share rank. |

## Identity and scope

Use identifiers to join or group people and teams. Names are display labels. Historical facts retain the team associated with the recorded appearance.

Every comparison requires an explicit season, competition and population. Across seasons, aggregate totals before calculating a rate. Season-history curves stop at the lowest played-match count among the selected seasons, while the table retains complete observed totals.

## Coverage and unavailable metrics

A covered feed with no events can produce zero. An unavailable or incomplete metric remains unknown, with coverage flags and warnings. SQL `NULL` must not silently become zero. Scheduled and postponed fixtures are excluded from played-match totals.

The synthetic V5 extension includes primary assists. The initial source extract had null assist fields; that does not mean no assists occurred.

Reliable minutes played, per-90 statistics, expected goals, pass completion and distance covered are not available in the connected analytical scope. A “best player” ranking requires an agreed criterion.

Power BI uses DAX and the assistant uses SQLite. Agreement requires matching definitions, selected scope and data version; evidence references alone do not prove that a query answers the intended question.
