import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, catalog, executePlan, validateRequest, InputError } from './engine.mjs';
import { analystCatalog, validateAnalystRequest } from './analytical-data.mjs';
import { withFreshSnapshot, getSnapshot } from './snapshot-store.mjs';
import { analyseQuestion } from './analytical-agent.mjs';
import { probeLocalModel } from './model-health.mjs';
import { loadConfiguration } from './configuration.mjs';

const page = readFileSync(new URL('./public/index.html', import.meta.url));
const scopeStateScript = readFileSync(new URL('./public/scope-state.mjs', import.meta.url));
const MAX_BODY = 8192;
const MAX_CLARIFICATIONS = 32;
const CLARIFICATION_LIFETIME = 5 * 60 * 1000;
const contextKey = context => JSON.stringify(Object.entries(context ?? {}).sort(([a], [b]) => a.localeCompare(b)));
function legacyContext(context) {
  if (!context || context.seasons === undefined) return context;
  if (!Array.isArray(context.seasons) || context.seasons.length !== 1) throw new InputError('Legacy mode supports one season. Select one season or restart in analyst mode.');
  const { seasons, ...rest } = context;
  if (rest.season !== undefined && rest.season !== seasons[0]) throw new InputError('The season selections conflict.');
  return { ...rest, season: seasons[0] };
}
const allowedOrigin = origin => origin === 'null' || /^https:\/\/([a-z0-9-]+\.)?(powerbi\.com|powerbigov\.us)$/.test(origin)
  || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function handler({ localModel = '', modelBaseUrl, requestDiagnostics = false, analystMode = false } = {}) {
  let plannerBusy = false;
  const pendingClarifications = new Map();
  const pendingAnalyses = new Map();
  return async (req, res) => {
    const wantsStream = req.headers.accept?.split(',').some(value => value.trim().split(';')[0].toLowerCase() === 'application/x-ndjson');
    let streaming = false;
    const startStream = () => {
      if (!wantsStream || streaming || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      streaming = true;
      res.flushHeaders();
    };
    const emit = event => {
      if (streaming && !res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    const reply = (status, data) => {
      if (res.destroyed) return;
      if (!streaming) return json(res, status, data);
      emit({ type: status >= 400 ? 'error' : 'result', data });
      res.end();
    };
    const onProgress = stage => emit({ type: 'progress', stage });
    for (const [token, pending] of pendingClarifications) {
      if (pending.expiresAt <= Date.now()) pendingClarifications.delete(token);
    }
    for (const [token, pending] of pendingAnalyses) {
      if (pending.expiresAt <= Date.now()) pendingAnalyses.delete(token);
    }
    if (requestDiagnostics) {
      let pathname = '[unrecognized-path]';
      try {
        const candidate = new URL(req.url, 'http://localhost').pathname;
        if (['/', '/scope-state.mjs', '/progress-state.mjs', '/api/health', '/api/catalog', '/api/schema', '/api/chat'].includes(candidate)) pathname = candidate;
      } catch { /* Do not log malformed request contents. */ }
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), method: req.method, pathname }));
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin)) return json(res, 403, { error: 'This origin is not allowed in the local synthetic pilot.' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const modelHealth = localModel ? await probeLocalModel({ model: localModel, baseUrl: modelBaseUrl }) : null;
        return json(res, 200, { status: modelHealth && !modelHealth.available ? 'degraded' : 'ok',
          mode: localModel ? (analystMode ? 'local-analyst' : 'local-model-demo') : 'synthetic-demo',
          model: localModel || 'none', server: 'Mac pilot', ...(modelHealth ? { modelHealth } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/catalog') {
        const context = Object.fromEntries(url.searchParams);
        if (url.searchParams.has('seasons')) context.seasons = url.searchParams.getAll('seasons');
        return analystMode
          ? await withFreshSnapshot(() => json(res, 200, analystCatalog(context)))
          : json(res, 200, catalog(legacyContext(context)));
      }
      if (req.method === 'GET' && url.pathname === '/api/schema' && analystMode) {
        return await withFreshSnapshot(() => {
          const snapshot = getSnapshot();
          return json(res, 200, { sourceVersion: snapshot.sourceVersion, snapshotDate: snapshot.provenance.snapshotDate, ...snapshot.sourceCatalog });
        });
      }
      if (req.method === 'GET' && url.pathname === '/season-selection.mjs') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(new URL('./public/season-selection.mjs', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/result-sections.mjs') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(new URL('./public/result-sections.mjs', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/scope-state.mjs') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(scopeStateScript);
      }
      if (req.method === 'GET' && url.pathname === '/progress-state.mjs') {
        const progressStateScript = readFileSync(new URL('./public/progress-state.mjs', import.meta.url));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(progressStateScript);
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" });
        return res.end(page);
      }
      if (req.method !== 'POST' || url.pathname !== '/api/chat') return json(res, 404, { error: 'Endpoint not found.' });
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Use Content-Type: application/json.' });
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(res, 413, { error: 'Request is too large.' });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) return json(res, 413, { error: 'Request is too large.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new InputError('The request body is not valid JSON.'); }
      if (analystMode && localModel) {
        if (plannerBusy) return reply(429, { error: 'The local model is answering another request. Please try again shortly.' });
        startStream();
        // Keep the initial stage compatible with pages opened before source refresh was added.
        onProgress('checking');
        return await withFreshSnapshot(async () => {
          const input = validateAnalystRequest(body);
          const key = contextKey(input.scope);
          let pending;
          if (body.conversationToken !== undefined) {
            pending = typeof body.conversationToken === 'string' && body.conversationToken.length === 36
              ? pendingAnalyses.get(body.conversationToken) : undefined;
            if (!pending || pending.expiresAt <= Date.now() || pending.context !== key) {
              throw new InputError('This clarification expired or the selections changed. Please ask your original question again.');
            }
          }
          if (plannerBusy) return reply(429, { error: 'The local model is answering another request. Please try again shortly.' });
          plannerBusy = true;
          const controller = new AbortController();
          const cancelAnalysis = () => { if (!res.writableEnded) controller.abort(); };
          res.once('close', cancelAnalysis);
          if (res.destroyed) controller.abort();
          try {
            startStream();
            const { _state, ...result } = await analyseQuestion(input, { model: localModel, baseUrl: modelBaseUrl,
              signal: controller.signal, onProgress, state: pending?.state });
            if (res.destroyed) return;
            if (body.conversationToken) pendingAnalyses.delete(body.conversationToken);
            if (_state && result.clarification) {
              while (pendingAnalyses.size >= MAX_CLARIFICATIONS) pendingAnalyses.delete(pendingAnalyses.keys().next().value);
              const token = randomUUID();
              pendingAnalyses.set(token, { context: key, state: _state, expiresAt: Date.now() + CLARIFICATION_LIFETIME });
              result.clarification.token = token;
            }
            return reply(200, result);
          } catch (error) {
            if (res.destroyed) return;
            console.error(`[pilot] Local analysis failed: ${error.name || 'Error'}`);
            const modelHealth = /^The local model /.test(error.message || '')
              ? await probeLocalModel({ model: localModel, baseUrl: modelBaseUrl }) : null;
            return reply(503, { error: modelHealth && !modelHealth.available ? modelHealth.message
              : error.message || 'The local analysis could not finish. Please try again.', mode: 'local-analyst', model: localModel,
              ...(modelHealth ? { modelHealth } : {}) });
          } finally {
            res.off('close', cancelAnalysis);
            plannerBusy = false;
          }
        });
      }
      // Local-model mode validates scope first; only fixed mode calculates here.
      if (body && typeof body === 'object' && !Array.isArray(body)) body.context = legacyContext(body.context);
      const fixed = localModel ? validateRequest(body) : chat(body);
      if (body.clarificationToken !== undefined) {
        const token = body.clarificationToken;
        const pending = typeof token === 'string' && token.length === 36 ? pendingClarifications.get(token) : undefined;
        if (!pending || pending.expiresAt <= Date.now() || !body.rankingBasis
          || pending.question !== body.question || pending.context !== contextKey(body.context)) {
          throw new InputError('This clarification expired or no longer matches the question and selections. Please resubmit the question.');
        }
        pendingClarifications.delete(token);
        startStream();
        const result = executePlan(pending.intent, body, { onProgress });
        return reply(200, { ...result, mode: 'local-model-demo', model: localModel, clarificationResolved: true });
      }
      if (!localModel) { startStream(); return reply(200, fixed); }
      if (plannerBusy) return json(res, 429, { error: 'The local model is answering another request. Please try again shortly.' });
      plannerBusy = true;
      const controller = new AbortController();
      const cancelPlanning = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancelPlanning);
      if (res.destroyed) controller.abort();
      try {
        const { planQuestion } = await import('./local-model.mjs');
        startStream();
        onProgress('interpreting');
        const planned = await planQuestion(body, { model: localModel, baseUrl: modelBaseUrl, signal: controller.signal });
        if (res.destroyed) return;
        if (planned.status === 'unsupported') return reply(200, { answer: planned.reason, rows: [],
          evidence: { ...fixed.evidence, matchCount: 0, matchIds: [], matchIdsTruncated: false }, mode: 'local-model-demo', model: localModel, plannerStatus: 'unsupported' });
        if (planned.status !== 'planned') return reply(503, { error: planned.reason || 'The local model could not plan this request. Please try again or rephrase it.', mode: 'local-model-demo', model: localModel, plannerStatus: planned.status });
        const result = executePlan(planned.intent, body, { onProgress });
        if (result.clarification?.field === 'rankingBasis') {
          while (pendingClarifications.size >= MAX_CLARIFICATIONS) pendingClarifications.delete(pendingClarifications.keys().next().value);
          const token = randomUUID();
          pendingClarifications.set(token, { intent: planned.intent, question: body.question,
            context: contextKey(body.context), expiresAt: Date.now() + CLARIFICATION_LIFETIME });
          result.clarification.token = token;
        }
        return reply(200, { ...result, mode: 'local-model-demo', model: localModel, latencyMs: planned.latencyMs });
      } catch (error) {
        console.error(`[pilot] Local planner unavailable: ${error.name || 'Error'}`);
        if (res.destroyed) return;
        return reply(503, { error: 'The local model is unavailable. Please try again shortly.', mode: 'local-model-demo', model: localModel });
      } finally {
        res.off('close', cancelPlanning);
        plannerBusy = false;
      }
    } catch (error) {
      if (error instanceof InputError) return reply(400, { error: error.message });
      console.error(`[pilot] Request failed: ${error.name || 'Error'}`);
      if (!res.headersSent || streaming) return reply(500, { error: 'The pilot could not complete this request. Please try again.' });
      res.end();
    }
  };
}

export function createPilotServer(options = {}) {
  const { key, cert, ...config } = options;
  const server = key && cert ? createHttpsServer({ key, cert }, handler(config)) : createHttpServer(handler(config));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    loadConfiguration();
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 8765);
    const tlsKey = process.env.TLS_KEY;
    const tlsCert = process.env.TLS_CERT;
    if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('Set both TLS_KEY and TLS_CERT, or neither.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.FRMF_ALLOW_LAN_DEMO !== '1') {
      throw new Error('This unauthenticated synthetic pilot binds only to loopback. Set FRMF_ALLOW_LAN_DEMO=1 explicitly for an isolated LAN test.');
    }
    const options = { localModel: process.env.FRMF_LOCAL_MODEL || '', modelBaseUrl: process.env.FRMF_MODEL_BASE_URL || undefined,
      requestDiagnostics: process.env.FRMF_REQUEST_DIAGNOSTICS === '1', analystMode: process.env.FRMF_ASSISTANT_MODE !== 'legacy' };
    if (tlsKey) { options.key = readFileSync(tlsKey); options.cert = readFileSync(tlsCert); }
    const server = createPilotServer(options);
    server.on('error', error => { console.error(`[pilot] Cannot listen: ${error.code || error.message}`); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`FRMF synthetic pilot: ${tlsKey ? 'https' : 'http'}://${host}:${port} · model ${options.localModel || 'none'}`));
  } catch (error) {
    console.error(`[pilot] Cannot start: ${error.message}`);
    process.exitCode = 1;
  }
}
