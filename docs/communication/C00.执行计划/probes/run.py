import contextlib
import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

if '--run' not in sys.argv:
    print(json.dumps({'result': 'not_run', 'instruction': '获授权后使用 --run；会向正式工作区发送合成消息'}))
    raise SystemExit(0)

RUN = str(uuid.uuid4())
WORKER_PATH = Path(__file__).with_name('worker.mjs')
SOURCE = WORKER_PATH.read_text()
checks = []
workers = []
phase = 'start'


def check(value, name):
    if not value:
        raise AssertionError(name)
    checks.append(name)


class Worker:
    def __init__(self, role, inbox=None):
        self.role = role
        self.events = queue.Queue()
        self.pending = []
        self.seq = 0
        env = os.environ.copy()
        env['P0_ALLOW_RUN'] = '1'
        if inbox:
            env['P0_INBOX'] = inbox
        if role == 'claw':
            command = ['node', str(WORKER_PATH), role, RUN]
        else:
            prefix = 'P0_ALLOW_RUN=1 ' + ('P0_INBOX=' + shlex.quote(inbox) + ' ' if inbox else '')
            command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'ts@hq-dev', prefix + 'node --input-type=module -e ' + shlex.quote(SOURCE) + ' ' + role + ' ' + RUN]
        self.proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        workers.append(self)
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError('probe_pipes_unavailable')
        self.input = self.proc.stdin
        self.output = self.proc.stdout
        threading.Thread(target=self.reader, daemon=True).start()
        self.ready = self.wait(lambda e: e.get('event') == 'ready', timeout=45)
        check(self.ready['registrationContract'] is not None, role + '_authenticated_registration')

    def reader(self):
        for line in self.output:
            try:
                self.events.put(json.loads(line))
            except Exception:
                self.events.put({'event': 'error', 'code': 'unexpected_stdout'})
        self.events.put({'event': 'eof'})

    def wait(self, predicate, timeout=20):
        for i, event in enumerate(self.pending):
            if predicate(event):
                return self.pending.pop(i)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                event = self.events.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty:
                break
            if event.get('event') in ('error', 'socket_error', 'eof'):
                raise RuntimeError(self.role + '_' + event.get('code', event['event']))
            if predicate(event):
                return event
            self.pending.append(event)
        raise RuntimeError(self.role + '_event_timeout')

    def send(self, value):
        self.input.write(json.dumps(value, ensure_ascii=False) + '\n')
        self.input.flush()

    def rpc(self, action, **kwargs):
        self.seq += 1
        cid = self.role + '-' + str(self.seq)
        self.send({'id': cid, 'action': action, **kwargs})
        result = self.wait(lambda e: e.get('event') == 'reply' and e.get('commandId') == cid)
        if not result.get('ok'):
            raise RuntimeError(self.role + '_' + action + '_' + result.get('code', 'failed'))
        return result['data']

    def delivery(self, mid, event='delivery'):
        return self.wait(lambda e: e.get('event') == event and e.get('messageId') == mid)

    def stop(self):
        if self.proc.poll() is None:
            with contextlib.suppress(Exception):
                self.rpc('quit')
            try:
                self.input.close()
                self.proc.wait(timeout=6)
            except Exception:
                self.proc.terminate()


def envelope(kind, source, target, **kwargs):
    msg = {
        'protocol': 'pi-tsgw-communication', 'version': 1, 'kind': kind,
        'messageId': str(uuid.uuid4()), 'contextId': RUN,
        'from': {'deviceId': 'p0-' + source.role, 'sessionId': 'p0-session-' + source.role},
        'to': {'deviceId': 'p0-' + target.role, 'sessionId': 'p0-session-' + target.role},
        'taskId': 'p0-task-' + source.role, 'roundId': 1,
        'taskExpiresAt': int(time.time() * 1000) + 300000,
        'payload': {'synthetic': True, 'text': '仅测试 JSON 透传\n无模型、无工具执行', 'nested': {'error': 'session_paused'}},
    }
    msg.update(kwargs)
    return json.dumps(msg, ensure_ascii=False, separators=(',', ':'))


def dm(sender, receiver, kind, **kwargs):
    text = envelope(kind, sender, receiver, **kwargs)
    try:
        msg = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError('synthetic_envelope_invalid') from exc
    sent = sender.rpc('dm', text=text)
    got = receiver.delivery(msg['messageId'])
    check(got['text'] == text, kind + '_text_complete')
    check(got['senderId'] == sender.ready['agentId'], kind + '_server_sender_binding')
    check(got['platformMessageId'] == sent['id'], kind + '_platform_id')
    return sent, text


try:
    phase = 'connect_two_devices'
    a = Worker('claw')
    b = Worker('hqdev')
    check(a.ready['agentName'] == 'pi-claw' and b.ready['agentName'] == 'pi-hqdev', 'device_credentials_distinct')
    for actor in (a, b):
        neg = actor.rpc('negative')
        check(neg['anonymousStatus'] == 401, actor.role + '_anonymous_rejected')
        check(neg['managementStatus'] in (401, 403), actor.role + '_agent_not_workspace_admin')
    print(json.dumps({'phase': phase, 'result': 'passed', 'runId': RUN}), flush=True)

    phase = 'bidirectional_dm_wire_fields'
    first, request_text = dm(a, b, 'request')
    conversation_id = first['conversationId']
    request_id = json.loads(request_text)['messageId']
    dm(b, a, 'accepted', correlationId=request_id, stateRevision=1)
    dm(b, a, 'input_required', correlationId=request_id, stateRevision=2)
    dm(a, b, 'input', expectedRoundId=1, roundId=2, correlationId=request_id)
    dm(b, a, 'result', stateRevision=3, correlationId=request_id)
    dm(a, b, 'received', correlationId=request_id)
    dm(b, a, 'request')
    dm(a, b, 'accepted', stateRevision=1)
    dm(a, b, 'result', stateRevision=2)
    dm(b, a, 'received')
    dm(a, b, 'task_query', originalMessageId=request_id)
    dm(b, a, 'task_state', originalRequestMessageId=request_id, stateRevision=3)
    duplicate = a.rpc('dm', text=request_text)
    check(duplicate['id'] == first['id'], 'idempotency_same_platform_message')
    rows = a.rpc('history', conversationId=conversation_id)
    check(sum(row['id'] == first['id'] for row in rows) == 1, 'idempotency_history_single_copy')
    expected = [row['id'] for row in rows]
    check(expected == sorted(expected, key=int, reverse=True), 'dm_history_descending')
    paged = []
    before = None
    while True:
        page = b.rpc('history', conversationId=conversation_id, limit=2, **({'before': before} if before else {}))
        if not page:
            break
        paged.extend(row['id'] for row in page)
        before = page[-1]['id']
        check(len(paged) <= 24, 'pagination_bounded')
    check(paged == expected, 'dm_before_pages_complete')
    interior = a.rpc('history', conversationId=conversation_id, after=expected[-1], before=expected[0])
    check([r['id'] for r in interior] == expected[1:-1], 'dm_after_before_exclusive')
    check(conversation_id in [x['id'] for x in b.rpc('conversations')], 'conversation_enumeration_without_limit')
    print(json.dumps({'phase': phase, 'result': 'passed', 'dmHistoryMessages': len(rows)}), flush=True)

    phase = 'discovery_channel_wire'
    for sender, receiver in ((a, b), (b, a)):
        text = envelope('announce', sender, receiver, payload={'synthetic': True, 'deviceLabel': sender.role, 'sessionName': 'P0 合成会话，不是真实会话', 'lastMessageAt': int(time.time() * 1000)})
        sent = sender.rpc('announce', text=text)
        got = receiver.delivery(json.loads(text)['messageId'])
        check(got['text'] == text, sender.role + '_channel_ws_text_complete')
        history = receiver.rpc('channelHistory')
        check(any(row['id'] == got['platformMessageId'] and row['text'] == text for row in history), sender.role + '_channel_history_matches_ws')
        check(any(row['id'] == got['platformMessageId'] and row['senderId'] == sender.ready['agentId'] for row in history), sender.role + '_channel_authenticated_sender')
    print(json.dumps({'phase': phase, 'result': 'passed'}), flush=True)

    phase = 'client_disconnect_history_and_reconnect'
    prior_node = b.ready['nodeId']
    b.rpc('disconnect')
    offline_text = envelope('request', a, b, payload={'synthetic': True, 'case': 'disconnected_receiver'})
    offline_sent = a.rpc('dm', text=offline_text)
    offline_rows = b.rpc('history', conversationId=conversation_id)
    check(any(row['id'] == offline_sent['id'] and row['text'] == offline_text for row in offline_rows), 'offline_message_retained_in_rest')
    reconnect = b.rpc('reconnect')
    check(reconnect['nodeId'] == prior_node, 'same_device_node_on_reconnect')
    replayed = b.delivery(json.loads(offline_text)['messageId'])
    check(replayed['text'] == offline_text, 'unacked_message_replayed_after_reconnect')
    print(json.dumps({'phase': phase, 'result': 'passed'}), flush=True)

    phase = 'ack_before_application_persistence'
    lost_text = envelope('request', a, b, payload={'synthetic': True, 'case': 'ack_then_probe_exit'})
    lost_mid = json.loads(lost_text)['messageId']
    b.rpc('setDrop', messageId=lost_mid)
    lost_sent = a.rpc('dm', text=lost_text)
    dropped = b.delivery(lost_mid, event='dropped_before_persist')
    check(not b.rpc('persisted', platformMessageId=lost_sent['id'])['persisted'], 'acked_message_not_in_application_inbox')
    acked = False
    for _ in range(15):
        deliveries = b.rpc('deliveries')
        if any(d['id'] == dropped['deliveryId'] and d['status'] == 'acked' for d in deliveries):
            acked = True
            break
        time.sleep(0.2)
    check(acked, 'platform_ack_confirmed_via_rest')
    inbox = b.ready['inboxDir']
    b.send({'id': 'intentional-exit', 'action': 'crash'})
    b.proc.wait(timeout=8)
    check(b.proc.returncode == 77, 'only_probe_process_exited')
    b2 = Worker('hqdev', inbox=inbox)
    check(b2.ready['nodeId'] == prior_node, 'device_identity_preserved_after_probe_restart')
    check(not b2.rpc('persisted', platformMessageId=lost_sent['id'])['persisted'], 'application_loss_persists_across_probe_restart')
    recovered = b2.rpc('recover', conversationId=conversation_id)
    check(lost_sent['id'] in recovered['ids'], 'acked_message_still_readable_in_history')
    check(b2.rpc('persisted', platformMessageId=lost_sent['id'])['persisted'], 'history_recovers_acked_application_loss')
    check(b2.rpc('recover', conversationId=conversation_id)['added'] == 0, 'second_history_recovery_deduplicated')
    print(json.dumps({'phase': phase, 'result': 'passed'}), flush=True)

    print(json.dumps({'result': 'PASS', 'runId': RUN, 'checks': len(checks), 'checksPassed': checks, 'scope': 'native transport only; synthetic endpoints, not Pi sessions; no model calls or service restart', 'conversationId': conversation_id}, ensure_ascii=False), flush=True)
except Exception as e:
    print(json.dumps({'result': 'STOPPED', 'phase': phase, 'errorType': type(e).__name__, 'reason': str(e) if isinstance(e, (RuntimeError, AssertionError)) else 'unexpected_error', 'runId': RUN, 'checksPassed': len(checks), 'automaticRetry': False}), flush=True)
    raise SystemExit(1) from None
finally:
    for worker in workers:
        worker.stop()
