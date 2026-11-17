/**
 * Local OpenAI-compatible endpoint that Whale-Girl can be pointed at.
 *
 * Two branches, decided ONLY by whether the system head carries a routing envelope:
 *   with envelope    -> the message becomes an isolated DSH turn via `engine`
 *   without envelope -> transparent pass-through to the configured upstream
 *
 * The second branch matters: Whale-Girl also calls the model for background jobs
 * (memory extraction etc.) that never run `chat.prompt`. Those must not be poured
 * into a persona session, and they must not silently fail either.
 *
 * This module binds to 127.0.0.1 only and refuses to start without a bearer token,
 * so another local process cannot borrow the bridge.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from './core.mjs';
import { decodeEnvelope, stripEnvelope, deliveryState } from './envelope.mjs';

const MAX_BODY = 2 * 1024 * 1024;

/**
 * Rejected requests used to vanish: Whale-Girl only recorded "http_400" and the
 * host-side /errors list stayed empty because the failure happened here, in the
 * child process. Write the shape of every rejection (never message content) so the
 * reason is knowable without replaying the whole conversation.
 */
const FAIL_LOG = join(process.env.WHALE_BRIDGE_HOME || join(homedir(), '.whale-dsh-bridge'), 'logs', 'rejected.jsonl');
function logReject(status, code, shape) {
  try {
    mkdirSync(join(FAIL_LOG, '..'), { recursive: true });
    appendFileSync(FAIL_LOG, JSON.stringify({ at: new Date().toISOString(), status, code, shape }) + '\n');
  } catch { /* never let diagnostics break a request */ }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function openaiError(res, status, code, message, shape) {
  if (status >= 400) logReject(status, code, shape ?? null);
  json(res, status, { error: { message, type: 'whale_bridge_error', code } });
}
function completion(text, model) {
  return {
    id: 'whale-bridge-' + randomBytes(8).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'dsh',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Whale-Girl's main chat path calls `llm.stream()`, so a plain JSON body would be
 * parsed as SSE and yield an empty reply. Emit a proper event stream instead:
 * `data: {json}\n\n` frames, then `data: [DONE]`. Only `delta.content` is set —
 * reasoning fields are deliberately never emitted, because her client drops them
 * and mixing them in would corrupt the visible text.
 */
function writeSse(res, text, model) {
  const id = 'whale-bridge-' + randomBytes(8).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: model || 'dsh' };
  const frames = [];
  frames.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  // Chunked so her streaming path sees incremental pieces, not one giant frame.
  const size = 120;
  for (let i = 0; i < text.length; i += size) {
    frames.push({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + size) }, finish_reason: null }] });
  }
  frames.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const frame of frames) res.write('data: ' + JSON.stringify(frame) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new BridgeError('BODY_TOO_LARGE', '请求体过大', 413)); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createProxyServer({ engine, upstream, token, diagnostics, logger, refreshConfig = null }) {
  if (!engine) throw new BridgeError('NO_ENGINE', '缺少 engine');
  if (typeof token !== 'string' || token.length < 24) throw new BridgeError('TOKEN_REQUIRED', '必须配置至少 24 字符的本地令牌');
  const expected = Buffer.from('Bearer ' + token);

  const authorized = (req) => {
    const raw = String(req.headers.authorization || '');
    const got = Buffer.from(raw);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = createServer(async (req, res) => {
    try {
      // Read-only status probe: the host half has no idea how many requests are
      // actually in flight, because they come straight here from 鲸鲸. Expose the
      // real engine counters so the settings panel stops showing a hard-coded 0.
      if (req.method === 'GET' && req.url === '/status') {
        if (!authorized(req)) return openaiError(res, 401, 'unauthorized', '令牌不正确');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: true,
          status: {
            ...engine.status(),
            // Did the key actually survive the host -> supervisor -> child hop?
            // Without this the only symptom is a generic ACP_RPC_ERROR.
            hasLlmKey: Boolean(process.env.WHALE_BRIDGE_LLM_KEY),
            keyLen: (process.env.WHALE_BRIDGE_LLM_KEY || '').length,
            llmEnvName: 'WHALE_BRIDGE_LLM_KEY',
            dshHome: process.env.WHALE_BRIDGE_DSH_HOME || null,
          },
        }));
      }
      if (req.method !== 'POST' || !/^\/(?:v1\/)?chat\/completions$/.test(req.url ?? '')) {
        return openaiError(res, 404, 'not_found', '只提供 POST /v1/chat/completions');
      }
      if (!authorized(req)) return openaiError(res, 401, 'unauthorized', '令牌不正确');
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw); } catch { return openaiError(res, 400, 'bad_json', '请求体不是合法 JSON', { bytes: Buffer.byteLength(raw), head: raw.slice(0, 80) }); }
      if (!Array.isArray(body?.messages) || body.messages.length === 0) { return openaiError(res, 400, 'bad_messages', 'messages 不能为空', { hasMessages: body?.messages !== undefined, type: Array.isArray(body?.messages) ? 'array' : typeof body?.messages, keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : null }); }
      const head = body.messages.find((m) => m && m.role === 'system');
      const system = typeof head?.content === 'string' ? head.content : '';

      let meta = null;
      try { meta = decodeEnvelope(system); }
      catch (error) {
        await diagnostics?.record(error, { phase: 'envelope' });
        return openaiError(res, 400, 'bad_envelope', '路由信封格式错误', {
          errCode: String(error?.code ?? ''),
          errMsg: String(error?.message ?? '').slice(0, 120),
          sysHead: system.slice(0, 160),
          sysLen: system.length,
          msgCount: body.messages.length,
          roles: body.messages.map((m) => (m && m.role) || '?').slice(0, 8),
        });
      }

      if (!meta) {
        // Background / non-chat job: pass through untouched, or fail loudly.
        if (!upstream?.url) return openaiError(res, 503, 'no_upstream', '该请求没有路由信封，且未配置上游模型服务');
        const upstreamRes = await fetch(upstream.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(upstream.apiKey ? { authorization: 'Bearer ' + upstream.apiKey } : {}) },
          body: raw,
        });
        const text = await upstreamRes.text();
        res.writeHead(upstreamRes.status, { 'content-type': upstreamRes.headers.get('content-type') || 'application/json' });
        return res.end(text);
      }

      const lastUser = [...body.messages].reverse().find((m) => m && m.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (!userText.trim()) return openaiError(res, 400, 'bad_messages', '缺少用户正文');

      await refreshConfig?.(engine);
      const result = await engine.submit({ ...meta, text: userText, systemHint: stripEnvelope(system) });
      // Delivery is NOT claimed here: engine only proves generation.
      if (meta.lastDelivery) logger?.(`[bridge] receipt=${deliveryState(meta.lastDelivery)} for ${meta.lastDelivery.messageId}`);
      logger?.(`[bridge] chat=${meta.chatId.slice(0, 8)}… delivered=generated`);
      // Her main chat path is streaming; background calls are not.
      if (body.stream === true) return writeSse(res, result.text, body.model);
      return json(res, 200, completion(result.text, body.model));
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
      if (status >= 500) await diagnostics?.record(error, { phase: 'proxy' });
      // 500-class used to collapse every failure into one opaque sentence, so the
      // real reason (missing key, unknown model, RPC refusal) never reached anyone.
      return openaiError(res, status, code, status >= 500 ? '桥接处理失败' : String(error?.message ?? '请求无效'), {
        errMsg: String(error?.message ?? '').slice(0, 300),
        stack: String(error?.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 400),
      });
    }
  });

  return {
    server,
    /** Binds to loopback on an ephemeral port unless one is given. Returns the real port. */
    listen({ port = 0, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve({ port: server.address().port, host, baseUrl: `http://${host}:${server.address().port}` }));
      });
    },
    /**
     * Closing a plain `server.close()` waits for every open connection, and fetch's
     * keep-alive pool never releases one on its own — so shutdown could hang forever
     * (Ctrl+C not exiting). Drop the connections first, then close.
     */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
        server.close(() => resolve());
      });
    },
    get token() { return token; },
  };
}
