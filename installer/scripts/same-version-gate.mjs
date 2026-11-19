/**
 * same-version-gate.mjs — 「同一個版號不能換成另一包」，在出貨動手前就查（inkstone/arcrun-rag#363 第 3 處）
 *
 * 病：出貨紀錄（release-ledger.json）只在全程成功的**最後落帳**才核對同版號——那時 stage 已經換版、
 * AHub 的 stage 現況（stage-record 站）也已經寫了。撞到時整趟白出，還留下一個「同號兩包」的現況。
 * 總監 11-18：「arcrun-rag 出貨線在 stage-record 那一站之前沒有先查同版號」。
 *
 * 兩處來源，**任一處**說這個版號是另一包就擋（在 version 站，早於任何部署／推送／寫 AHub）：
 *   ① 進版控的出貨紀錄：同版號、內容指紋不同 ⇒ 擋。
 *   ② AHub 的 stage 現況（唯讀 GET /ahub/stage）：同版號、commit 不同，而出貨紀錄對這個版號**沒有任何記載**
 *      （＝那一包不是這份 checkout 出的，無從比內容）⇒ 擋，叫人先把 main 取到最新再出。
 *      出貨紀錄有記載、指紋一致時，commit 不同是允許的（版號本來就由內容指紋決定，內容沒變號碼就不變）。
 *   AHub 讀不到／格式看不懂 ⇒ 不擋、明說「沒查到」（①仍然有效）；不假裝驗過。
 */

/** 從 GET /ahub/stage 的回應裡找「現在的 stage」：吃 {stage:{…}}／{current:{…}}／陣列／{items|stages|records:[…]}，取第一個同時有 version 與 commit 的物件。 */
export function stageFromResponse(json) {
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    if (!Array.isArray(v) && typeof v.version === 'string' && typeof v.commit === 'string') return { version: v.version, commit: v.commit };
    for (const k of Array.isArray(v) ? v.keys() : Object.keys(v)) {
      const r = walk(v[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(json, 0);
}

/** 唯讀問 AHub：stage 現在是哪個版號、哪顆 commit。 @returns {{known:boolean, version?:string, commit?:string, reason?:string}} */
export async function readAhubStage({ fetchImpl, token }) {
  if (!token) return { known: false, reason: '沒有 AHub 權杖' };
  try {
    const res = await fetchImpl('http://ahub.invalid/api/v1/ahub/stage?limit=1', { method: 'GET', headers: { authorization: `token ${token}` } });
    const text = await res.text().catch(() => '');
    if (res.status !== 200) return { known: false, reason: `GET /ahub/stage 回 HTTP ${res.status}` };
    const st = stageFromResponse(JSON.parse(text));
    return st ? { known: true, ...st } : { known: false, reason: 'GET /ahub/stage 的回應裡找不到 version／commit' };
  } catch (e) {
    return { known: false, reason: `讀 AHub stage 失敗：${e && e.message ? e.message : e}` };
  }
}

const norm = (v) => String(v || '').replace(/^[vV]/, '');

/**
 * @param {{ledger:{releases:object}, release:string, fingerprint:string, commit:string, ahubStage?:{known:boolean,version?:string,commit?:string,reason?:string}}} o
 * @returns {{ok:boolean, message:string}}
 */
export function checkSameVersion({ ledger, release, fingerprint, commit, ahubStage }) {
  const prev = ledger && ledger.releases && ledger.releases[release];
  if (prev && prev.fingerprint && fingerprint && prev.fingerprint !== fingerprint) {
    return { ok: false, message:
      `版號 ${release} 已經出過另一包：出貨紀錄記的內容指紋是 ${prev.fingerprint.slice(0, 12)}…（Arcrun@${String(prev.commit || '？').slice(0, 12)}），` +
      `這次是 ${fingerprint.slice(0, 12)}…（Arcrun@${String(commit || '？').slice(0, 12)}）。\n` +
      `     同一個版號不能換成另一包——使用者與簽核人看到的是版號。在任何部署、推送、寫 AHub 之前擋下。\n` +
      `     → 通常是這份 checkout 的 installer/release-state.json 落後（別條線已經出過新版）：先取得 main 最新再出；` +
      `不要手改出貨紀錄或版號。` };
  }
  const a = ahubStage;
  if (a && a.known && norm(a.version) === norm(release) && a.commit && commit && a.commit !== commit && !prev) {
    return { ok: false, message:
      `AHub 的 stage 現況已經是 ${release}（Arcrun@${a.commit.slice(0, 12)}），這次要出的同版號來自另一顆 commit（Arcrun@${String(commit).slice(0, 12)}），` +
      `而這份 checkout 的出貨紀錄對 ${release} 沒有任何記載，比不出兩包內容是不是同一份。\n` +
      `     同一個版號不能換成另一包 ⇒ 擋下。→ 先把含 ${release} 出貨紀錄的 main 取到最新（git pull），再重跑；內容真的沒變版號會原樣算出，且出貨紀錄對得上就放行。` };
  }
  const how = a && a.known ? `AHub stage 現況 ${a.version}` : `AHub stage 現況沒查到（${(a && a.reason) || '未查'}）`;
  return { ok: true, message: `同版號查核通過：${release} ${prev ? '出貨紀錄已有、內容指紋一致' : '出貨紀錄沒有這一版（新版號）'}；${how}` };
}
