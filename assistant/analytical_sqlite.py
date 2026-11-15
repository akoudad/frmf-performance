"""One read-only analytical query over scoped rows supplied through stdin.

No snapshot or database file is opened here. The parent owns scope validation;
this process sees only that scope and builds a fresh in-memory database.
"""
import json
import math
import re
import sqlite3
import sys
import time
from datetime import date

SQL_BYTES = 8192
RESULT_BYTES = 262144
MAX_ROWS = 200
DEADLINE_SECONDS = 2.8

PLAYER_COLUMNS = {
    'player_id': 'TEXT', 'player': 'TEXT', 'team_id': 'TEXT', 'team': 'TEXT',
    'season': 'TEXT', 'competition_id': 'TEXT', 'competition': 'TEXT',
    'category': 'TEXT', 'age_group': 'TEXT', 'appearances': 'INTEGER',
    'goals': 'INTEGER', 'assists': 'INTEGER', 'yellow_cards': 'INTEGER', 'red_cards': 'INTEGER',
    'goals_complete': 'INTEGER', 'assists_complete': 'INTEGER', 'cards_complete': 'INTEGER',
}
TEAM_COLUMNS = {
    'team_id': 'TEXT', 'team': 'TEXT', 'season': 'TEXT', 'competition_id': 'TEXT',
    'competition': 'TEXT', 'category': 'TEXT', 'age_group': 'TEXT', 'played': 'INTEGER',
    'goals_for': 'INTEGER', 'goals_against': 'INTEGER', 'assists': 'INTEGER',
    'wins': 'INTEGER', 'draws': 'INTEGER', 'losses': 'INTEGER',
    'goals_complete': 'INTEGER', 'assists_complete': 'INTEGER',
}
ALLOWED_FUNCTIONS = {
    'age_on',
    'abs', 'avg', 'count', 'max', 'min', 'sum', 'total', 'round',
    'coalesce', 'ifnull', 'nullif', 'iif', 'if', 'typeof',
    'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'length', 'octet_length',
    'substr', 'substring', 'instr', 'replace', 'like', 'glob', 'printf', 'format',
    'group_concat', 'string_agg', 'concat', 'concat_ws',
    'date', 'time', 'datetime', 'julianday', 'strftime', 'unixepoch', 'timediff',
    'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
    'lag', 'lead', 'first_value', 'last_value', 'nth_value',
    'sign', 'ceil', 'ceiling', 'floor', 'trunc', 'sqrt', 'pow', 'power', 'ln', 'log', 'log10', 'log2', 'exp', 'mod',
}


class QueryError(Exception):
    pass


def age_on(birth_date, reference_date):
    """Completed calendar years; missing/invalid dates or a pre-birth reference yield NULL."""
    try:
        if any(not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)
               for value in (birth_date, reference_date)):
            return None
        born, reference = date.fromisoformat(birth_date), date.fromisoformat(reference_date)
    except ValueError:
        return None
    if reference < born:
        return None
    return reference.year - born.year - ((reference.month, reference.day) < (born.month, born.day))


def leading_keyword(sql):
    remaining = sql.lstrip()
    while remaining.startswith(('--', '/*')):
        if remaining.startswith('--'):
            newline = remaining.find('\n')
            remaining = '' if newline == -1 else remaining[newline + 1:].lstrip()
        else:
            closing = remaining.find('*/', 2)
            if closing == -1:
                raise QueryError('The SQL comment is unfinished.')
            remaining = remaining[closing + 2:].lstrip()
    match = re.match(r'([A-Za-z]+)\b', remaining)
    return match.group(1).upper() if match else ''


def authorize(action, arg1, arg2, database, trigger):
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE):
        return sqlite3.SQLITE_OK
    # SQLite's COUNT(*) optimization reports a table read with database=None.
    if action == sqlite3.SQLITE_READ and database in ('main', None) and arg1 in ('player_stats', 'team_stats', 'dim_player', 'dim_edition'):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and (arg2 or '').lower() in ALLOWED_FUNCTIONS:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def create_table(connection, name, columns, rows):
    if not isinstance(rows, list) or len(rows) > 20000:
        raise QueryError('The scoped aggregate rows are invalid or too large.')
    connection.execute(f'CREATE TABLE {name} ({", ".join(key + " " + kind for key, kind in columns.items())})')
    values = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != set(columns):
            raise QueryError('The scoped aggregate schema is invalid.')
        row = dict(row)
        coverage = {'goals': 'goals_complete', 'assists': 'assists_complete', 'goals_for': 'goals_complete',
                    'goals_against': 'goals_complete', 'yellow_cards': 'cards_complete', 'red_cards': 'cards_complete'}
        for flag in set(coverage.values()) & set(columns):
            if row[flag] not in (0, 1):
                raise QueryError('A scoped coverage flag is invalid.')
            fields = [field for field, item_flag in coverage.items() if item_flag == flag and field in columns]
            if any(row[field] is None for field in fields):
                row[flag] = 0
            if row[flag] == 0:
                for field in fields:
                    row[field] = None
        for field, kind in columns.items():
            value = row[field]
            if kind == 'TEXT' and (not isinstance(value, str) or len(value) > 200):
                raise QueryError('A scoped text value is invalid.')
            if kind == 'INTEGER' and (value is None and field not in coverage or value is not None and (type(value) is not int or value < 0)):
                raise QueryError('A scoped metric value is invalid.')
        values.append(tuple(row[key] for key in columns))
    connection.executemany(f'INSERT INTO {name} VALUES ({", ".join("?" for _ in columns)})', values)


def quoted_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def create_dimensions(connection, tables):
    if not isinstance(tables, dict) or set(tables) - {'dim_player', 'dim_edition'}:
        raise QueryError('Only the approved profile and edition dimensions can be supplied.')
    for name, table in tables.items():
        if not isinstance(table, dict) or set(table) != {'columns', 'rows'}:
            raise QueryError('The scoped dimension schema is invalid.')
        columns, rows = table['columns'], table['rows']
        if not isinstance(columns, dict) or not 1 <= len(columns) <= 100 or not isinstance(rows, list) or len(rows) > 20000:
            raise QueryError('The scoped dimension schema or row count is invalid.')
        if any(not isinstance(column, str) or not column.strip() or len(column) > 128
               or any(ord(char) < 32 for char in column) or kind not in {'TEXT', 'INTEGER', 'REAL'}
               for column, kind in columns.items()) or len({column.casefold() for column in columns}) != len(columns):
            raise QueryError('The scoped dimension columns must have unique names and ordinary SQLite types.')
        values = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(columns):
                raise QueryError('A scoped dimension row does not match its source columns.')
            for column, kind in columns.items():
                value = row[column]
                if value is None:
                    continue
                if kind == 'TEXT' and (not isinstance(value, str) or len(value) > 10000):
                    raise QueryError('A scoped dimension text value is invalid.')
                if kind == 'INTEGER' and (type(value) is not int or abs(value) > 9007199254740991):
                    raise QueryError('A scoped dimension integer is invalid or exceeds exact numeric precision.')
                if kind == 'REAL' and (type(value) not in (int, float) or not math.isfinite(value)):
                    raise QueryError('A scoped dimension real value is invalid.')
            values.append(tuple(row[column] for column in columns))
        definition = ', '.join(quoted_identifier(column) + ' ' + kind for column, kind in columns.items())
        connection.execute(f'CREATE TABLE {quoted_identifier(name)} ({definition})')
        connection.executemany(f'INSERT INTO {quoted_identifier(name)} VALUES ({", ".join("?" for _ in columns)})', values)


def execute(payload):
    started = time.monotonic()
    sql = payload.get('sql')
    if not isinstance(sql, str) or not sql.strip() or len(sql.encode('utf-8')) > SQL_BYTES:
        raise QueryError('Provide one read-only SQL query of at most 8 KiB.')
    if leading_keyword(sql) not in ('SELECT', 'WITH'):
        raise QueryError('Only one SELECT query or a WITH query ending in SELECT is allowed.')
    connection = sqlite3.connect(':memory:', isolation_level=None)
    try:
        connection.enable_load_extension(False)
        connection.create_function('age_on', 2, age_on, deterministic=True)
        connection.execute('PRAGMA temp_store=MEMORY')
        connection.execute('PRAGMA trusted_schema=OFF')
        connection.execute('PRAGMA hard_heap_limit=134217728')
        create_table(connection, 'player_stats', PLAYER_COLUMNS, payload.get('playerRows'))
        create_table(connection, 'team_stats', TEAM_COLUMNS, payload.get('teamRows'))
        create_dimensions(connection, payload.get('sourceTables', {}))
        if hasattr(connection, 'setlimit'):
            for name, value in [('SQLITE_LIMIT_LENGTH', 262144), ('SQLITE_LIMIT_SQL_LENGTH', SQL_BYTES),
                                ('SQLITE_LIMIT_COLUMN', 100), ('SQLITE_LIMIT_EXPR_DEPTH', 50),
                                ('SQLITE_LIMIT_COMPOUND_SELECT', 20), ('SQLITE_LIMIT_FUNCTION_ARG', 32),
                                ('SQLITE_LIMIT_VDBE_OP', 250000), ('SQLITE_LIMIT_ATTACHED', 0),
                                ('SQLITE_LIMIT_VARIABLE_NUMBER', 0), ('SQLITE_LIMIT_LIKE_PATTERN_LENGTH', 1000)]:
                connection.setlimit(getattr(sqlite3, name), value)
        connection.execute('PRAGMA query_only=ON')
        connection.set_authorizer(authorize)
        connection.set_progress_handler(lambda: int(time.monotonic() - started > DEADLINE_SECONDS), 1000)
        cursor = connection.execute(sql)
        if cursor.description is None:
            raise QueryError('The query must return a read-only result table.')
        columns = [item[0] for item in cursor.description]
        if any(not column.strip() for column in columns) or len({column.strip().casefold() for column in columns}) != len(columns):
            raise QueryError('Give every result column a non-empty, unique name using AS aliases.')
        rows = []
        byte_count = len(json.dumps(columns, ensure_ascii=False).encode('utf-8')) + 1024
        truncated = False
        for row in cursor:
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            if any(isinstance(value, bytes) or isinstance(value, float) and not math.isfinite(value) for value in row):
                raise QueryError('The query returned a binary or non-finite value. Select ordinary text and finite numbers.')
            values = dict(zip(columns, row))
            row_bytes = len(json.dumps(values, ensure_ascii=False, allow_nan=False).encode('utf-8')) + 2
            if byte_count + row_bytes > RESULT_BYTES - 1024:
                if not rows:
                    raise QueryError('A result row exceeds 256 KiB. Select fewer or smaller columns.')
                truncated = True
                break
            rows.append(values)
            byte_count += row_bytes
        return {'columns': columns, 'rows': rows, 'rowCount': len(rows), 'truncated': truncated,
                'elapsedMs': round((time.monotonic() - started) * 1000)}
    finally:
        connection.close()


def main():
    try:
        raw = sys.stdin.buffer.read(8388609)
        if len(raw) > 8388608:
            raise QueryError('The scoped input exceeded its size limit.')
        payload = json.loads(raw)
        if not isinstance(payload, dict) or not {'sql', 'playerRows', 'teamRows'} <= set(payload) or set(payload) - {'sql', 'playerRows', 'teamRows', 'sourceTables'}:
            raise QueryError('The analytical request has invalid fields.')
        result = execute(payload)
    except QueryError as error:
        result = {'error': str(error)}
    except sqlite3.Error as error:
        message = str(error)
        if 'interrupted' in message:
            message = 'The query exceeded its 3-second limit. Add filters or simplify the calculation.'
        elif 'authorized' in message:
            message = 'The query requests a table, function or operation outside the read-only analytical allowlist.'
        elif 'one statement' in message:
            message = 'Only one read-only SQL statement is allowed.'
        result = {'error': message[:500]}
    except (ValueError, TypeError, KeyError, MemoryError):
        result = {'error': 'The analytical request is invalid or exceeded its resource limits.'}
    except Exception:
        result = {'error': 'The local analytical worker could not complete this request.'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
