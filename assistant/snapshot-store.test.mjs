import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSnapshotStore } from './snapshot-store.mjs';

async function fixture(t) {
  const rootPath = await mkdtemp(join(tmpdir(), 'frmf-snapshot-store-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const sourcePath = join(rootPath, 'sources/bi_model'), servicePath = join(rootPath, 'service');
  await mkdir(sourcePath, { recursive: true }); await mkdir(servicePath);
  await writeFile(join(sourcePath, 'dim_player.csv'), 'player_id,player_name\n1,First\n');
  const builderPath = join(servicePath, 'builder.py'), snapshotPath = join(servicePath, 'snapshot.json');
  await writeFile(builderPath, `import csv,hashlib,json,sys\nfrom pathlib import Path\nroot=Path(__file__).resolve().parents[1]\nsource=root/'sources/bi_model'\nfiles=sorted(source.glob('*.csv'))\nentries=[]\ntables=[]\nfor p in files:\n with p.open(newline='') as f:\n  reader=csv.DictReader(f); rows=list(reader); columns=reader.fieldnames\n if 'invalid' in columns: raise ValueError('fixture invalid source')\n tables.append({'name':p.stem,'columns':[{'name':c,'type':'TEXT','nullable':False} for c in columns],'rowCount':len(rows),'access':'metadata-only'})\n entries.append(p)\nfingerprint=[{'path':str(p.relative_to(root)),'kind':'directory' if p.is_dir() else 'file','size':p.stat().st_size,'mtimeNs':str(p.stat().st_mtime_ns)} for p in [source,source.parent,*entries]]\nversion=hashlib.sha256(b''.join(p.name.encode()+p.read_bytes() for p in entries)).hexdigest()\ndata={'provenance':{'isSynthetic':True},'competitions':[],'teams':[],'players':[],'seasons':['2025-2026'],'playerGroups':[],'teamGroups':[],'sourceVersion':version,'sourceFingerprint':fingerprint,'sourceCatalog':{'tables':tables},'sourceTables':{'dim_player':{'columns':{'player_id':'TEXT'},'rows':[]},'dim_edition':{'columns':{'edition_id':'TEXT'},'rows':[]}}}\nPath(sys.argv[sys.argv.index('--output')+1]).write_text(json.dumps(data))\ncount=root/'service/build-count'\ncount.write_text(str(int(count.read_text())+1) if count.exists() else '1')\n`);
  execFileSync('python3', [builderPath, '--output', snapshotPath]);
  const store = createSnapshotStore({ rootPath, builderPath, snapshotPath, sourceDirectories: ['sources/bi_model'], metadataFiles: [] });
  return { rootPath, sourcePath, snapshotPath, store, count: async () => Number(await readFile(join(servicePath, 'build-count'), 'utf8')) };
}

test('unchanged sources reuse the snapshot and changes rebuild once before publication', async t => {
  const f = await fixture(t), first = f.store.getSnapshot().sourceVersion;
  assert.equal(await f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceVersion), first);
  assert.equal(await f.count(), 1);
  await writeFile(join(f.sourcePath, 'dim_player.csv'), 'player_id,player_name,preferred_foot\n1,Updated,left\n');
  const versions = await Promise.all(Array.from({ length: 3 }, () => f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceVersion)));
  assert.ok(versions.every(version => version === versions[0] && version !== first));
  assert.equal(await f.count(), 2);
  assert.ok(f.store.getSnapshot().sourceCatalog.tables[0].columns.some(column => column.name === 'preferred_foot'));
  assert.equal(JSON.parse(await readFile(f.snapshotPath, 'utf8')).sourceVersion, versions[0]);
});

test('adding an approved CSV updates the source catalog without changing process', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourcePath, 'new_source.csv'), 'record_id,observation\n1,Recorded\n');
  const names = await f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceCatalog.tables.map(table => table.name));
  assert.deepEqual(names, ['dim_player', 'new_source']);
  assert.equal(await f.count(), 2);
});

test('an in-flight request remains pinned while later requests adopt the new version', async t => {
  const f = await fixture(t), first = f.store.getSnapshot().sourceVersion;
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const oldRequest = f.store.withFreshSnapshot(async () => {
    entered(); await hold;
    assert.equal(f.store.getSnapshot().sourceVersion, first);
    return f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceVersion);
  });
  await ready;
  await writeFile(join(f.sourcePath, 'dim_player.csv'), 'player_id,player_name\n1,Changed record\n');
  const next = await f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceVersion);
  assert.notEqual(next, first);
  release(); assert.equal(await oldRequest, first);
  assert.equal(f.store.getSnapshot().sourceVersion, next);
});

test('invalid updates fail clearly and never publish or silently answer from the old version', async t => {
  const f = await fixture(t), first = f.store.getSnapshot().sourceVersion;
  await writeFile(join(f.sourcePath, 'dim_player.csv'), 'invalid\nrecord\n');
  let called = false;
  await assert.rejects(f.store.withFreshSnapshot(() => { called = true; }), /local data refresh failed.*stale data was not used/);
  assert.equal(called, false);
  assert.equal(f.store.getSnapshot().sourceVersion, first);
  assert.equal(JSON.parse(await readFile(f.snapshotPath, 'utf8')).sourceVersion, first);
  await writeFile(join(f.sourcePath, 'dim_player.csv'), 'player_id,player_name\n1,Recovered\n');
  assert.notEqual(await f.store.withFreshSnapshot(() => f.store.getSnapshot().sourceVersion), first);
});
