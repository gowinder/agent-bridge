/** 预览中继已从 workers.dev 迁到自有域名，旧地址的 workers_dev 路由已关闭。 */
const PREVIEW_RELAY_MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ["https://agent-bridge-preview.gowinder.workers.dev", "https://agent-bridge-preview.craftstead.app"],
];

export interface MetaStore {
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** 把已下线的旧中继地址换成现行地址；其它地址原样返回。 */
export function canonicalRelayUrl(url: string | null): string | null {
  if (!url) return url;
  const trimmed = url.replace(/\/+$/, "");
  const hit = PREVIEW_RELAY_MIGRATIONS.find(([from]) => from === trimmed);
  return hit ? hit[1] : url;
}

/** 启动时改写本机保存的旧中继地址（含网页相邻址），返回是否有改动。 */
export function migrateRelayUrls(store: MetaStore): boolean {
  let changed = false;
  for (const key of ["relay_url", "web_url"]) {
    const current = store.meta(key);
    const next = canonicalRelayUrl(current);
    if (current !== null && next !== current) {
      store.setMeta(key, next as string);
      changed = true;
    }
  }
  return changed;
}
