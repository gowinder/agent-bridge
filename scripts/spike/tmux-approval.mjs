#!/usr/bin/env node
// Spike prototype: deliver a reply into an interactive Claude Code CLI session
// that runs inside tmux, as if the user typed it in that pane.
//
//   node scripts/spike/tmux-approval.mjs <claude-pid> <text>
//
// It resolves pid -> tty -> tmux pane and refuses when the mapping is not exact.
// This is NOT wired into the Bridge adapter; see the spike section in
// REMOTE_APPROVAL.zh-CN.md for the security and lifecycle caveats.

import { execFileSync } from "node:child_process";

const [pidArg, ...textParts] = process.argv.slice(2);
const pid = Number(pidArg);
const text = textParts.join(" ");

function fail(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

if (!Number.isInteger(pid) || pid <= 0) fail("usage: tmux-approval.mjs <claude-pid> <text>");
if (!text.trim()) fail("empty text");

let tty = "";
try {
  tty = execFileSync("/bin/ps", ["-p", String(pid), "-o", "tty="], { encoding: "utf8" }).trim();
} catch {
  fail(`pid ${pid} is not running`);
}
if (!tty || tty === "??" || tty === "?") fail(`pid ${pid} has no controlling terminal`);

let command = "";
try {
  command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
} catch {
  fail(`pid ${pid} is not running`);
}
// Only deliver into an interactive Claude Code CLI, never into another program
// that happens to own the pane.
if (!/(^|\/)claude( |$)/.test(command) || command.includes("--input-format")) {
  fail(`pid ${pid} is not an interactive claude CLI: ${command.slice(0, 120)}`);
}

const ttyPath = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
let panes = [];
try {
  panes = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneTty, panePid, target] = line.split("\t");
      return { paneTty, panePid: Number(panePid), target };
    });
} catch {
  fail("tmux is not running (or its server cannot be reached)");
}

const matches = panes.filter((pane) => pane.paneTty === ttyPath);
if (matches.length !== 1) fail(`expected exactly one pane for ${ttyPath}, found ${matches.length}`);
const pane = matches[0];

// The pane shell must be the session's ancestor (direct parent in the common
// case, but allow one intermediate wrapper such as `sh -c`).
let parent = 0;
try {
  parent = Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim());
} catch {
  fail(`pid ${pid} is not running`);
}
if (parent !== pane.panePid) {
  fail(`pid ${pid} is not a child of pane ${pane.target} (pane pid ${pane.panePid})`);
}

execFileSync("tmux", ["send-keys", "-t", pane.target, "-l", text]);
execFileSync("tmux", ["send-keys", "-t", pane.target, "Enter"]);
console.log(JSON.stringify({ pid, tty: ttyPath, pane: pane.target, sent: text }));
