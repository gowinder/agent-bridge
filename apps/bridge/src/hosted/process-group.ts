/**
 * 托管子进程的进程组。
 *
 * pi 的 workflow（pi-subagents 的 external-cli / host-command）会再 spawn 一层子进程，
 * 只对直接子进程发 SIGTERM 收不掉它们，停止或换模型后那些孙进程会留在后台。
 * 用 detached 让托管进程自成一个进程组，杀的时候按负 pid 整组收。
 */

export interface GroupKillable {
  pid?: number;
  /** 由 spawnInOwnGroup 标记：这个进程自成一个进程组。 */
  ownsProcessGroup?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 给 detached 起的子进程打标记，kill 时才知道要杀整组。 */
export function markProcessGroup<T extends object>(child: T): T {
  return Object.assign(child, { ownsProcessGroup: true });
}

/** 杀子进程：自成一组就杀整组，否则退回只杀它自己。 */
export function killProcess(child: GroupKillable, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (child.ownsProcessGroup && pid) {
    try {
      // 负 pid 表示整个进程组。
      process.kill(-pid, signal);
      return;
    } catch {
      // 组已经空了（子进程先退出），退回只杀直接子进程。
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 已经退出。
  }
}
