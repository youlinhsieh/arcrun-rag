#!/usr/bin/env bash
# check-remove-account.sh — 驗使用者真的會走的那條路：
# 進某個知識庫帳號頁 → 按「移除這個知識庫帳號」→ 看到後果說明 → 按移除（inkstone/arcrun-rag#401）。
# 另驗：該帳號有資料夾「收回中」時，只能看到擋下說明、沒有「移除」鈕。
# 做法同 check-remove-cleanup.sh（mock window.go + headless Chrome 真點 + dump-dom）。
# CHROME 可用環境變數指定；預設找 macOS Chrome，再找 linux 的 google-chrome。
set -uo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || CHROME=$(command -v google-chrome || command -v chromium || true)
[ -n "$CHROME" ] && [ -x "$CHROME" ] || { echo "❌ 找不到 Chrome，跳過"; exit 0; }
[ -d frontend/dist ] || { echo "❌ 沒有 frontend/dist——先 (cd frontend && npm run build)"; exit 1; }

W=$(mktemp -d)
SRV_PID=""
cleanup() { rm -rf "$W"; [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT
PORT=8797
(command -v lsof >/dev/null && lsof -ti tcp:$PORT 2>/dev/null | xargs -r kill 2>/dev/null); sleep 0.3
cp -R frontend/dist/* "$W/"

cat > "$W/mock.js" <<'JS'
window.__calls = [];
let accounts = [
  { name: '正式站', host: 'a.example.workers.dev', folders: [{ path: '/kb/a', accIdx: 0, retiring: false }] },
  { name: 'stage', host: 'b.example.workers.dev', folders: [{ path: '/kb/old', accIdx: 1, retiring: true }] },
];
window.go = { main: { App: {
  GetState: async () => ({
    version: 'v0', statusBig: '看守中', statusSub: '', syncing: false,
    engine: 'workers-ai', geminiKey: '', extractedOK: 0, accounts,
  }),
  PlanAccountRemoval: async (i) => {
    window.__calls.push(['PlanAccountRemoval', i]);
    return { name: accounts[i].name, folders: i === 0 ? 1 : 0, retiring: i === 1 ? 1 : 0, primary: i === 0, next: i === 0 ? 'stage' : '' };
  },
  RemoveAccount: async (i) => { window.__calls.push(['RemoveAccount', i]); accounts = accounts.filter((_, k) => k !== i); },
  SyncNow: async () => {}, PickFolder: async () => '', AddFolder: async () => {},
  SetAI: async () => {}, OpenURL: () => {}, Connect: async () => {},
  CheckUpdate: async () => ({}), OpenLogFolder: () => {}, LogFolderPath: () => '',
  ListApps: async () => ({ apps: [] }),
} } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (k, v) => { const d = document.createElement('div'); d.setAttribute('data-check', k); d.textContent = String(v); document.body.appendChild(d); };
const navTo = async (n) => {
  const b = [...document.querySelectorAll('.nav')].filter((x) => (x.dataset.p || '').startsWith('lib:'))[n];
  if (b) b.click(); await sleep(300);
};

addEventListener('DOMContentLoaded', async () => {
  await sleep(600);
  // 1) 第二個帳號有「收回中」⇒ 擋下
  await navTo(1);
  let rm = document.querySelector('[data-rmacc]');
  say('帳號頁有移除入口', !!rm);
  if (!rm) { say('done', 1); return; }
  rm.click(); await sleep(300);
  say('收回中時講明原因', !!document.getElementById('rmaBlock') && document.getElementById('rmaBlock').textContent.includes('收回'));
  say('收回中時沒有移除鈕', !document.getElementById('c2'));
  document.getElementById('c1').click(); await sleep(100);

  // 2) 第一個帳號（主帳號）正常移除
  await navTo(0);
  document.querySelector('[data-rmacc]').click(); await sleep(300);
  const sheet = document.getElementById('sheet').textContent;
  say('講清楚停止同步', sheet.includes('停止同步'));
  say('講清楚知識庫裡的知識不受影響', sheet.includes('不受影響') && sheet.includes('網頁'));
  say('主帳號講問答改用誰', sheet.includes('問答改用 stage'));
  document.getElementById('c2').click(); await sleep(500);
  const call = window.__calls.find((c) => c[0] === 'RemoveAccount');
  say('呼叫了 RemoveAccount(0)', !!call && call[1] === 0);
  const navs = [...document.querySelectorAll('.nav')].filter((x) => (x.dataset.p || '').startsWith('lib:'));
  say('側欄只剩一個帳號', navs.length === 1);
  say('畫面回到首頁、沒有殘留對話框', !document.getElementById('overlay').classList.contains('on'));
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

(cd "$W" && python3 -m http.server $PORT >/dev/null 2>&1) &
SRV_PID=$!
sleep 2
"$CHROME" --headless --no-sandbox --disable-gpu --virtual-time-budget=8000 --dump-dom \
  "http://localhost:$PORT/index.html" 2>/dev/null > "$W/dom.html"

python3 - "$W/dom.html" <<'PY'
import re, sys
dom = open(sys.argv[1], encoding='utf-8').read()
got = dict(re.findall(r'<div data-check="([^"]+)">([^<]*)</div>', dom))
if not got:
    print("  ❌ 頁面沒跑到底（一個檢查點都沒寫出來）"); sys.exit(1)
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
