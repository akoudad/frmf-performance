"""Discover bounded synthetic CSV sources and their actual columns.

Only the configured CSV directories and their known schema/manifest files
are inspected. Discovery never makes an unknown table queryable.
"""
import csv
import hashlib
import json
import math
import re
from datetime import date
from pathlib import Path

MAX_TABLES = 128
MAX_COLUMNS = 256
MAX_ROWS = 500000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_FIELD_BYTES = 1024 * 1024
MAX_SAFE_INTEGER = 9007199254740991
QUERYABLE = {
    'dim_player': {'primaryKey': ['player_id'], 'grain': 'One synthetic player; join by player_id, never by name.'},
    'dim_edition': {'primaryKey': ['edition_id'], 'grain': 'One competition edition identified by season and competition_id.'},
}
INTEGER = re.compile(r'[+-]?(?:0|[1-9][0-9]*)\Z')
NUMBER = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,127}\Z')


class CatalogError(ValueError):
    pass


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def checked_path(path, roots, kind='file'):
    resolved = path.resolve(strict=True)
    if not any(resolved.is_relative_to(root.resolve()) for root in roots):
        raise CatalogError(f'Source path escapes the approved roots: {path.name}')
    if kind == 'file' and not resolved.is_file() or kind == 'directory' and not resolved.is_dir():
        raise CatalogError(f'Unexpected source path type: {path.name}')
    return path


def fingerprint(root, paths):
    result = []
    for path in sorted(set(paths), key=lambda item: str(item.relative_to(root))):
        stat = path.stat()
        result.append({'path': str(path.relative_to(root)), 'kind': 'directory' if path.is_dir() else 'file',
                       'size': stat.st_size, 'mtimeNs': str(stat.st_mtime_ns)})
    return result


def current_fingerprint(root, previous):
    return fingerprint(root, [root / item['path'] for item in previous])


def schema_columns(table):
    if not isinstance(table, dict):
        return {}
    columns = table.get('columns', table)
    if isinstance(columns, list):
        return {item['name']: item for item in columns if isinstance(item, dict) and isinstance(item.get('name'), str)}
    return columns if isinstance(columns, dict) else {}


def sql_type(hint):
    if isinstance(hint, dict):
        hint = hint.get('type', '')
    hint = str(hint or '').lower()
    if hint in {'integer', 'int', 'bigint', 'boolean', 'bool'}:
        return 'INTEGER'
    if hint in {'real', 'number', 'float', 'double', 'decimal', 'numeric'}:
        return 'REAL'
    return 'TEXT' if hint else None


def is_date_hint(hint):
    if isinstance(hint, dict):
        hint = hint.get('type', '')
    return str(hint or '').lower() == 'date'


def validate_date(value, column):
    if value is None or not value.strip():
        return
    try:
        valid = date.fromisoformat(value).isoformat() == value
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise CatalogError(f'Invalid ISO date in {column}')


def inferred_type(value):
    if INTEGER.fullmatch(value):
        return 'INTEGER' if abs(int(value)) <= MAX_SAFE_INTEGER else 'TEXT'
    # Preserve padded numeric identifiers as text instead of rounding them.
    if re.fullmatch(r'[+-]?0[0-9]+', value):
        return 'TEXT'
    if NUMBER.fullmatch(value) and math.isfinite(float(value)):
        return 'REAL'
    return 'TEXT'


def convert(value, kind, column):
    if value is None or not value.strip():
        return None
    text = value.strip()
    if kind == 'TEXT':
        return value
    if kind == 'INTEGER':
        if not re.fullmatch(r'[+-]?[0-9]+', text):
            raise CatalogError(f'Invalid integer value in {column}')
        result = int(text)
        if abs(result) > MAX_SAFE_INTEGER:
            raise CatalogError(f'Integer value exceeds exact JSON numeric bounds in {column}')
        return result
    if not NUMBER.fullmatch(text) or not math.isfinite(float(text)):
        raise CatalogError(f'Invalid finite numeric value in {column}')
    return float(text)


def inspect_csv(root, path, table_name, hints, declaration):
    before = path.stat()
    file_hash = digest(path)
    nulls = {}
    types = {}
    rows = []
    count = 0
    csv.field_size_limit(MAX_FIELD_BYTES)
    with path.open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames
        if not headers or len(headers) > MAX_COLUMNS or any(not name.strip() or len(name) > 128 or '\x00' in name for name in headers):
            raise CatalogError(f'Invalid or excessive CSV columns in {table_name}')
        if len({name.casefold() for name in headers}) != len(headers):
            raise CatalogError(f'Duplicate CSV columns in {table_name}')
        if 'is_synthetic' not in headers:
            raise CatalogError(f'Missing synthetic marker in {table_name}')
        nulls = dict.fromkeys(headers, 0)
        known = {name: sql_type(hints.get(name)) for name in headers}
        date_columns = {name for name in headers if is_date_hint(hints.get(name))}
        if table_name == 'dim_player':
            date_columns.add('fictional_birth_date')
        if table_name == 'dim_edition':
            date_columns.update({'start_date', 'end_date'} & set(headers))
        types = {name: None for name in headers}
        for row in reader:
            count += 1
            if count > MAX_ROWS:
                raise CatalogError(f'Too many rows in {table_name}')
            if None in row or any(value is None for value in row.values()):
                raise CatalogError(f'CSV row width does not match headers in {table_name}')
            if row['is_synthetic'] != '1':
                raise CatalogError(f'Non-synthetic row in {table_name}')
            for name in headers:
                value = row[name]
                if not value.strip():
                    nulls[name] += 1
                    continue
                if name in date_columns:
                    validate_date(value, f'{table_name}.{name}')
                if known[name]:
                    convert(value, known[name], f'{table_name}.{name}')
                else:
                    kind = inferred_type(value.strip())
                    old = types[name]
                    types[name] = kind if old is None else old if old == kind else 'REAL' if {old, kind} <= {'INTEGER', 'REAL'} else 'TEXT'
            if table_name in QUERYABLE:
                rows.append(row)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise CatalogError(f'Source changed during discovery: {table_name}')
    final_types = {name: known[name] or types[name] or 'TEXT' for name in headers}
    table = {'name': table_name, 'columns': [{'name': name, 'type': final_types[name], 'nullable': nulls[name] > 0, 'nullCount': nulls[name]} for name in headers],
             'rowCount': count, 'source': {'path': str(path.relative_to(root)), 'sha256': file_hash},
             'access': 'queryable' if table_name in QUERYABLE else 'metadata-only'}
    if table_name in QUERYABLE:
        table.update(QUERYABLE[table_name])
    else:
        table['reason'] = 'A scoped query mapping is required before this source table can be queried.'
    if isinstance(declaration, dict) and 'columns' in declaration:
        for key in ('grain', 'primaryKey', 'primary_key', 'keys', 'relationships', 'foreignKeys', 'foreign_keys'):
            if key in declaration:
                table[key] = declaration[key]
    connected = None
    if table_name in QUERYABLE:
        typed = [{name: convert(row[name], final_types[name], f'{table_name}.{name}') for name in headers} for row in rows]
        required = ['player_id', 'fictional_birth_date'] if table_name == 'dim_player' else ['edition_id', 'season', 'competition_id', 'status', 'end_date']
        if any(name not in final_types for name in required):
            raise CatalogError(f'Missing required connected dimension columns in {table_name}')
        if any(name.casefold() == 'age_as_of_date' for name in final_types):
            raise CatalogError(f'Reserved computed column age_as_of_date in {table_name}')
        for key in QUERYABLE[table_name]['primaryKey']:
            if key not in final_types:
                raise CatalogError(f'Missing connected dimension key {table_name}.{key}')
        keys = [tuple(row[key] for key in QUERYABLE[table_name]['primaryKey']) for row in typed]
        if any(any(value is None for value in key) for key in keys) or len(set(keys)) != len(keys):
            raise CatalogError(f'Duplicate or empty connected dimension keys in {table_name}')
        if table_name == 'dim_edition':
            edition_keys = [(row['season'], row['competition_id']) for row in typed]
            if any(None in key for key in edition_keys) or len(set(edition_keys)) != len(edition_keys):
                raise CatalogError('Duplicate or empty season/competition edition keys')
            if any(row['status'] not in {'COMPLETE', 'PARTIAL', 'UPCOMING'} for row in typed):
                raise CatalogError('Invalid competition edition status')
        connected = {'columns': final_types, 'rows': typed}
    return table, connected


def build_source_catalog(root, base, upgrade=None):
    root, base = Path(root).absolute(), Path(base).absolute()
    roots = [base] + ([Path(upgrade).absolute()] if upgrade is not None else [])
    for directory in roots:
        checked_path(directory, [root], 'directory')
    directory_paths = roots + [directory.parent for directory in roots]
    directories_before = fingerprint(root, directory_paths)
    inventory_before = {str(directory): sorted(path.name for path in directory.iterdir() if path.suffix.lower() == '.csv') for directory in roots}
    effective = {}
    spellings = {}
    for directory in roots:
        local_names = set()
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() != '.csv':
                continue
            checked_path(path, roots)
            if not IDENTIFIER.fullmatch(path.stem):
                raise CatalogError(f'Unsupported table filename: {path.name}')
            folded = path.stem.casefold()
            if folded in local_names or folded in spellings and spellings[folded] != path.stem:
                raise CatalogError(f'Duplicate or case-ambiguous table name: {path.stem}')
            local_names.add(folded)
            spellings[folded] = path.stem
            effective[path.stem] = path
    if len(effective) > MAX_TABLES:
        raise CatalogError('Too many synthetic source tables.')
    sizes = [path.stat().st_size for path in effective.values()]
    if any(size > MAX_FILE_BYTES for size in sizes) or sum(sizes) > MAX_TOTAL_BYTES:
        raise CatalogError('Synthetic source files exceed the catalog size limit.')
    metadata = []
    declarations = {}
    relationships = []
    manifests = []
    metadata_paths = []
    for directory in roots:
        for filename in ('schema.json', 'MANIFEST.json'):
            path = directory.parent / filename
            if path.is_symlink():
                raise CatalogError(f'Schema/manifest links are not supported: {filename}')
            if not path.exists():
                continue
            checked_path(path, [directory.parent])
            if path.stat().st_size > 2 * 1024 * 1024:
                raise CatalogError(f'Source metadata file exceeds its size limit: {filename}')
            metadata_paths.append(path)
    watched = directory_paths + list(effective.values()) + metadata_paths
    before = fingerprint(root, watched)
    for path in metadata_paths:
        raw = path.read_bytes()
        data = json.loads(raw.decode('utf-8-sig'))
        if not isinstance(data, dict):
            raise CatalogError(f'Invalid source metadata: {path.name}')
        metadata.append({'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(raw).hexdigest()})
        if path.name == 'schema.json':
            tables = data.get('tables', {})
            links = data.get('relationships', [])
            if not isinstance(tables, dict) or not isinstance(links, list):
                raise CatalogError('Source schema tables/relationships have invalid types')
            declarations.update(tables)
            relationships.extend(links)
        else:
            manifests.append(data)
    dates = [manifest.get('snapshot_date') or manifest.get('snapshotDate') for manifest in manifests]
    dates = [value for value in dates if value]
    if not dates or any(not isinstance(value, str) for value in dates):
        raise CatalogError('A trusted source manifest must provide an ISO snapshot date.')
    for value in dates:
        validate_date(value, 'manifest snapshot date')
    # The upgrade manifest is authoritative when it supplies a snapshot date.
    snapshot_date = dates[-1]
    tables = []
    source_tables = {}
    for name, path in sorted(effective.items()):
        declaration = declarations.get(name, {})
        table, connected = inspect_csv(root, path, name, schema_columns(declaration), declaration)
        tables.append(table)
        if connected:
            source_tables[name] = connected
    after = fingerprint(root, watched)
    inventory_after = {str(directory): sorted(path.name for path in directory.iterdir() if path.suffix.lower() == '.csv') for directory in roots}
    if before != after or directories_before != fingerprint(root, directory_paths) or inventory_before != inventory_after:
        raise CatalogError('Sources changed during catalog discovery; retry after the edits finish.')
    contents = sorted([table['source'] for table in tables] + metadata, key=lambda item: item['path'])
    version = hashlib.sha256(json.dumps(contents, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'snapshotDate': snapshot_date, 'sourceVersion': version, 'sourceFingerprint': after,
            'sourceCatalog': {'version': 1, 'tables': tables, 'relationships': relationships, 'metadataSources': metadata,
                              'overlay': 'Same-named UPGRADE CSVs replace BASE CSVs.' if upgrade is not None else 'Single approved CSV source.'}, 'sourceTables': source_tables}
