/**
 * inkstone/arcrun-rag#334（母票 inkstone/Arcrun#399）：維運腳本打 cypher 時帶合法憑證。
 *
 * 相容期（cypher 的 CYPHER_AUTH_COMPAT_UNTIL）之後，只有租戶名一律 401，要再帶
 *   Authorization: Bearer hex(HMAC-SHA256(key=KBDB_INTERNAL_TOKEN, msg="kbdb-proxy-v1\n"+租戶名))
 * （格式只有這一套：Arcrun#399 c1794480503109218；與 installer/oauth-prototype/worker.js 的
 * deriveKbdbProxyKey、小幫手 collector/cypherauth.go 同一公式）。
 *
 * KBDB_INTERNAL_TOKEN ＝目標實例本來就有的 Cloudflare Secret（維運者從憑證地圖取，不是新金鑰）；
 * 環境變數沒設 ⇒ 只帶租戶名（相容期內照通；相容期後會 401，錯誤訊息要看得出是這個原因）。
 */
import { createHmac } from 'node:crypto';

export function deriveKbdbProxyKey(kbdbToken, tenant) {
  return createHmac('sha256', String(kbdbToken)).update('kbdb-proxy-v1\n' + String(tenant)).digest('hex');
}

/** 回 { 'X-Arcrun-API-Key': ns, Authorization?: 'Bearer …' }。token 預設讀 KBDB_INTERNAL_TOKEN。 */
export function cypherAuthHeaders(ns, token = process.env.KBDB_INTERNAL_TOKEN) {
  const h = { 'X-Arcrun-API-Key': ns };
  if (token) h.Authorization = 'Bearer ' + deriveKbdbProxyKey(token, ns);
  return h;
}
