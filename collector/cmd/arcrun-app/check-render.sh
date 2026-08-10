#!/usr/bin/env bash
# check-render.sh — **看得見的驗收**：用 headless Chrome 真的渲染一次並量像素（t193）
#
# 🔴 leo 2026-08-04：「既然是 Web，你做的時候**無法檢視**？例如用 chrome dev tool mcp？」
#    ⇒ 對，可以。以後改完 UI 就跑這支，不要再拿沒看過的畫面交件。
#
# 它驗兩件肉眼容易漏、但機器一量就知道的事：
#   ① lockup 底板與品牌區背景是否接合（paper-on-ink.png 自帶不透明 Ink 底板，
#      背景不對就會出現一個突兀方塊——leo 截圖裡看到的就是它）
#   ② 深色模式的規則有沒有真的進到 build（曾發生 dist 是舊的、我卻對著舊圖除錯）
set -uo pipefail
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "❌ 找不到 Chrome，跳過渲染檢查"; exit 0; }
[ -d frontend/dist ] || { echo "❌ 沒有 frontend/dist——先 wails build"; exit 1; }

W=$(mktemp -d)
# 🔴 2026-08-05：原本 trap 用 `kill %1`（job spec），在子 shell／連續執行時抓不到
#   ⇒ 上一次的 http.server 沒收掉、佔住 8799 ⇒ 下一次跑抓到**舊頁面**、誤報紅燈
#   （實撞：同一份 build 連跑三次，一次綠兩次紅，白追一輪）。改記 PID 收。
SRV_PID=""
cleanup() { rm -rf "$W"; [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null; }
trap cleanup EXIT
# 保險：先清掉任何殘留在該 port 上的 server（可能是上次沒收乾淨的）
lsof -ti tcp:8799 2>/dev/null | xargs -r kill 2>/dev/null; sleep 0.3
cp -R frontend/dist/* "$W/"
cat > "$W/mock.js" <<'JS'
// 🔴 2026-08-05：主題要用 localStorage 設，不能只改 <html data-theme>。
//   t193 三修（leo）起 main.js 啟動時會依 localStorage 覆寫成**預設淺色**
//   ⇒ 光改 HTML 屬性會被 JS 蓋掉，量到全白 → 誤報「深色模式沒生效」。
//   mock.js 在 module 之前載入，正好趕在 applyTheme() 之前寫入。
try { localStorage.setItem('arcrun_app_theme','dark'); } catch (e) {}
// 保險：headless 下 localStorage 可能被限制 ⇒ 在 module 跑完後再強制設一次屬性。
// （main.js 的 applyTheme 只在啟動時跑一次，之後不會再蓋回去。）
addEventListener('DOMContentLoaded', () => {
  setTimeout(() => document.documentElement.setAttribute('data-theme','dark'), 0);
});
window.go={main:{App:{GetState:async()=>({version:'v0',statusBig:'看守中',statusSub:'',
 syncing:false,engine:'workers-ai',geminiKey:'',extractedOK:0,accounts:[]}),
 SyncNow:async()=>{},PickFolder:async()=>'',AddFolder:async()=>{},RemoveFolder:async()=>{},
 SetAI:async()=>{},OpenURL:()=>{},Connect:async()=>{},CheckUpdate:async()=>({})}}};
JS
python3 - "$W" <<'PY'
import re,sys
p=sys.argv[1]+'/index.html'; s=open(p,encoding='utf-8').read()
s=s.replace('src="/assets/','src="./assets/').replace('href="/assets/','href="./assets/')
s=s.replace('<script type="module"','<script src="./mock.js"></script>\n<script type="module"',1)
s=re.sub(r'<html[^>]*>','<html lang="zh-Hant" data-theme="dark">',s,count=1)
open(p,'w',encoding='utf-8').write(s)
PY
(cd "$W" && python3 -m http.server 8799 >/dev/null 2>&1) &
SRV_PID=$!
sleep 2
"$CHROME" --headless --disable-gpu --screenshot="$W/s.png" --window-size=1120,780 \
  --hide-scrollbars --virtual-time-budget=3000 "http://localhost:8799/index.html" >/dev/null 2>&1

python3 - "$W/s.png" <<'PY'
import zlib,struct,sys
d=open(sys.argv[1],'rb').read(); pos=8; idat=b''; w=h=ct=0
while pos<len(d):
    ln=struct.unpack('>I',d[pos:pos+4])[0]; t=d[pos+4:pos+8]
    if t==b'IHDR': w,h,_,ct=struct.unpack('>IIBB',d[pos+8:pos+18])
    if t==b'IDAT': idat+=d[pos+8:pos+8+ln]
    pos+=12+ln
raw=zlib.decompress(idat); ch=4 if ct==6 else 3; stride=w*ch+1
rows=[]; prev=bytearray(w*ch)
for y in range(h):
    f=raw[y*stride]; line=bytearray(raw[y*stride+1:(y+1)*stride])
    for i in range(len(line)):
        a=line[i-ch] if i>=ch else 0; b=prev[i]; c=prev[i-ch] if i>=ch else 0
        if f==1: line[i]=(line[i]+a)&255
        elif f==2: line[i]=(line[i]+b)&255
        elif f==3: line[i]=(line[i]+(a+b)//2)&255
        elif f==4:
            pp=a+b-c; pa,pb,pc=abs(pp-a),abs(pp-b),abs(pp-c)
            pr=a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
            line[i]=(line[i]+pr)&255
    rows.append(bytes(line)); prev=line
px=lambda x,y:tuple(rows[y][x*ch:x*ch+3])
# logo 現在用**裁淨版透明底** ⇒ 品牌區四周應該就是頁面底色，不該出現任何色塊。
# 取 logo 上方與下方各一點：若與側欄底色不同，代表又墊了底板或圖沒裁淨。
side = px(10, 300)          # 側欄純底色
above, below = px(150, 6), px(150, 62)
worst = max(max(abs(a-b) for a,b in zip(side,p)) for p in (above, below))
print(f"  側欄底色 {side} ／ logo 上方 {above} ／ 下方 {below} ／ 最大落差 {worst}")
if worst > 10:
    print("  ❌ logo 周圍出現色塊——底板沒去掉或用到未裁淨的圖"); sys.exit(1)
print("  ✅ logo 透明底、周圍無色塊")
# 深色模式有沒有生效：整體應該偏暗
if sum(px(600,400))/3 > 120:
    print("  ❌ 深色模式沒生效（右側內容區偏亮）"); sys.exit(1)
print("  ✅ 深色模式生效")
PY
