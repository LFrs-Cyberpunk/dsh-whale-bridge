import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AcpClient } from '../src/adapters/acp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'fixtures', 'fake-acp-server.mjs');
const node = process.execPath;

function client(extraEnv = {}, opts = {}) {
  return new AcpClient({ command: node, args: [fake], cwd: here, env: { ...process.env, ...extraEnv }, requestTimeoutMs: opts.timeout ?? 5000 });
}

test('start performs the ACP handshake and advertises no extra powers', async () => {
  const c = await client().start();
  try {
    assert.equal(c.protocolVersion, 1);
    assert.equal(c.agentInfo?.name, 'deepseek-harness-acp');
  } finally { await c.close(); }
});

test('session/new then prompt returns the assembled assistant text', async () => {
  const c = await client().start();
  try {
    const sessionId = await c.newSession({ cwd: here });
    assert.match(sessionId, /^fake-/);
    const r = await c.prompt({ sessionId, text: '你好' });
    assert.equal(r.text, 'answer:你好'); // chunks concatenated, in order
    assert.equal(r.stopReason, 'end_turn');
  } finally { await c.close(); }
});

test('thoughts and tool traffic never leak into the reply', async () => {
  const c = await client().start();
  try {
    const sessionId = await c.newSession({ cwd: here });
    const r = await c.prompt({ sessionId, text: 'x' });
    assert.ok(!r.text.includes('内部思考'), r.text);
    assert.equal(c.thoughts, 1);
    assert.equal(c.toolCalls, 1);
  } finally { await c.close(); }
});

test('each prompt starts from an empty buffer', async () => {
  const c = await client().start();
  try {
    const sessionId = await c.newSession({ cwd: here });
    await c.prompt({ sessionId, text: 'one' });
    const second = await c.prompt({ sessionId, text: 'two' });
    assert.equal(second.text, 'answer:two');
  } finally { await c.close(); }
});

test('an empty turn is reported, not silently returned as blank text', async () => {
  const c = await client({ FAKE_ACP_EMPTY: '1' }).start();
  try {
    const sessionId = await c.newSession({ cwd: here });
    await assert.rejects(c.prompt({ sessionId, text: 'x' }), { code: 'ACP_EMPTY_REPLY' });
  } finally { await c.close(); }
});

test('unknown session and empty text are rejected before writing', async () => {
  const c = await client().start();
  try {
    await assert.rejects(c.prompt({ sessionId: 'nope', text: 'x' }), { code: 'ACP_UNKNOWN_SESSION' });
    const sessionId = await c.newSession({ cwd: here });
    await assert.rejects(c.prompt({ sessionId, text: '' }), { code: 'ACP_BAD_PROMPT' });
  } finally { await c.close(); }
});

test('times out with a stable code', async () => {
  const c = await client({ FAKE_ACP_HANG: '1' }, { timeout: 120 }).start();
  try {
    const sessionId = await c.newSession({ cwd: here });
    await assert.rejects(c.prompt({ sessionId, text: 'x' }), { code: 'ACP_TIMEOUT' });
  } finally { await c.close(); }
});

test('single-use start guard', async () => {
  const c = await client().start();
  try { await assert.rejects(c.start(), { code: 'ACP_ALREADY_STARTED' }); }
  finally { await c.close(); }
});
