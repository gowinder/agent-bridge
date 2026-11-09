#!/usr/bin/env python3
"""Probe the Codex desktop IPC socket (~/.codex/ipc/ipc.sock).

Only works for Codex threads the desktop currently holds (stream role = owner);
ChatGPT-native conversations are not handled by this IPC.

Usage:
  codex-ipc-probe.py <threadId>          read-only owner discovery
  codex-ipc-probe.py <threadId> --send   send "只回复 OK-IPC" into that thread
"""
import json
import os
import socket
import struct
import sys
import uuid

SOCK = os.path.expanduser('~/.codex/ipc/ipc.sock')


def enc(obj):
    b = json.dumps(obj, ensure_ascii=False).encode()
    return struct.pack('<I', len(b)) + b


def read_exact(s, n):
    buf = b''
    while len(buf) < n:
        chunk = s.recv(n - len(buf))
        if not chunk:
            raise EOFError('closed')
        buf += chunk
    return buf


def recv(s):
    n = struct.unpack('<I', read_exact(s, 4))[0]
    return json.loads(read_exact(s, n))


def req(s, msg, timeout):
    s.sendall(enc(msg))
    s.settimeout(timeout)
    while True:
        m = recv(s)
        if m.get('type') == 'client-discovery-request':
            s.sendall(enc({'type': 'client-discovery-response',
                           'requestId': m['requestId'],
                           'response': {'canHandle': False}}))
            continue
        if m.get('type') == 'response' and m.get('requestId') == msg['requestId']:
            return m


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    tid = sys.argv[1]
    do_send = '--send' in sys.argv
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(10)
    s.connect(SOCK)

    r = req(s, {'type': 'request', 'requestId': str(uuid.uuid4()),
                'method': 'initialize', 'params': {'clientType': 'bridge-probe'}}, 10)
    print('initialize:', json.dumps(r, ensure_ascii=False))
    if r.get('resultType') != 'success':
        return 1
    cid = r['result']['clientId']

    r = req(s, {'type': 'request', 'requestId': str(uuid.uuid4()),
                'sourceClientId': cid, 'version': 1,
                'method': 'thread-owner-discovery',
                'params': {'hostId': 'local', 'conversationId': tid}}, 10)
    print('discovery:', json.dumps(r, ensure_ascii=False))
    owner = r.get('handledByClientId')
    if r.get('resultType') != 'success' or not owner:
        print('thread not held by the desktop -> no-client-found')
        return 2

    if not do_send:
        return 0

    r = req(s, {'type': 'request', 'requestId': str(uuid.uuid4()),
                'sourceClientId': cid, 'targetClientId': owner,
                'version': 2, 'timeoutMs': 180000,
                'method': 'thread-follower-start-turn',
                'params': {'conversationId': tid, 'turnStart': {
                    'request': {'threadId': tid,
                                'input': [{'type': 'text', 'text': '只回复 OK-IPC',
                                           'text_elements': []}]},
                    'context': {}}}}, 180)
    print('turn:', json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
