"""Isolated source discovery tests; never modify the approved production CSVs."""
import csv
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import source_catalog as catalog


class SourceCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'base' / 'bi_model'
        self.upgrade = self.root / 'upgrade' / 'bi_model'
        self.base.mkdir(parents=True)
        self.upgrade.mkdir(parents=True)
        self.manifest = self.base.parent / 'MANIFEST.json'
        self.manifest.write_text(json.dumps({'snapshot_date': '2026-09-11'}))
        self.schema = self.base.parent / 'schema.json'
        self.schema.write_text(json.dumps({'tables': {'dim_player': {'player_id': 'integer', 'fictional_birth_date': 'date'},
                                                     'dim_edition': {'competition_id': 'integer'}}}))
        self.players = [{'player_id': '1', 'fictional_birth_date': '2001-02-28', 'player_name': 'Sample Player', 'is_synthetic': '1'}]
        self.editions = [{'edition_id': 'E1', 'season': '2025-2026', 'competition_id': '1',
                          'status': 'COMPLETE', 'end_date': '2026-06-30', 'is_synthetic': '1'}]
        self.write('dim_player', self.players)
        self.write('dim_edition', self.editions)

    def write(self, name, rows, directory=None, headers=None):
        path = (directory or self.base) / f'{name}.csv'
        with path.open('w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=headers or list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        return path

    def build(self):
        return catalog.build_source_catalog(self.root, self.base, self.upgrade)

    def test_single_source_requires_no_upgrade_directory(self):
        self.write('dim_player', [dict(self.players[0], player_name='Ignored overlay')], self.upgrade)
        result = catalog.build_source_catalog(self.root, self.base)
        self.assertEqual(result['snapshotDate'], '2026-09-11')
        self.assertEqual(result['sourceTables']['dim_player']['rows'][0]['player_name'], 'Sample Player')
        self.assertEqual(len(result['sourceCatalog']['tables']), 2)
        self.assertTrue(all(item['path'] == 'base' or item['path'].startswith('base/') for item in result['sourceFingerprint']))
        self.assertEqual(result['sourceCatalog']['overlay'], 'Single approved CSV source.')

    def test_overlay_actual_columns_nullable_types_and_unknown_mapping(self):
        self.write('dim_player', [dict(self.players[0], height='182.5', shirt='007', nickname='')], self.upgrade)
        self.write('new_observations', [{'record_id': '1', 'rating': '4.5', 'is_synthetic': '1'}])
        result = self.build()
        self.assertEqual(result['snapshotDate'], '2026-09-11')
        dimension = result['sourceTables']['dim_player']
        self.assertEqual(dimension['columns']['height'], 'REAL')
        self.assertEqual(dimension['columns']['shirt'], 'TEXT')
        self.assertEqual(dimension['rows'][0]['player_id'], 1)
        self.assertIsNone(dimension['rows'][0]['nickname'])
        tables = {table['name']: table for table in result['sourceCatalog']['tables']}
        self.assertEqual(tables['dim_player']['source']['path'], 'upgrade/bi_model/dim_player.csv')
        nickname = next(column for column in tables['dim_player']['columns'] if column['name'] == 'nickname')
        self.assertEqual(nickname, {'name': 'nickname', 'type': 'TEXT', 'nullable': True, 'nullCount': 1})
        self.assertEqual(tables['new_observations']['access'], 'metadata-only')
        self.assertNotIn('new_observations', result['sourceTables'])
        self.assertIn('mapping', tables['new_observations']['reason'])

    def test_version_uses_contents_while_fingerprint_detects_touch(self):
        first = self.build()
        path = self.base / 'dim_player.csv'
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
        touched = self.build()
        self.assertEqual(first['sourceVersion'], touched['sourceVersion'])
        self.assertNotEqual(first['sourceFingerprint'], touched['sourceFingerprint'])
        self.write('dim_player', [dict(self.players[0], new_measure='12')])
        changed = self.build()
        self.assertNotEqual(touched['sourceVersion'], changed['sourceVersion'])
        self.assertEqual(catalog.current_fingerprint(self.root, changed['sourceFingerprint']), changed['sourceFingerprint'])
        watched = {(item['path'], item['kind']) for item in changed['sourceFingerprint']}
        self.assertIn(('base', 'directory'), watched)
        self.assertIn(('upgrade/bi_model', 'directory'), watched)
        self.assertIn(('base/schema.json', 'file'), watched)

    def test_new_table_and_schema_metadata_change_version(self):
        first = self.build()['sourceVersion']
        self.write('new_events', [{'is_synthetic': '1', 'event_id': 'X'}])
        second = self.build()['sourceVersion']
        self.assertNotEqual(first, second)
        self.schema.write_text(json.dumps({'tables': {}, 'relationships': [{'from': 'new_events', 'to': 'dim_player'}]}))
        third = self.build()
        self.assertNotEqual(second, third['sourceVersion'])
        self.assertEqual(len(third['sourceCatalog']['relationships']), 1)

    def test_non_synthetic_and_missing_marker_are_rejected(self):
        for rows in [[dict(self.players[0], is_synthetic='0')], [{'player_id': '1', 'fictional_birth_date': '2001-02-28'}]]:
            with self.subTest(rows=rows):
                self.write('dim_player', rows)
                with self.assertRaisesRegex(catalog.CatalogError, '[Ss]ynthetic'):
                    self.build()

    def test_escaping_csv_and_metadata_links_are_rejected(self):
        outside = self.root / 'elsewhere.csv'
        outside.write_text('is_synthetic\n1\n')
        link = self.base / 'escape.csv'
        link.symlink_to(outside)
        with self.assertRaisesRegex(catalog.CatalogError, 'escapes'):
            self.build()
        link.unlink()
        self.schema.unlink()
        self.schema.symlink_to(self.root / 'absent.json')
        with self.assertRaisesRegex(catalog.CatalogError, 'links'):
            self.build()

    def test_headers_row_width_and_case_ambiguous_tables(self):
        bad = self.base / 'extra.csv'
        for text in ['is_synthetic,x,X\n1,2,3\n', 'is_synthetic,\n1,2\n', 'is_synthetic,x\n1,2,3\n']:
            with self.subTest(text=text):
                bad.write_text(text)
                with self.assertRaises(catalog.CatalogError):
                    self.build()
        bad.unlink()
        self.write('DIM_PLAYER', self.players, self.upgrade)
        with self.assertRaisesRegex(catalog.CatalogError, 'case-ambiguous'):
            self.build()

    def test_dimension_keys_required_columns_and_reserved_field(self):
        cases = [self.players * 2,
                 [{key: value for key, value in self.players[0].items() if key != 'fictional_birth_date'}],
                 [dict(self.players[0], age_as_of_date='20')]]
        for rows in cases:
            with self.subTest(rows=rows):
                self.write('dim_player', rows)
                with self.assertRaises(catalog.CatalogError):
                    self.build()
        self.write('dim_player', self.players)
        self.write('dim_edition', self.editions + [dict(self.editions[0], edition_id='E2')])
        with self.assertRaisesRegex(catalog.CatalogError, 'season/competition'):
            self.build()

    def test_invalid_dates_rejected_with_or_without_hints_and_null_preserved(self):
        for value in ['2001-02-30', '20010228', '2001-2-28', ' 2001-02-28']:
            with self.subTest(value=value):
                self.write('dim_player', [dict(self.players[0], fictional_birth_date=value)])
                with self.assertRaisesRegex(catalog.CatalogError, 'ISO date'):
                    self.build()
        self.schema.write_text('{"tables":{}}')
        self.write('dim_player', [dict(self.players[0], fictional_birth_date='2001-02-30')])
        with self.assertRaisesRegex(catalog.CatalogError, 'ISO date'):
            self.build()
        self.write('dim_player', [dict(self.players[0], fictional_birth_date='')])
        self.assertIsNone(self.build()['sourceTables']['dim_player']['rows'][0]['fictional_birth_date'])
        self.write('dim_edition', [dict(self.editions[0], end_date='2026-13-01')])
        with self.assertRaisesRegex(catalog.CatalogError, 'ISO date'):
            self.build()

    def test_source_manifest_is_required_and_upgrade_date_is_authoritative(self):
        self.manifest.unlink()
        with self.assertRaisesRegex(catalog.CatalogError, 'manifest'):
            self.build()
        self.manifest.write_text('{"snapshot_date":"2026-09-11"}')
        (self.upgrade.parent / 'MANIFEST.json').write_text('{"snapshot_date":"2026-09-12"}')
        self.assertEqual(self.build()['snapshotDate'], '2026-09-12')

    def test_numeric_bounds_and_safe_inference(self):
        self.write('dim_player', [dict(self.players[0], external_id='9007199254740992')])
        self.assertEqual(self.build()['sourceTables']['dim_player']['columns']['external_id'], 'TEXT')
        self.write('dim_player', [dict(self.players[0], player_id='9007199254740992')])
        with self.assertRaisesRegex(catalog.CatalogError, 'numeric bounds'):
            self.build()
        self.write('dim_player', self.players)
        with patch.object(catalog, 'MAX_ROWS', 0):
            with self.assertRaisesRegex(catalog.CatalogError, 'Too many rows'):
                self.build()
        with patch.object(catalog, 'MAX_FILE_BYTES', 1):
            with self.assertRaisesRegex(catalog.CatalogError, 'size limit'):
                self.build()

    def test_new_file_during_discovery_is_rejected(self):
        original = catalog.inspect_csv
        added = False

        def inspect_and_change(*args, **kwargs):
            nonlocal added
            result = original(*args, **kwargs)
            if not added:
                self.write('new_during_scan', [{'is_synthetic': '1'}])
                added = True
            return result

        with patch.object(catalog, 'inspect_csv', side_effect=inspect_and_change):
            with self.assertRaisesRegex(catalog.CatalogError, 'changed'):
                self.build()

    def test_schema_grain_and_relationship_metadata_are_preserved(self):
        relationship = {'column': 'player_id', 'references': 'dim_player.player_id'}
        self.schema.write_text(json.dumps({'tables': {'new_events': {'columns': {'event_id': 'text'},
                                         'grain': 'One synthetic event', 'primaryKey': ['event_id'],
                                         'foreignKeys': [relationship]}}}))
        self.write('new_events', [{'event_id': 'E1', 'is_synthetic': '1'}])
        table = next(item for item in self.build()['sourceCatalog']['tables'] if item['name'] == 'new_events')
        self.assertEqual(table['grain'], 'One synthetic event')
        self.assertEqual(table['primaryKey'], ['event_id'])
        self.assertEqual(table['foreignKeys'], [relationship])
        self.assertEqual(table['access'], 'metadata-only')


if __name__ == '__main__':
    unittest.main()
