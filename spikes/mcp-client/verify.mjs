import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { call } from "./peer.mjs";
import { connectDevice } from "./pairing.mjs";
import { ensureStateDir, readJson, sleep, stateDir, statePaths } from "./state.mjs";

/**
 * verify：用持久化的设备身份走一遍「重连 + 只读探测 + 一次受控写入」。
 * 每一步都打印证据；任何一步失败立刻抛出，后面的步骤不再跑。
 */

const SEND_TEXT = "Reply with exactly: SPIKE-OK";
const EXPECTED_REPLY = "SPIKE-OK";
const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 120_000;
/** 没观测到 busy=true 时的宽限：给 pi 一点时间开始跑，再判定「已完成」。 */
const IDLE_GRACE_MS = 15_000;

function step(label) {
  console.log(`\n── ${label} ──`);
}

function clip(text, limit = 200) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function messageText(record) {
  return record.blocks
    .filter((block) => block.type === "text" || block.type === "ask" || block.type === "next-step")
    .map((block) => block.text)
    .join("\n");
}

export async function loadDeviceRecord() {
  const { device, identity } = statePaths();
  const stored = await readJson(device);
  const keys = await readJson(identity);
  if (!stored || !keys) {
    throw new Error(`没有配对状态：缺 ${stored ? "identity.json" : "device.json"}（${stateDir()}）。先跑 pair。`);
  }
  return { ...stored, privateKey: keys.privateKey, publicKey: keys.publicKey };
}

/** 复用 pair 写下的状态重连。 */
export async function openDevice(noise) {
  const device = await loadDeviceRecord();
  console.log(`状态目录：${stateDir()}`);
  console.log(`设备：${device.deviceId}  中继：${device.relayUrl}  房间：${device.roomId}`);
  const connection = await connectDevice(noise, device);
  return { ...connection, device };
}

export async function runVerify(noise, { name, dir }) {
  const { client, device } = await openDevice(noise);

  step("a. device.list");
  const devices = await call(client, "device.list", undefined, 30_000);
  for (const item of devices.devices) {
    const self = item.deviceId === device.deviceId ? " ← 本设备" : "";
    console.log(`  ${item.deviceId}  ${JSON.stringify(item.name)}  revokedAt=${item.revokedAt ?? "null"}${self}`);
  }
  if (!devices.devices.some((item) => item.deviceId === device.deviceId)) {
    throw new Error(`device.list 里没有本设备 ${device.deviceId}`);
  }
  console.log(`  ✓ 本设备在列（共 ${devices.devices.length} 台）`);

  step("b. device.rename");
  const renamed = await call(client, "device.rename", { deviceId: device.deviceId, name }, 30_000);
  console.log(`  ${JSON.stringify(renamed)}`);

  step("c. session.list（includeArchived:false）");
  const list = await call(client, "session.list", { includeArchived: false }, 60_000);
  console.log(`  completeness=${list.completeness} 共 ${list.sessions.length} 条`);
  for (const session of list.sessions.slice(0, 10)) {
    console.log(
      `  ${session.sessionId}  app=${session.appId}  hosted=${session.hosted === true}  busy=${session.busy === true}  ${clip(session.title, 60)}`,
    );
  }
  if (list.sessions.length > 10) console.log(`  …其余 ${list.sessions.length - 10} 条省略`);

  step("d. message.list（只读，选一个已有会话）");
  const existing =
    list.sessions.find((session) => session.hosted === true && !session.archived) ??
    list.sessions.find((session) => !session.archived) ??
    list.sessions[0];
  if (!existing) {
    console.log("  没有可用会话，跳过");
  } else {
    console.log(`  选中 ${existing.sessionId}（app=${existing.appId}，archived=${existing.archived}）`);
    const recent = await call(client, "message.list", { sessionId: existing.sessionId, limit: 5 }, 60_000);
    for (const record of recent.messages) {
      console.log(`  [${record.role}] ${clip(messageText(record))}`);
    }
    console.log(`  ✓ 读到最后 ${recent.messages.length} 条消息（未发送任何消息）`);
  }

  step("e. 托管目录 + hosted.create + message.send");
  await ensureStateDir();
  // 简报里要求「临时目录 + hosted.addDir」，但远程设备没有这个权限（Bridge 直接回
  // unsupported：白名单只能在 Mac 菜单栏里改）。这里仍然试一次留下证据，然后退回
  // 白名单里已有的目录。
  const tempDir = await mkdtemp(join(stateDir(), "spike-dir-"));
  try {
    const added = await call(client, "hosted.addDir", { path: tempDir }, 30_000).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
    if (added.ok) console.log(`  ⚠ hosted.addDir 竟然成功了：${JSON.stringify(added.result)}`);
    else console.log(`  hosted.addDir 被拒绝（预期：远程不支持）→ ${added.error.code}: ${added.error.message}`);

    const dirs = await call(client, "hosted.dirs", undefined, 30_000);
    const usable = dirs.dirs.filter((item) => item.exists !== false && item.allowed !== false);
    for (const item of dirs.dirs) {
      console.log(`  ${item.exists === false ? "[缺失]" : item.allowed === false ? "[已移出白名单]" : "[可建]"} ${item.path}`);
    }
    const path = dir ?? usable[0]?.path;
    if (!path) throw new Error("白名单里没有可用目录（hosted.dirs 全为空或都不存在），无法新建托管会话");
    if (!dirs.dirs.some((item) => item.path === path)) {
      console.log(`  ⚠ ${path} 不在 hosted.dirs 里，hosted.create 会以 unauthorized 失败`);
    }
    console.log(`  用目录：${path}`);

    const created = await call(client, "hosted.create", { path, agent: "pi" }, 60_000);
    const session = created?.session;
    if (!session) throw new Error(`hosted.create 没有返回 session：${JSON.stringify(created).slice(0, 400)}`);
    console.log(
      `  hosted.create → ${session.sessionId}  app=${session.appId}  hostedState=${session.hostedState}  busy=${session.busy === true}  ${JSON.stringify(session.title)}`,
    );

    const ack = await call(client, "message.send", { sessionId: session.sessionId, text: SEND_TEXT }, 60_000);
    console.log(`  message.send ack：${JSON.stringify(ack)}`);
    if (!ack.accepted) throw new Error(`message.send 没有被接受：${ack.detail ?? "无 detail"}`);

    step("f. 轮询 message.list 直到 busy=false");
    const startedAt = Date.now();
    const deadline = startedAt + POLL_DEADLINE_MS;
    let observedBusy = false;
    let nudged = false;
    let latest = null;
    let summary = session;
    for (;;) {
      latest = await call(client, "message.list", { sessionId: session.sessionId, limit: 10 }, 60_000);
      const got = await call(client, "session.get", { sessionId: session.sessionId }, 30_000).catch(() => null);
      summary = got?.session ?? summary;
      const busy = latest.busy === true || summary.busy === true;
      observedBusy ||= busy;
      const asking = summary.needsDecision === true;
      console.log(`  t+${Math.round((Date.now() - startedAt) / 1000)}s busy=${busy} needsDecision=${asking} 消息数=${latest.messages.length}`);
      if (asking && !nudged) {
        // pi 的提问要用普通过消息回答；approval.respond 这版 Bridge 还没实现。
        const lastAsk = latest.messages.at(-1);
        console.log(`  会话在等回答：${clip(lastAsk ? messageText(lastAsk) : "（无内容）", 400)}`);
        const nudge = await call(client, "message.send", { sessionId: session.sessionId, text: "继续" }, 60_000);
        console.log(`  已发送「继续」尝试解卡：${JSON.stringify(nudge)}`);
        nudged = true;
      }
      const elapsed = Date.now() - startedAt;
      if (!busy && (observedBusy || elapsed >= IDLE_GRACE_MS)) break;
      if (Date.now() >= deadline) {
        console.log(`  轮询超过 ${POLL_DEADLINE_MS / 1000}s，按当前状态收尾`);
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // 页面里的顺序不一定从旧到新，按 createdAt 排一次再取最后一条。
    const replies = latest.messages
      .filter((record) => record.role === "assistant")
      .sort((a, b) => a.createdAt - b.createdAt);
    const tail = replies.at(-1);
    const tailText = tail ? messageText(tail) : "";
    console.log(`  最后一条助手回复（尾部 400 字）：${clip(tailText, 400)}`);
    console.log(`  ✓ 轮询结束：busy=${latest.busy === true}，助手消息 ${replies.length} 条`);
    if (!tailText.includes(EXPECTED_REPLY)) {
      throw new Error(`助手回复里没有 ${EXPECTED_REPLY}，实际内容：${clip(tailText, 400)}`);
    }
    console.log(`  ✓ 回复包含 ${EXPECTED_REPLY}`);

    step("g. hosted.stop / hosted.archive / hosted.removeDir");
    const stopped = await call(client, "hosted.stop", { sessionId: session.sessionId }, 60_000);
    console.log(`  hosted.stop → ${JSON.stringify(stopped)}`);
    const archived = await call(client, "hosted.archive", { sessionId: session.sessionId }, 60_000);
    console.log(`  hosted.archive → ${JSON.stringify(archived).slice(0, 300)}`);
    const removed = await call(client, "hosted.removeDir", { path }, 30_000).then(
      (result) => ({ ok: true, result }),
      (error) => ({ ok: false, error }),
    );
    if (removed.ok) console.log(`  ⚠ hosted.removeDir 竟然成功了：${JSON.stringify(removed.result)}`);
    else console.log(`  hosted.removeDir 被拒绝（预期：远程不支持）→ ${removed.error.code}: ${removed.error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  client.stop();
  console.log("\nVERIFY PASS");
}

export async function runReconnect(noise) {
  const { client } = await openDevice(noise);
  step("session.list");
  const list = await call(client, "session.list", { includeArchived: false }, 60_000);
  console.log(`  completeness=${list.completeness} 共 ${list.sessions.length} 条`);
  for (const session of list.sessions.slice(0, 5)) {
    console.log(`  ${session.sessionId}  app=${session.appId}  ${clip(session.title, 60)}`);
  }
  client.stop();
  console.log("\nRECONNECT PASS");
}
