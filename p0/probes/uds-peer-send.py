#!/usr/bin/env python3
"""向运行中的 Claude Code / Claude Desktop 会话注入一条 peer 消息（走 /tmp/cc-socks UDS）。

协议（CLI 2.1.319 实测）：每条连接一行 JSON。
  {"msg_id":"<uuid4>","type":"user","message":{"role":"user","content":"<envelope>"},
   "priority":"next","from":"uds:/tmp/cc-socks/<本进程 pid>.sock"}
接收端用 LOCAL_PEERPID 校验发送进程，要求 from 里的 socket 名等于发送进程 pid。

用法：
  uds-peer-send.py <目标 pid> [目标 sock 路径]     打印最近打开的会话 socket
  uds-peer-send.py <目标 pid> --send "文本"
"""
import json
import os
import socket
import sys
import time
import uuid

DIR = '/tmp/cc-socks'
OWN = os.path.join(DIR, '%d.sock' % os.getpid())


def target_sock(pid):
    p = os.path.join(DIR, '%d.sock' % pid)
    if not os.path.exists(p):
        for n in sorted(os.listdir(DIR)):
            if n.startswith('%d-' % pid):
                return os.path.join(DIR, n)
        sys.exit('no socket for pid %d in %s' % (pid, DIR))
    return p


def envelope(own, name, mode, body):
    # from-mode 必须带：接收端对 bypass 会话要求发送方声明相同的模式，否则判 hold
    return ('<cross-session-message from="uds:%s" from-name="%s" from-mode="%s">\n%s\n</cross-session-message>'
            % (own, name, mode, body))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pid = int(sys.argv[1])
    tgt = target_sock(pid)

    if '--send' not in sys.argv:
        print(tgt)
        return 0
    text = sys.argv[sys.argv.index('--send') + 1]
    mode = 'bypass'
    if '--mode' in sys.argv:
        mode = sys.argv[sys.argv.index('--mode') + 1]

    if os.path.exists(OWN):
        os.unlink(OWN)
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(OWN)
    os.chmod(OWN, 0o600)
    srv.listen(1)
    srv.settimeout(9)

    c = socket.socket(socket.AF_UNIX)
    c.settimeout(9)
    c.connect(tgt)
    frame = {
        'msg_id': str(uuid.uuid4()),
        'type': 'user',
        'message': {'role': 'user', 'content': envelope(OWN, 'agent-bridge', mode, text)},
        'priority': 'next',
        'from': 'uds:' + OWN,
    }
    c.sendall((json.dumps(frame, ensure_ascii=False) + '\n').encode())

    # 接收端会通过 from 地址回执 peer_message_status（held / delivered / refused），
    # 所以也要 accept 自己 socket 上的连接，否则看不到投递结果。
    deadline = time.time() + 8
    c.settimeout(1)
    print('sent msg_id', frame['msg_id'])
    while time.time() < deadline:
        try:
            data = c.recv(65536)
            if not data:
                break
            for line in data.decode('utf-8', 'replace').splitlines():
                if line.strip():
                    print('nack:', line[:400])
        except socket.timeout:
            pass
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        conn.settimeout(1)
        try:
            for line in conn.recv(65536).decode('utf-8', 'replace').splitlines():
                if line.strip():
                    print('receipt:', line[:400])
        finally:
            conn.close()
        break
    return 0


if __name__ == '__main__':
    sys.exit(main())
