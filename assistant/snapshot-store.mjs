import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './engine.mjs';

const serviceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectories = ['data/synthetic/bi_model'];
const metadataFiles = sourceDirectories.flatMap(directory => ['schema.json', 'MANIFEST.json'].map(name => `${dirname(directory)}/${name}`));
const dimensionNames = new Set(['dim_player', 'dim_edition']);

function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable); Object.freeze(value);
  }
  return value;
}

function validateSnapshot(value, requireRefreshMetadata = false) {
  if (!value || value.provenance?.isSynthetic !== true || !['competitions', 'teams', 'players', 'seasons', 'playerGroups', 'teamGroups'].every(key => Array.isArray(value[key]))) {
    throw new Error('The refreshed snapshot is not a supported synthetic dataset.');
  }
  const ids = new Set(value.competitions.map(row => String(row.id)));
  if (ids.size !== value.competitions.length || value.playerGroups.some(row => !ids.has(String(row.competitionId)))
    || value.teamGroups.some(row => !ids.has(String(row.competitionId)))) throw new Error('The refreshed snapshot contains invalid competition references.');
  if (requireRefreshMetadata || value.sourceVersion !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(value.sourceVersion) || !Array.isArray(value.sourceFingerprint) || !value.sourceFingerprint.length
      || !Array.isArray(value.sourceCatalog?.tables) || !value.sourceTables || typeof value.sourceTables !== 'object') {
      throw new Error('The refreshed source catalog or version is invalid.');
    }
    for (const name of dimensionNames) {
      const table = value.sourceTables[name];
      if (!table || !table.columns || typeof table.columns !== 'object' || Array.isArray(table.columns)
        || !Object.keys(table.columns).length || Object.keys(table.columns).length > 100 || !Array.isArray(table.rows) || table.rows.length > 20000
        || Object.entries(table.columns).some(([column, kind]) => !column.trim() || column.length > 128 || /[\u0000-\u001f]/.test(column) || !['TEXT', 'INTEGER', 'REAL'].includes(kind))) {
        throw new Error(`The refreshed ${name} schema is invalid.`);
      }
      const columns = Object.keys(table.columns).sort();
      if (new Set(columns.map(column => column.toLowerCase())).size !== columns.length
        || table.rows.some(row => !row || typeof row !== 'object' || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(columns)
          || columns.some(column => row[column] !== null && (table.columns[column] === 'TEXT' ? typeof row[column] !== 'string' || row[column].length > 10000
            : table.columns[column] === 'INTEGER' ? !Number.isSafeInteger(row[column]) : typeof row[column] !== 'number' || !Number.isFinite(row[column]))))) {
        throw new Error(`The refreshed ${name} rows do not match its schema.`);
      }
    }
    if (Object.keys(value.sourceTables).some(name => !dimensionNames.has(name))) throw new Error('The refreshed snapshot exposes an unapproved query table.');
  }
  return value;
}

/** A configurable store allows refresh/pinning tests to use temporary sources only. */
export function createSnapshotStore(configuration = {}) {
  const rootPath = resolve(configuration.rootPath || resolve(serviceDirectory, '..'));
  const snapshotPath = resolve(configuration.snapshotPath || resolve(serviceDirectory, 'synthetic-snapshot.json'));
  const builderPath = resolve(configuration.builderPath || resolve(serviceDirectory, 'build_snapshot.py'));
  const directories = (configuration.sourceDirectories || sourceDirectories).map(path => resolve(rootPath, path));
  const allowedDirectories = new Set([...directories, ...directories.map(dirname)]);
  const metadata = new Set((configuration.metadataFiles || metadataFiles).map(path => resolve(rootPath, path)));
  const local = new AsyncLocalStorage();
  let current = immutable(validateSnapshot(JSON.parse(readFileSync(snapshotPath, 'utf8'))));
  let refreshing;
  function approvedPath(item) {
    if (!item || typeof item.path !== 'string' || isAbsolute(item.path) || !['file', 'directory'].includes(item.kind)) throw new Error('The source fingerprint contains an invalid path.');
    const path = resolve(rootPath, item.path), within = relative(rootPath, path);
    if (within.startsWith('..') || isAbsolute(within)
      || (item.kind === 'directory' ? !allowedDirectories.has(path) : !(metadata.has(path) || directories.includes(dirname(path)) && extname(path).toLowerCase() === '.csv'))) {
      throw new Error('The source fingerprint refers to an unapproved input.');
    }
    return path;
  }
  function signature(entries) {
    return JSON.stringify(entries.map(({ path, kind, size, mtimeNs, missing }) => ({ path, kind, size, mtimeNs, ...(missing ? { missing: true } : {}) })).sort((a, b) => a.path.localeCompare(b.path)));
  }
  async function fingerprint(entries) {
    const seen = new Set();
    return Promise.all(entries.map(async item => {
      const path = approvedPath(item);
      if (seen.has(path)) throw new Error('The source fingerprint repeats an input.');
      seen.add(path);
      try {
        const info = await stat(path, { bigint: true });
        if (item.kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error('An approved source changed its file type.');
        return { path: item.path, kind: item.kind, size: Number(info.size), mtimeNs: info.mtimeNs.toString() };
      } catch (error) {
        if (error.code === 'ENOENT') return { path: item.path, kind: item.kind, missing: true };
        throw error;
      }
    }));
  }
  function build(outputPath) {
    return new Promise((resolveBuild, reject) => {
      const child = spawn(configuration.python || process.env.FRMF_SQLITE_PYTHON || 'python3', [builderPath, '--output', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let completed = false; let diagnostics = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('The approved source rebuild exceeded its time limit.')); }, configuration.buildTimeoutMs || 30000);
      function finish(error) { if (completed) return; completed = true; clearTimeout(timer); if (error) reject(error); else resolveBuild(); }
      child.stderr.on('data', chunk => { if (diagnostics.length < 16000) diagnostics += chunk.toString(); });
      child.on('error', () => finish(new Error('The approved snapshot builder could not start.')));
      child.on('close', code => finish(code === 0 ? undefined : new Error('The approved CSV or schema validation failed.', { cause: diagnostics })));
    });
  }
  async function refresh() {
    try {
      if (Array.isArray(current.sourceFingerprint) && current.sourceFingerprint.length
        && signature(await fingerprint(current.sourceFingerprint)) === signature(current.sourceFingerprint)) return current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const temporaryPath = `${snapshotPath}.refresh-${randomUUID()}.json`;
        try {
          await build(temporaryPath);
          const info = await stat(temporaryPath);
          if (info.size > 64 * 1024 * 1024) throw new Error('The refreshed snapshot exceeded its size limit.');
          const candidate = validateSnapshot(JSON.parse(await readFile(temporaryPath, 'utf8')), true);
          if (signature(await fingerprint(candidate.sourceFingerprint)) !== signature(candidate.sourceFingerprint)) continue;
          await rename(temporaryPath, snapshotPath);
          current = immutable(candidate);
          return current;
        } finally { await rm(temporaryPath, { force: true }); }
      }
      throw new Error('The approved source files kept changing during refresh.');
    } catch (error) {
      const reason = error instanceof SyntaxError ? 'The refreshed snapshot is not valid JSON.'
        : error.code ? 'An approved source or staged snapshot could not be read.' : String(error.message).slice(0, 200);
      throw new InputError(`The local data refresh failed. ${reason} Fix the approved sources and try again; stale data was not used.`);
    }
  }
  async function fresh() {
    if (!refreshing) refreshing = refresh().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  return {
    getSnapshot: () => local.getStore() || current,
    async withFreshSnapshot(callback) {
      if (typeof callback !== 'function') throw new TypeError('Provide a snapshot callback.');
      if (local.getStore()) return callback();
      const pinned = await fresh();
      return local.run(pinned, callback);
    },
  };
}

const store = createSnapshotStore();
export const getSnapshot = store.getSnapshot;
export const withFreshSnapshot = store.withFreshSnapshot;
