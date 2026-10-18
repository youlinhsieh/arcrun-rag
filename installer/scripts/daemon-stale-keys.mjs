/**
 * daemon-stale-keys.mjs — 把 manifest.daemon 裡「檔名不是這一版」的平台鍵拿掉
 *
 * 背景（InkStoneCo#235 c21808，2026-10-18 prod 出貨 1.4.111 撞牆）：
 * `daemon-sync` 用 `{...m.daemon}` 拷貝舊 daemon，再逐平台覆寫；選配的 msix 這次沒打，
 * 檔案不在就 `continue`，舊的 `msix: daemon/Arcrun-0.18.99.msix` 原樣留著，
 * 下一站 daemon-check 的 filename-carries-version 就擋下（舊版檔冒充新版）。
 * stage 沒撞到，是因為 stage bundle 的 manifest 從來沒有 msix 鍵（沒有東西可以殘留）；
 * prod bundle 是 0.18.99 打過 msix 才有這個鍵。
 *
 * 規則：想要的版本是 want；平台物件（有 file 字串）的檔名若不含 want ⇒ 是上一版殘留 ⇒ 移除。
 * 只動「平台鍵」，version／notes／built 這些非物件欄位不碰。純函式，不碰磁碟。
 */
export function dropStaleDaemonKeys(daemon, want) {
  const out = { ...(daemon || {}) };
  const dropped = [];
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (!v || typeof v !== 'object' || typeof v.file !== 'string') continue;
    if (!v.file.includes(want)) {
      dropped.push(`${key}（${v.file}）`);
      delete out[key];
    }
  }
  return { daemon: out, dropped };
}
