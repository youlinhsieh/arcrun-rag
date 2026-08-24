#!/usr/bin/env bash
# check-remove-cleanup.sh — 驗**使用者真的會走的那條路**：
# 從各庫頁按「移除」→ 對話框 → 勾「順便清掉」→ 看到清單 → 按確定（arcrun-rag#138）。
#
# 🔴 為什麼要這一支：Go 那邊的迴歸網只證明「函式做對事」，證明不了
#    「按鈕存在、清單真的攤出來、第四個參數真的傳下去」。#138 的驗收條件裡
#    「使用者要能在動手前看到將要刪掉哪些東西」**只有前端驗得到**。
#    （同 check-render.sh 的理由：改完 UI 不准拿沒看過的畫面交件。）
#
# 做法沿用 check-render.sh：把 dist 複製到暫存、插一支 mock.js 假扮 window.go，
# 再用 headless Chrome 真的載入、真的點下去，最後 --dump-dom 讀結果。
set -uo pipefail
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "❌ 找不到 Chrome，跳過"; exit 0; }
[ -d frontend/dist ] || { echo "❌ 沒有 frontend/dist——先 (cd frontend && npm run build)"; exit 1; }

W=$(mktemp -d)
SRV_PID=""
cleanup() { rm -rf "$W"; [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT
lsof -ti tcp:8798 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3
cp -R frontend/dist/* "$W/"

cat > "$W/mock.js" <<'JS'
// 假的 window.go：一個知識庫、一個看守中的資料夾，PlanFolderCleanup 回一份
// 形狀與 collector.CleanupPlan 完全一致的清單（含「留著不動」那一半）。
window.__calls = [];
window.go = { main: { App: {
  GetState: async () => ({
    version: 'v0', statusBig: '看守中', statusSub: '', syncing: false,
    engine: 'workers-ai', geminiKey: '', extractedOK: 0,
    accounts: [{ name: '測試庫', host: 'arcrun-cypher-executor.example.workers.dev',
      folders: [{ path: '/kb/pms', accIdx: 0, retiring: false }] }],
  }),
  PlanFolderCleanup: async (acc, path) => {
    window.__calls.push(['PlanFolderCleanup', acc, path]);
    return {
      root: path, files: 52, bytes: 1234,
      remove: [
        { rel: '.arcrun-rag', is_dir: true, kind: 'workspace', evidence: '依據甲', files: 1, bytes: 10 },
        { rel: '.wiki', is_dir: true, kind: 'wiki-dir', evidence: '依據乙', files: 8, bytes: 100 },
        { rel: 'docs/.wiki', is_dir: true, kind: 'wiki-dir', evidence: '依據乙', files: 43, bytes: 900 },
      ],
      keep: [{ rel: 'pms_v1_legacy', reason: '這個資料夾也還在同步清單裡' }],
    };
  },
  RemoveFolder: async (acc, path, takedown, cleanupLocal) => {
    window.__calls.push(['RemoveFolder', acc, path, takedown, cleanupLocal]);
  },
  SyncNow: async () => {}, PickFolder: async () => '', AddFolder: async () => {},
  SetAI: async () => {}, OpenURL: () => {}, Connect: async () => {},
  CheckUpdate: async () => ({}), OpenLogFolder: () => {}, LogFolderPath: () => '',
  ListApps: async () => ({ apps: [] }),
} } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (k, v) => {
  const d = document.createElement('div');
  d.setAttribute('data-check', k); d.textContent = String(v);
  document.body.appendChild(d);
};

addEventListener('DOMContentLoaded', async () => {
  await sleep(600);                       // 等 main.js 拿到 state、畫完側欄
  // 走到各庫頁（使用者點側邊欄那個庫）
  const nav = [...document.querySelectorAll('.nav')].find((b) => (b.dataset.p || '').startsWith('lib:'));
  if (nav) nav.click(); else location.hash = '';
  await sleep(300);

  const rm = document.querySelector('[data-rm]');
  say('有移除按鈕', !!rm);
  if (!rm) { say('done', 1); return; }
  rm.click();
  await sleep(200);

  const box = document.getElementById('rmClean');
  say('有清理勾選框', !!box);
  say('預設不勾', box ? box.checked === false : false);
  if (!box) { say('done', 1); return; }

  box.checked = true; box.dispatchEvent(new Event('change'));
  await sleep(400);
  const planTxt = (document.getElementById('rmPlan') || {}).textContent || '';
  say('清單有列出要刪的路徑', planTxt.includes('.arcrun-rag') && planTxt.includes('docs/.wiki'));
  say('清單有列出留著不動的', planTxt.includes('pms_v1_legacy'));
  say('清單有講幾個檔', planTxt.includes('52'));

  document.getElementById('c2').click();
  await sleep(400);
  const call = window.__calls.find((c) => c[0] === 'RemoveFolder');
  say('有呼叫 RemoveFolder', !!call);
  say('第四個參數帶了 true', call ? call[4] === true : false);
  say('路徑正確', call ? call[2] === '/kb/pms' : false);
  say('done', 1);
});
JS

python3 - "$W" <<'PY'
import sys
p = sys.argv[1] + '/index.html'
s = open(p, encoding='utf-8').read()
s = s.replace('src="/assets/', 'src="./assets/').replace('href="/assets/', 'href="./assets/')
s = s.replace('<script type="module"', '<script src="./mock.js"></script>\n<script type="module"', 1)
open(p, 'w', encoding='utf-8').write(s)
PY

(cd "$W" && python3 -m http.server 8798 >/dev/null 2>&1) &
SRV_PID=$!
sleep 2
"$CHROME" --headless --disable-gpu --virtual-time-budget=8000 --dump-dom \
  "http://localhost:8798/index.html" 2>/dev/null > "$W/dom.html"

python3 - "$W/dom.html" <<'PY'
import re, sys
dom = open(sys.argv[1], encoding='utf-8').read()
got = dict(re.findall(r'<div data-check="([^"]+)">([^<]*)</div>', dom))
if not got:
    print("  ❌ 頁面沒跑到底（一個檢查點都沒寫出來）——看 dom.html"); sys.exit(1)
bad = 0
for k, v in got.items():
    if k == 'done':
        continue
    ok = v == 'true'
    print(f"  {'✅' if ok else '❌'} {k}：{v}")
    bad += 0 if ok else 1
if 'done' not in got:
    print("  ❌ 驅動腳本沒跑完"); sys.exit(1)
sys.exit(1 if bad else 0)
PY
