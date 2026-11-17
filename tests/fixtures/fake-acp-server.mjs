// Fake ACP server used ONLY by tests. Mirrors the real protocol shape read from
// @deepseek-ai/dsh-acp: prompt returns {stopReason} and text arrives as
// session/update notifications (agent_message_chunk / agent_thought_chunk).
import { createInterface } from 'node:readline';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sessions = new Set();
let nextSession = 1;

function update(sessionId, u) { out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } }); }

createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }

  if (m.method === 'initialize') {
    if (m.params?.protocolVersion !== 1) {
      out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unsupported protocol version' } });
      return;
    }
    out({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: 1,
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: false, audio: false, embeddedContext: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } },
      authMethods: [],
    } });
    return;
  }

  if (m.method === 'session/new') {
    const id = `fake-${nextSession++}`;
    sessions.add(id);
    out({ jsonrpc: '2.0', id: m.id, result: { sessionId: id, configOptions: [] } });
    return;
  }

  // Mirrors the real host: resume returns ONLY { configOptions } (no sessionId),
  // requires cwd, and rejects an id it does not know.
  if (m.method === 'session/resume') {
    const { sessionId, cwd } = m.params ?? {};
    if (!cwd) {
      out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params' } });
      return;
    }
    if (!sessions.has(sessionId)) {
      out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown session: ${sessionId}` } });
      return;
    }
    out({ jsonrpc: '2.0', id: m.id, result: { configOptions: [] } });
    return;
  }

  if (m.method === 'session/list') {
    out({ jsonrpc: '2.0', id: m.id, result: { sessions: [...sessions].map((sessionId) => ({ sessionId, cwd: process.cwd() })) } });
    return;
  }

  if (m.method === 'session/prompt') {
    // The client must reject this permission request.
    out({ jsonrpc: '2.0', id: `perm-${m.id}`, method: 'session/request_permission', params: { sessionId: m.params.sessionId, title: 'run shell' } });
    if (process.env.FAKE_ACP_HANG === '1') return;
    if (!sessions.has(m.params.sessionId)) {
      out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown session' } });
      return;
    }
    const text = (m.params.prompt ?? []).map((p) => p.text ?? '').join('');
    if (process.env.FAKE_ACP_EMPTY === '1') {
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      return;
    }
    // Thoughts must never be mistaken for the reply.
    update(m.params.sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: 'a1', content: { type: 'text', text: '内部思考…' } });
    update(m.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'search', kind: 'other', status: 'in_progress' });
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'answer:' } });
    update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: text } });
    update(m.params.sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 });
    out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (m.method === 'session/close') {
    sessions.delete(m.params.sessionId);
    out({ jsonrpc: '2.0', id: m.id, result: {} });
    return;
  }

  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
