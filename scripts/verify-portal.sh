#!/bin/bash
# portal 健檢：一次驗完「用戶真的會看到什麼」（2026-07-29 白畫面事故後立）
# 用法：scripts/verify-portal.sh <worker-subdomain>   例：verify-portal.sh youlin-hsieh-dev
set -u
sub="${1:?用法：$0 <worker-subdomain>}"
url="https://arcrun-rag-ui.${sub}.workers.dev/portal/"
tmp=$(mktemp -d)
echo "① 抓實例 HTML"
code=$(curl -s -m 30 -o "$tmp/p.html" -w '%{http_code}' "${url}?cb=$RANDOM$RANDOM")
echo "   HTTP $code  $(wc -c < "$tmp/p.html" | tr -d ' ')B"
echo "② 內嵌 JS 語法（語法錯＝整支不執行＝白畫面）"
python3 - "$tmp" <<'PY'
import re,io,sys,subprocess,os
t=sys.argv[1]
h=io.open(os.path.join(t,'p.html'),encoding='utf-8',errors='ignore').read()
blocks=re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>',h,re.S)
bad=0
for i,b in enumerate(blocks):
    p=os.path.join(t,f'b{i}.js'); io.open(p,'w',encoding='utf-8').write(b)
    r=subprocess.run(['node','--check',p],capture_output=True,text=True)
    if r.returncode: bad+=1; print(f'   ❌ 第{i+1}段語法錯：{r.stderr.strip().splitlines()[-1][:70]}')
print(f'   {"✅ 全部通過" if not bad else "❌ 有語法錯"}（{len(blocks)} 段）')
PY
echo "③ headless 實跑：畫面有沒有內容（不是只看 HTTP 200）"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$C" ]; then
  "$C" --headless --disable-gpu --virtual-time-budget=8000 --dump-dom "$url" 2>/dev/null > "$tmp/dom.html"
  python3 - "$tmp" <<'PY'
import re,io,sys,os
s=io.open(os.path.join(sys.argv[1],'dom.html'),encoding='utf-8',errors='ignore').read()
on=bool(re.search(r'class="[^"]*\bview\b[^"]*\bon\b',s))
body=re.search(r'<body[^>]*>(.*?)</body>',s,re.S)
txt=re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',body.group(1))).strip() if body else ''
print(f'   有 view 開啟：{"✅" if on else "❌ 沒有任何 view 被開啟＝白畫面"}')
print(f'   可見文字：{txt[:80]}')
PY
else echo "   （找不到 Chrome，略過）"; fi
echo "④ 快取標頭（服務端有沒有叫瀏覽器別存舊的）"
curl -sI -m 20 "$url" | grep -i "cache-control" | sed 's/^/   /'
rm -rf "$tmp"
echo "⚠️ 若以上全過但用戶仍看到白畫面 ⇒ 用戶端快取，請他用無痕視窗驗證。"
