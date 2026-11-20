/**
 * 当前页面是否跑在预览部署上（自有预览域，旧部署仍在 workers.dev）。
 * 落地页回链和预览图标都靠这一个判断，别在别处再抄一份 hostname 比较。
 */
export function isPreviewDeployment(): boolean {
  return (
    location.hostname === "agent-bridge-preview.craftstead.app" || location.hostname.endsWith(".workers.dev")
  );
}
