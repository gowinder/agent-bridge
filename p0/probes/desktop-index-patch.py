#!/usr/bin/env python3
"""把 Claude Desktop 会话索引的尾指针指向指定 assistant 记录。

用途：验证「改写桌面私有索引能否让桌面接续外部 --resume 写入的分支」。
只改 lastAssistantUuid 与 completedTurns，写前自动备份 .bak-<时间戳>。

用法：
  desktop-index-patch.py --list                    列出所有 Desktop 会话索引
  desktop-index-patch.py <cliSessionId> <assistantUuid> [completedTurns]
"""
import json
import os
import sys
import time

ROOT = os.path.expanduser('~/Library/Application Support')


def index_files():
    out = []
    for base in ('Claude-3p', 'Claude'):
        d = os.path.join(ROOT, base, 'claude-code-sessions')
        for dirpath, _, names in os.walk(d):
            for n in names:
                if n.startswith('local_') and n.endswith('.json'):
                    out.append(os.path.join(dirpath, n))
    return out


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args[0] == '--list':
        for p in index_files():
            j = load(p)
            print('{}\t{}\t{}\tturns={}\tlast={}'.format(
                (j.get('cliSessionId') or '')[:8], j.get('cwd'), j.get('title'),
                j.get('completedTurns'), (j.get('lastAssistantUuid') or '')[:8]))
        return 0
    if len(args) < 2:
        print(__doc__)
        return 2
    sid, uuid = args[0], args[1]
    turns = int(args[2]) if len(args) > 2 else None

    hits = []
    for p in index_files():
        cur = load(p).get('cliSessionId') or ''
        if cur == sid or (len(sid) >= 8 and cur.startswith(sid)):
            hits.append(p)
    if len(hits) != 1:
        print('匹配到 {} 个索引，需恰好 1 个:'.format(len(hits)))
        for h in hits:
            print(' ', h)
        return 1
    path = hits[0]
    j = load(path)
    before = (j.get('lastAssistantUuid'), j.get('completedTurns'))
    bak = path + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
    with open(bak, 'w', encoding='utf-8') as f:
        json.dump(j, f, ensure_ascii=False, indent=1)
    j['lastAssistantUuid'] = uuid
    if turns is not None:
        j['completedTurns'] = turns
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(j, f, ensure_ascii=False, indent=1)
    print('patched ', path)
    print('backup  ', bak)
    print('lastAssistantUuid {} -> {}'.format((before[0] or '')[:8], uuid[:8]))
    print('completedTurns    {} -> {}'.format(before[1], j.get('completedTurns')))
    print('mtime   ', time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(path))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
