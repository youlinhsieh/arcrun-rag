/**
 * purge-jsdelivr.mjs — 推完 bundle 後 purge jsDelivr `@main` 快取，並驗到收斂。
 *
 * 從 ship.mjs 拆出來的原因：ship.mjs 改寫成管線後，purge 只是「prod 目標的一個步驟」，
 * 不該和入口邏輯綁在同一個檔（stage 走 Gitea raw，根本不需要 purge）。
 *
 * 🔴 2026-08-02（leo 實撞後裁「**應該自動**」）：
 *   daemon 自更新打 `cdn.jsdelivr.net/gh/…@main/manifest.json`，靠 `?t=<時間戳>` 想繞快取
 *   （函式甚至就叫 manifestURLNoCache）——**但 `?t=` 只防瀏覽器快取，防不了 CDN 邊緣快取**。
 *   實測：GitHub 已是最新，`@main` 仍吐三代前的 manifest ⇒ 用戶按「檢查更新」像沒反應。
 *   而且**每次出 daemon 新版都會發生**，不是偶發。
 *   實測要 purge 後等約 40 秒才收斂，且**一次可能不夠**，故驗到收斂為止。
 */
const GH = 'youlinhsieh/arcrun-rag-bundles';
const PURGE_PATHS = [
  'manifest.json',
  'daemon/ArcrunRAG-mac-unsigned.zip',
  'daemon/ArcrunRAG-win-unsigned.zip',
];

export async function purgeJsdelivrMain({ expectRelease, expectDaemon, tries = 4, log = console.log } = {}) {
  for (let n = 1; n <= tries; n++) {
    await Promise.all(PURGE_PATHS.map((p) =>
      fetch(`https://purge.jsdelivr.net/gh/${GH}@main/${p}`).catch(() => null)));
    await new Promise((r) => setTimeout(r, 20000));
    const m = await fetch(`https://cdn.jsdelivr.net/gh/${GH}@main/manifest.json?cb=${n}${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const relOk = !expectRelease || (m && m.release === expectRelease);
    const dmOk = !expectDaemon || (m && m.daemon && m.daemon.version === expectDaemon);
    log(`   purge 第 ${n} 次 → release=${m && m.release}／daemon=${m && m.daemon && m.daemon.version}`);
    if (relOk && dmOk) { log('   ✅ CDN 已收斂到最新'); return true; }
  }
  throw new Error('purge 後 jsDelivr 仍未收斂——**用戶此刻拿不到新版**，不准宣稱出貨完成');
}
