import { readFileSync, openSync, closeSync, fstatSync, appendFileSync, fsyncSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';

function parseInbox(text) {
  const ids = new Set();
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.platformMessageId !== 'string' || !record.platformMessageId) throw new Error('invalid_record');
      ids.add(record.platformMessageId);
    } catch {
      throw new Error('probe_inbox_corrupt');
    }
  }
  return ids;
}
// 纯合成输入校验，不读取宿主或密钥，也不连接网络。
if (process.argv[2] === '--check-inbox') {
  try {
    process.stdout.write(JSON.stringify({ valid: true, unique: parseInbox(readFileSync(0, 'utf8')).size }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ valid: false, code: 'probe_inbox_corrupt' }) + '\n');
    process.exit(1);
  }
  process.exit(0);
}

// 无模型、无新依赖的临时端点。只允许当前合成 run 的消息，不执行消息内容。
const [role, runId] = process.argv.slice(-2);
if (process.env.P0_ALLOW_RUN !== '1' || !['claw', 'hqdev'].includes(role) || !/^[a-f0-9-]{36}$/.test(runId)) process.exit(2);
const expectedName = role === 'claw' ? 'pi-claw' : 'pi-hqdev';
const peerName = role === 'claw' ? 'pi-hqdev' : 'pi-claw';
const base = 'https://relay.tsac.cc';
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let ws;
let heartbeat;
let droppedMessage;
let queue = Promise.resolve();
let commandQueue = Promise.resolve();
let connectionNo = 0;
let shuttingDown = false;
const registrations = new Map();
const safeError = e => e?.publicCode ?? e?.name ?? 'unknown';
function fail(code) { const e = new Error('P0 operation failed'); e.publicCode = code; throw e; }
function emitError(e) { out({ event: 'error', code: safeError(e) }); }
const pid = execFileSync('systemctl', ['--user', 'show', 'pi-web.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim();
if (pid === '0') fail('host_not_running');
const hostEnv = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(x => x.startsWith('HOME=') || x.startsWith('PI_CODING_AGENT_DIR=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
for (const key of ['HOME', 'PI_CODING_AGENT_DIR']) {
  if (hostEnv[key]) process.env[key] = hostEnv[key]; else delete process.env[key];
}
const cwd = execFileSync('systemctl', ['--user', 'show', 'pi-web.service', '-p', 'WorkingDirectory', '--value'], { encoding: 'utf8' }).trim();
const { getAgentDir } = await import(join(cwd, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
const keyPath = join(getAgentDir(), '.secrets', 'relaycast.key');
const keyFd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
const keyStat = fstatSync(keyFd);
if ((keyStat.mode & 0o777) !== 0o600 || keyStat.uid !== process.getuid()) fail('unsafe_key_metadata');
const token = readFileSync(keyFd, 'utf8').trim();
closeSync(keyFd);
if (!token.startsWith('at_live_')) fail('unexpected_key_type');
const inboxDir = process.env.P0_INBOX ?? mkdtempSync(join(tmpdir(), `pi-relay-p0-${role}-`));
if (!inboxDir.startsWith(`/tmp/pi-relay-p0-${role}-`)) fail('invalid_probe_directory');
const inboxFile = join(inboxDir, 'inbox.jsonl');
let seen = new Set();
if (existsSync(inboxFile)) {
  try { seen = parseInbox(readFileSync(inboxFile, 'utf8')); }
  catch { out({ event: 'error', code: 'probe_inbox_corrupt' }); process.exit(1); }
}
function persist(record) {
  if (seen.has(record.platformMessageId)) return false;
  appendFileSync(inboxFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  const fd = openSync(inboxFile, 'r'); fsyncSync(fd); closeSync(fd);
  seen.add(record.platformMessageId);
  return true;
}
async function api(method, path, body, key) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(base + '/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), redirect: 'error' });
  if (!response.ok) fail('api_http_' + response.status);
  const parsed = await response.json();
  if (parsed.ok !== true) fail('api_not_ok');
  return parsed.data;
}
function parseSynthetic(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  return msg?.protocol === 'pi-tsgw-communication' && msg.version === 1 && msg.contextId === runId ? msg : null;
}
function ack(frame, socket) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'delivery.ack', agent: frame.agent, up_to_seq: frame.seq }));
}
async function handleFrame(frame, socket) {
  if (frame.type === 'reply' && registrations.has(frame.id)) {
    const pending = registrations.get(frame.id); registrations.delete(frame.id);
    if (frame.ok !== true) pending.reject(new Error('registration_failed')); else pending.resolve(frame.data);
    return;
  }
  if (frame.type === 'error') fail('wire_rejected');
  if (frame.type !== 'deliver') return;
  const data = frame.payload?.data ?? {};
  const text = data.message?.text ?? data.text;
  const msg = typeof text === 'string' ? parseSynthetic(text) : null;
  if (frame.agent !== expectedName) fail('wrong_transport_recipient');
  if (msg?.messageId === droppedMessage) {
    // 明确模拟 SDK 先 ACK、应用尚未写盘的消费崩溃窗口。
    ack(frame, socket);
    out({ event: 'dropped_before_persist', messageId: msg.messageId, platformMessageId: frame.msg_id, deliveryId: frame.delivery_id });
    droppedMessage = undefined;
    return;
  }
  const added = persist({ platformMessageId: frame.msg_id, seq: frame.seq, eventType: frame.payload?.type, ...(msg ? { text } : {}) });
  ack(frame, socket);
  if (msg) out({ event: 'delivery', duplicate: !added, eventType: frame.payload.type, platformMessageId: frame.msg_id, messageId: msg.messageId, senderId: data.message?.agent_id ?? data.from_agent_id ?? data.agent_id, text });
}
async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) fail('already_connected');
  const minted = await api('POST', 'agent/node-token', {});
  const address = new URL('/v1/node/ws', base); address.protocol = 'wss:';
  if (address.search) fail('credential_url_query');
  const socket = new WebSocket(address, { headers: { Authorization: 'Bearer ' + minted.token } });
  ws = socket;
  const id = runId + '-register-' + (++connectionNo);
  const registered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { registrations.delete(id); reject(new Error('registration_timeout')); }, 12000);
    registrations.set(id, { resolve: x => { clearTimeout(timeout); resolve(x); }, reject: e => { clearTimeout(timeout); reject(e); } });
  });
  socket.addEventListener('open', () => socket.send(JSON.stringify({ v: 1, id, type: 'node.register', node_id: minted.node_id, name: minted.node_name, capabilities: [], max_agents: 1, tags: ['implicit', 'direct', 'p0'], version: 'pi-tsgw-p0/v1' })));
  socket.addEventListener('message', event => {
    queue = queue.then(async () => {
      let frame;
      try { frame = JSON.parse(String(event.data)); }
      catch { fail('invalid_wire_json'); }
      await handleFrame(frame, socket);
    }).catch(emitError);
  });
  socket.addEventListener('error', () => { if (!shuttingDown) out({ event: 'socket_error' }); });
  socket.addEventListener('close', () => { clearInterval(heartbeat); if (ws === socket) ws = undefined; });
  const data = await registered;
  heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'node.heartbeat', active_agents: 1, handlers_live: true }));
  }, 30000);
  return { nodeId: minted.node_id, registrationContract: data.registration_contract ?? null };
}
async function disconnect() {
  clearInterval(heartbeat);
  const socket = ws;
  if (!socket) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close_timeout')), 4000);
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.close(1000, 'P0 probe disconnect');
  });
}
async function execute(cmd) {
  switch (cmd.action) {
    case 'dm': {
      const msg = parseSynthetic(cmd.text); if (!msg) fail('non_synthetic_send');
      const result = await api('POST', 'dm', { to: peerName, text: cmd.text, data: { p0: true } }, msg.messageId);
      return { id: result.message?.id ?? result.id, conversationId: result.conversation_id };
    }
    case 'announce': {
      const msg = parseSynthetic(cmd.text); if (!msg) fail('non_synthetic_announce');
      const result = await api('POST', 'channels/pi-sessions/messages', { text: cmd.text, data: { p0: true } }, msg.messageId);
      return { id: result.id };
    }
    case 'conversations': return (await api('GET', 'dm/conversations')).map(x => ({ id: x.id }));
    case 'history': case 'recover': {
      const q = new URLSearchParams({ limit: String(cmd.limit ?? 100) });
      if (cmd.before) q.set('before', cmd.before); if (cmd.after) q.set('after', cmd.after);
      const rows = await api('GET', 'dm/' + encodeURIComponent(cmd.conversationId) + '/messages?' + q);
      const own = rows.filter(row => parseSynthetic(row.text));
      if (cmd.action === 'recover') {
        let added = 0;
        for (const row of own.slice().reverse()) added += Number(persist({ platformMessageId: row.id, eventType: 'rest_recovery', text: row.text }));
        return { added, ids: own.map(row => row.id) };
      }
      return own.map(row => ({ id: row.id, text: row.text, senderId: row.agent_id }));
    }
    case 'channelHistory': return (await api('GET', 'channels/pi-sessions/messages?limit=100')).filter(row => parseSynthetic(row.text)).map(row => ({ id: row.id, text: row.text, senderId: row.agent_id }));
    case 'deliveries': return (await api('GET', 'deliveries?status=acked&limit=200')).map(row => ({ id: row.id, status: row.status, messageId: row.message_id ?? row.messageId ?? row.message?.id ?? row.msg_id }));
    case 'setDrop': droppedMessage = cmd.messageId; return { armed: true };
    case 'persisted': return { persisted: seen.has(cmd.platformMessageId) };
    case 'disconnect': await disconnect(); return { disconnected: true };
    case 'reconnect': return await connect();
    case 'negative': {
      const anonymous = await fetch(base + '/v1/agent', { signal: AbortSignal.timeout(12000), redirect: 'error' });
      const management = await fetch(base + '/v1/agents', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(12000), redirect: 'error' });
      return { anonymousStatus: anonymous.status, managementStatus: management.status };
    }
    case 'crash': out({ event: 'intentional_probe_exit', code: 77 }); process.exit(77);
    case 'quit': shuttingDown = true; await disconnect(); return { quit: true };
    default: fail('unknown_command');
  }
}
try {
  const identity = await api('GET', 'agent');
  if (identity.name !== expectedName) fail('credential_identity_mismatch');
  await api('POST', 'channels/pi-sessions/join', {});
  const connection = await connect();
  out({ event: 'ready', role, agentId: identity.id, agentName: identity.name, agentDir: getAgentDir(), keyMode: '0600', inboxDir, ...connection });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    commandQueue = commandQueue.then(async () => {
      let cmd;
      try {
        cmd = JSON.parse(line);
        const data = await execute(cmd);
        out({ event: 'reply', commandId: cmd.id, ok: true, data });
        if (cmd.action === 'quit') { rl.close(); process.exit(0); }
      } catch (e) { out({ event: 'reply', commandId: cmd?.id, ok: false, code: safeError(e) }); }
    });
  });
  rl.on('close', () => { if (!shuttingDown) { shuttingDown = true; void disconnect().finally(() => process.exit(0)); } });
} catch (e) { emitError(e); process.exit(1); }
