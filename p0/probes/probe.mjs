import { listSessions, getSessionMessages, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';

const DESKTOP_CLI_IDS = {
  '07701bd0': '方案可行性评估',
  'cfa49414': 'Investigate phishing report',
  '11d6dead': 'Claude 桌面版 Agent-Teams 开启',
  '12c4bcf3': 'RTS Demo 可用性修复',
  'beb3e9f0': '项目优化方案讨论',
  '0825e19c': '分层顾问编排配置',
  'b5565e2f': '皮质风暴玩法设计与Web原型',
  'f0fce285': '(untitled)',
};

const sessions = await listSessions();
console.log('listSessions() total =', sessions.length);
console.log('sample fields =', JSON.stringify(Object.keys(sessions[0] ?? {})));

// match by prefix of cliSessionId
let matched = 0;
const found = [];
for (const s of sessions) {
  for (const [prefix, title] of Object.entries(DESKTOP_CLI_IDS)) {
    if (s.sessionId && s.sessionId.startsWith(prefix)) {
      matched++;
      found.push({ prefix, title, sid: s.sessionId, cwd: s.cwd, lastModified: s.lastModified, title: s.title ?? s.summary });
    }
  }
}
console.log('desktop sessions matched =', matched, '/', Object.keys(DESKTOP_CLI_IDS).length);
console.log(JSON.stringify(found, null, 2));

// read messages for one matched session
const target = found[0];
if (target) {
  const info = await getSessionInfo(target.sid);
  console.log('getSessionInfo ok =', !!info, 'customTitle=', info?.customTitle ?? info?.title);
  const msgs = await getSessionMessages(target.sid, { limit: 50 });
  console.log('getSessionMessages count =', msgs.length);
  const roles = {};
  let totalChars = 0, textBlocks = 0, toolBlocks = 0;
  for (const m of msgs) {
    roles[m.type] = (roles[m.type] ?? 0) + 1;
    const c = m.message?.content;
    if (typeof c === 'string') { totalChars += c.length; textBlocks++; }
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'text') { textBlocks++; totalChars += (b.text ?? '').length; }
      else toolBlocks++;
    }
  }
  console.log('roles =', JSON.stringify(roles), 'textBlocks =', textBlocks, 'toolBlocks =', toolBlocks, 'chars =', totalChars);
  console.log('first msg keys =', JSON.stringify(Object.keys(msgs[0] ?? {})));
  console.log('first msg meta =', JSON.stringify({ type: msgs[0]?.type, uuid: msgs[0]?.uuid?.slice(0,8), hasParent: !!msgs[0]?.parentUuid, sessionId: msgs[0]?.sessionId?.slice(0,8) }));
}
