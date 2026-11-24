/**
 * 工具层错误：带结构化 code，方便调用方 agent 区分「未配对 / 不在登记册 / 会话忙 / bridge 拒绝」。
 * 所有 message 都是给人看的完整句子，不吞 bridge 的原始错误。
 */

import { statePaths } from "./state.mjs";

/** 配对指引里的路径取实际状态目录（模块加载时算一次）；提示里不出现任何私有部署路径。 */
const { identity: IDENTITY_PATH, confirm: CONFIRM_PATH } = statePaths();

export const PAIRING_HINT = [
  `本连接器还没有配对设备身份（${IDENTITY_PATH} 不存在）。`,
  "配对步骤（邀请不要贴进聊天）：",
  "  1. 在 Mac 菜单栏 Agent Bridge 里生成配对邀请链接；",
  "  2. 把整条链接写成本机文件，例如 ~/invite.txt；",
  "  3. 运行：node server/pair.mjs --invite-file <该文件>",
  `  4. 比对菜单栏与终端里的 6 位确认码，一致时把 yes 写进 ${CONFIRM_PATH}。`,
].join("\n");

export class ToolError extends Error {
  constructor(code, message, { hint, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ToolError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export class UnpairedError extends ToolError {
  constructor(details) {
    super("unpaired", "未配对：本机没有可用的 Agent Bridge 设备身份，无法连接 bridge。", {
      hint: PAIRING_HINT,
      details,
    });
  }
}

/** bridge 侧返回的错误码（protocol ERROR_CODES）原样透传，不静默改写。 */
export class BridgeToolError extends ToolError {
  constructor(code, message, { details, cause } = {}) {
    super(`bridge_${code}`, message, { details, cause });
  }
}
