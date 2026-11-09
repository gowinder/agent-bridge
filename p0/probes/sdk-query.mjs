import { query } from '@anthropic-ai/claude-agent-sdk';
const sid = process.argv[2];
const q = query({ prompt: 'sdk resume turn', options: { resume: sid, model: 'claude-sonnet-4-5', cwd: '/tmp/claude-501/p0/st', permissionMode: 'default' } });
const seen = [];
let result = null;
for await (const m of q) {
  seen.push(m.type);
  if (m.type === 'result') result = { subtype: m.subtype, session_id: m.session_id, is_error: m.is_error, turns: m.num_turns };
}
console.log(JSON.stringify({ types: seen.slice(0, 12), counts: seen.reduce((a,t)=>(a[t]=(a[t]??0)+1,a),{}), result }, null, 1));
