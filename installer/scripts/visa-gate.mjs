/**
 * visa-gate.mjs — 出 prod 前的「海關」：這個版本有沒有一張有效的意圖完成簽證，
 *                 以及版本說明是不是固定兩段（這版完成／順帶修好）。
 *
 * 依據：ADR D101 第三步「班車與簽證」（InkStoneCo system-dev/docs/2-architecture/decisions/
 * D101-ahub-intent-execution-ownership.md）的出貨線這一半；AHub 端是 inkstone/Arcrun#438
 * （AHub 0.39.0 的 `GET /ahub/visas/check`），本 repo 的施工是 inkstone/arcrun-rag#348。
 *
 * 為什麼有這支（leo：「我才不會簽到沒完成的版本」）：
 *   prod 的放行仍以 AHub 簽核為準（ticket-arm-guard.mjs）。簽核人看到的是「一個版本」，
 *   看不到「這版想完成的那件事，底下的票是不是真的關完了」。簽證補這一格：
 *   意圖底下的執行票全關、有人確認過，海關才放行。**簽證是附加條件，不是第二套簽核**——
 *   簽證有效不代表放行，放行還是要 ARM；反過來，ARM 簽了而簽證沒有，一樣退回。
 *
 * 兩件事，同一個意圖串起來：
 *   ① 版本說明（CHANGELOG.md／collector/CHANGELOG.md）每版固定兩段：
 *        **這版完成：<一句話意圖>（owner/repo#N）**      ← 第一段，帶意圖票的鍵
 *        順帶修好（底下條列）                          ← 第二段
 *      意圖鍵從第一段讀出來，**就是**拿去問 AHub 的那個 intent——所以「CHANGELOG 寫的意圖」與
 *      「簽證的意圖」不可能各說各話：AHub 以 (intent, version) 找簽證，對不上就是 no_visa，
 *      而本支會把簽證實際掛的意圖（`visas[]`）印出來，讓人一眼看出是哪邊寫錯。
 *   ② 向 AHub 查簽證。永遠 200，看 `ok`；不 ok 就退回，並列出缺哪個意圖、哪幾張票。
 *
 * 守的邊界：
 *   · **只有 prod 問**（`ship.targets.json` 的 `visaGate: true`）。stage 是班車，隨時發，不查。
 *   · **fail-closed**：AHub 連不上／沒權杖／還沒升到 0.39.0（workflow_missing）都退回，
 *     不當成「查不到就放行」。海關查不出來，不能算通過。
 *   · 唯讀：只打 GET，不寫任何東西；憑證只碰名字（D36），權杖由 ship-env 取進 env。
 *
 * 純函式＋注入 fetch，可在假 fetch 上演練（見 visa-gate.test.mjs）。
 */

export const DONE_LABEL = '這版完成';
export const ALSO_LABEL = '順帶修好';
export const VISA_CHECK_PATH = '/api/v1/ahub/visas/check';

const REF_RE = /(?<![\w/.-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/;

/** 去掉行首的項目符號、標題井字、粗體記號，留下能比對標籤的字。 */
function plainLead(line) {
  return String(line).trim().replace(/^(?:[-*+]\s+|#{1,6}\s+)+/, '').replace(/^\*{1,2}|^_{1,2}/, '').trim();
}

/**
 * 把一版的說明內文（`## <版號>` 底下那一段，releaseSectionFor 的回傳）拆成兩段。
 * @returns {{ done: {text:string, intent:string|null}|null, also: string|null }}
 *   done＝「這版完成：…」那一段（到空行或「順帶修好」為止）；intent＝段落裡第一個 `owner/repo#N`。
 *   also＝「順帶修好」標題之後的內文（可能是空字串＝標題在但沒條目）；沒有標題回 null。
 */
export function parseVersionSection(body) {
  const lines = String(body || '').split('\n');
  const alsoRe = new RegExp(`^${ALSO_LABEL}`);
  const doneRe = new RegExp(`^${DONE_LABEL}\\s*[：:]`);
  let done = null;
  let also = null;
  for (let i = 0; i < lines.length; i++) {
    const lead = plainLead(lines[i]);
    if (!done && doneRe.test(lead)) {
      const para = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim() || alsoRe.test(plainLead(lines[j]))) break;
        para.push(lines[j]);
      }
      const m = para.join('\n').match(REF_RE);
      done = { text: plainLead(para[0]).replace(/\*+$/, '').trim(), intent: m ? `${m[1]}#${m[2]}` : null };
      i += para.length - 1;
      continue;
    }
    if (also === null && alsoRe.test(lead)) {
      also = lines.slice(i + 1).join('\n').trim();
      break;
    }
  }
  return { done, also };
}

/**
 * 版本說明是不是固定兩段，且第一段帶得出意圖鍵。
 * @param {string|null} body releaseSectionFor() 的回傳
 * @param {{expectIntent?: string|null}} [opts] 給了就要求第一段的意圖＝它（daemon 那條線對齊簽證意圖用）
 * @returns {{ ok:boolean, intent:string|null, problems:string[] }}
 */
export function checkTwoPart(body, { expectIntent = null } = {}) {
  const problems = [];
  if (!body) return { ok: false, intent: null, problems: ['找不到這一版的說明段落'] };
  const { done, also } = parseVersionSection(body);
  if (!done) problems.push(`缺第一段「${DONE_LABEL}：<這版想完成的那件事>」`);
  else if (!done.intent) problems.push(`「${DONE_LABEL}」那一段沒有意圖票的鍵（要寫成 owner/repo#號碼，例：inkstone/Arcrun#438），海關不知道該查哪個意圖`);
  else if (expectIntent && done.intent !== expectIntent) {
    problems.push(`「${DONE_LABEL}」寫的意圖是 ${done.intent}，與這一版簽證的意圖 ${expectIntent} 不一致`);
  }
  if (also === null) problems.push(`缺第二段「${ALSO_LABEL}」（沒有順帶修好的東西就寫標題加一句「無」，不要整段省略）`);
  return { ok: problems.length === 0, intent: done ? done.intent : null, problems };
}

/**
 * 向 AHub 查簽證（海關）。不丟例外：任何查不出來都回 { ok:false, reason, message }，
 * 由呼叫端決定怎麼退回（prod 一律退回＝fail-closed）。
 * @returns {Promise<{ ok:boolean, reason:string, message:string, body:object|null }>}
 *   reason：'ok'｜'no-token'｜'unreachable'｜'workflow-missing'｜'unauthorized'｜'unexpected'｜AHub 的 missing.reason
 */
export async function checkVisa({ fetchImpl, token, version, intent }) {
  if (!token) return { ok: false, reason: 'no-token', body: null, message: '沒有 AHub 權杖（AHUB_TOKEN｜TICKET_FORGE_TOKEN；出貨線 prepareShipEnv 會自取 ISEP 橋登記的那把，這台沒取到），查不了簽證' };
  const q = new URLSearchParams({ version: String(version) });
  if (intent) q.set('intent', intent);
  let res;
  try {
    res = await fetchImpl(`http://ahub.invalid${VISA_CHECK_PATH}?${q}`, { method: 'GET', headers: { authorization: `token ${token}`, accept: 'application/json' } });
  } catch (e) {
    return { ok: false, reason: 'unreachable', body: null, message: `連不上 AHub：${e && e.message ? e.message : e}` };
  }
  const text = await res.text().catch(() => '');
  if (res.status === 404 && /workflow_missing/.test(text)) {
    return { ok: false, reason: 'workflow-missing', body: null, message: `這台 AHub 還沒有意圖完成簽證那組工作流（AHub 0.39.0，inkstone/Arcrun#438，要先出 stage／升級）：${text.slice(0, 160)}` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', body: null, message: `AHub 不認這把權杖（HTTP ${res.status}）` };
  if (res.status !== 200) return { ok: false, reason: 'unexpected', body: null, message: `GET /ahub/visas/check 回 HTTP ${res.status}：${text.slice(0, 200)}` };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, reason: 'unexpected', body: null, message: `AHub 回的不是 JSON：${text.slice(0, 120)}` }; }
  if (body && body.ok === true) return { ok: true, reason: 'ok', body, message: String(body.message || `版本 ${version} 持有效簽證`) };
  return { ok: false, reason: (body && body.missing && body.missing.reason) || 'no_visa', body, message: refuseMessage(body, { version, intent }) };
}

/** AHub 說沒有有效簽證時，給人看的退回說明：缺哪個意圖、哪幾張票、簽證實際掛在哪個意圖。 */
export function refuseMessage(body, { version, intent }) {
  const lines = [String((body && body.message) || `版本 ${version} 沒有有效的意圖完成簽證${intent ? `（意圖 ${intent}）` : ''}。`)];
  const miss = (body && body.missing) || {};
  const open = Array.isArray(miss.open) ? miss.open : [];
  if (open.length) {
    lines.push(`還沒搞定的票（${open.length} 張）：`);
    for (const t of open.slice(0, 20)) lines.push(`  · ${t.key || JSON.stringify(t)}${t.executor ? `（${t.executor}）` : '（未指派）'}${t.title ? ` ${t.title}` : ''}`);
    if (open.length > 20) lines.push(`  …另有 ${open.length - 20} 張`);
  }
  if (Array.isArray(miss.unknown) && miss.unknown.length) lines.push(`讀不出狀態的票：${miss.unknown.map((t) => t.key || t).slice(0, 12).join('、')}`);
  // 簽證實際掛在別的意圖上 ⇒ CHANGELOG「這版完成」寫錯意圖（或簽證開錯）
  const others = (Array.isArray(body && body.visas) ? body.visas : []).filter((v) => v && v.intent && intent && v.intent !== intent);
  if (others.length) lines.push(`這個版本現有的簽證掛在別的意圖：${others.map((v) => `${v.intent}（${v.state || '?'}）`).join('、')}——與 CHANGELOG「${DONE_LABEL}」寫的 ${intent} 不一致，改 CHANGELOG 或重開簽證`);
  return lines.join('\n');
}

/**
 * 海關整站：先驗版本說明（兩段、帶意圖鍵），再拿那個意圖鍵去問 AHub。
 * @param {{ section:string|null, version:string, fetchImpl:Function, token:string|null }} p
 * @returns {Promise<{ ok:boolean, intent:string|null, detail:string[], problems:string[] }>}
 */
export async function runVisaGate({ section, version, fetchImpl, token }) {
  const two = checkTwoPart(section);
  const problems = [...two.problems];
  const detail = [];
  if (!two.intent) {
    // 沒有意圖鍵就不能帶 intent 問——AHub 不帶 intent 只看有沒有已確認的簽證、不重掃底下，
    // 那等於放掉最重要的一格（兒子全關沒）。所以這裡直接退回，不退而求其次。
    return { ok: false, intent: null, detail, problems };
  }
  const v = await checkVisa({ fetchImpl, token, version, intent: two.intent });
  if (!v.ok) problems.push(v.message);
  else detail.push(`AHub 簽證有效：${v.message}`);
  return { ok: problems.length === 0, intent: two.intent, detail, problems };
}
