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
import { askSignoffStatus } from './ticket-arm-guard.mjs';

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
 * 把「這版完成」那一段的意圖鍵對齊到簽證的意圖（inkstone/arcrun-rag#365）。
 *
 * 為什麼：簽證（簽核）只有一張，掛在零件包那一版的意圖上；小幫手版本說明寫的常是它自己的執行票，
 * 或另一個意圖。1.4.249 prod 第 23 站因此停下，出貨的人只好手改 CHANGELOG 再 commit。
 * 判斷（假設，ADR D101）：一趟 prod 只有一個意圖簽證，**以簽證的意圖為準**——寫錯的那個鍵不丟掉，
 * 改記成「執行票」留在同一個括號裡（與 1.4.249 手改的形狀一致），出貨線不必再停下來要人手改。
 * 只動出貨當下的內文副本，不回寫 CHANGELOG；沒有「這版完成」段或根本沒帶票鍵時原樣回傳（交給 checkTwoPart 退回）。
 *
 * @returns {{ body:string|null, changed:boolean, from:string|null }}
 */
export function alignDoneIntent(body, intent) {
  if (!body || !intent) return { body: body ?? null, changed: false, from: null };
  const lines = String(body).split('\n');
  const alsoRe = new RegExp(`^${ALSO_LABEL}`);
  const doneRe = new RegExp(`^${DONE_LABEL}\\s*[：:]`);
  for (let i = 0; i < lines.length; i++) {
    if (!doneRe.test(plainLead(lines[i]))) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() && !alsoRe.test(plainLead(lines[end]))) end++;
    const para = lines.slice(i, end).join('\n');
    const m = para.match(REF_RE);
    if (!m) return { body, changed: false, from: null };
    const old = `${m[1]}#${m[2]}`;
    if (old === intent) return { body, changed: false, from: null };
    const next = para.slice(0, m.index) + `${intent}；執行票 ${old}` + para.slice(m.index + m[0].length);
    return { body: [...lines.slice(0, i), next, ...lines.slice(end)].join('\n'), changed: true, from: old };
  }
  return { body, changed: false, from: null };
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
export async function runVisaGate({ section, version, fetchImpl, token, baseUrl = 'http://ahub.invalid' }) {
  const two = checkTwoPart(section);
  const problems = [...two.problems];
  const detail = [];
  if (!two.intent) {
    // 沒有意圖鍵就不能帶 intent 問——AHub 不帶 intent 只看有沒有已確認的簽證、不重掃底下，
    // 那等於放掉最重要的一格（兒子全關沒）。所以這裡直接退回，不退而求其次。
    return { ok: false, intent: null, detail, problems };
  }
  const v = await checkVisa({ fetchImpl, token, version, intent: two.intent });
  if (v.ok) {
    detail.push(`AHub 簽證有效：${v.message}`);
  } else {
    const s = NOT_ANSWERED.has(v.reason) ? null : await signoffAsVisa({ fetchImpl, token, baseUrl, version, intent: two.intent });
    if (s && s.ok) detail.push(s.message);
    else problems.push(s && s.note ? `${v.message}\n${s.note}` : v.message);
  }
  return { ok: problems.length === 0, intent: two.intent, detail, problems };
}

// checkVisa 這幾種 reason＝AHub 根本沒回答（沒權杖／連不上／沒這組工作流／不認權杖／回怪東西）⇒ 不往下問，fail-closed。
const NOT_ANSWERED = new Set(['no-token', 'unreachable', 'workflow-missing', 'unauthorized', 'unexpected']);

/**
 * 簽核即簽證（AHub 0.46.0 的規則，inkstone/Arcrun#464）——由海關自己判，不靠 prod 上那台 AHub 的版本。
 *
 * 為什麼在這裡：海關問的是 prod 那台 AHub，而 0.46.0 的規則就裝在要出的那一版裡
 * ⇒ prod 還沒升級時，帶著「簽一次就能出貨」的那版自己永遠出不去（2026-11-18 1.4.249 實撞：
 *    意圖 inkstone/Arcrun#465 ARM 已簽，舊 AHub 回 no_children）。升級順序不該決定規則，
 *    所以規則放在閘這一側，資料仍取自 AHub。leo 2026-11-19 親口同意（「改海關」）。
 *
 * 判準（比 0.46.0 嚴，不是另開一條路）：
 *   · 只在 AHub **有回答**、而且說沒有簽證時才問（連不上、沒權杖等照舊退回）
 *   · 問的是**意圖票本身**的簽核看板、帶**這一個版號**：AHub 回 version.approved（只認租戶設定的簽核人）
 *     而且 version.version 就是這個版號才算——0.46.0 只看「這個版號有沒有被簽過」，這裡還要求簽在意圖票上
 *   · 沒簽、簽的是別的版號、看板讀不到 ⇒ 退回
 *   · prod 放行另由 ticket-arm-guard 驗 ARM，這裡不取代它
 */
export async function signoffAsVisa({ fetchImpl, token, baseUrl = 'http://ahub.invalid', version, intent }) {
  const m = String(intent || '').match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/);
  if (!m) return { ok: false, note: `意圖鍵 ${intent} 不是 owner/repo#N，查不了簽核看板` };
  let board;
  try {
    board = await askSignoffStatus({ owner: m[1], repo: m[2], issue: Number(m[3]), version: String(version), token, baseUrl, fetchImpl });
  } catch (e) {
    return { ok: false, note: `也查不到意圖 ${intent} 的簽核看板：${e && e.message ? e.message : e}` };
  }
  const v = board && board.version;
  if (v && v.approved === true && String(v.version) === String(version)) {
    return { ok: true, message: `簽核即簽證（AHub 0.46.0 規則，inkstone/Arcrun#464）：${v.by} 已在意圖 ${intent} 簽核 ${version}（${v.at}，留言 ${v.comment_id}）` };
  }
  return { ok: false, note: `意圖 ${intent} 上也沒有簽核人簽 ${version}（簽核即簽證不成立）` };
}
