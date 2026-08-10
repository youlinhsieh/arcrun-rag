#!/usr/bin/env bash
# check-tray.sh — 托盤行為的機械閘（t194，leo 真機測出四個 bug 後補）
#
# 🔴 為什麼要有：這四個 bug **編得過、也跑得起來**，只有真的去點才會發現。
#    我改完只驗「build ok」就想交，被交付警察攔下。
#    ⇒ 把「點不下去的部分」用可機械檢查的**前置條件**守住。
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
ok(){ printf "  ✅ %s\n" "$1"; }
ng(){ printf "  ❌ %s\n" "$1"; FAIL=1; }

echo "━━━ 托盤行為前置條件 ━━━"

# ① template icon：純黑＋大量透明、尺寸 22/44
python3 - <<'PY' || exit 1
import zlib,struct,sys
d=open('build/trayicon.png','rb').read()
pos=8; idat=b''; w=h=ct=0
while pos<len(d):
    ln=struct.unpack('>I',d[pos:pos+4])[0]; t=d[pos+4:pos+8]
    if t==b'IHDR': w,h,_,ct=struct.unpack('>IIBB',d[pos+8:pos+18])
    if t==b'IDAT': idat+=d[pos+8:pos+8+ln]
    pos+=12+ln
if w not in (22,44) or ct!=6:
    print(f"  ❌ tray icon 應為 22/44 的 RGBA，got {w}x{h} ct={ct}"); sys.exit(1)
raw=zlib.decompress(idat); ch=4; stride=w*ch+1
rows=[];prev=bytearray(w*ch)
for y in range(h):
    f=raw[y*stride];line=bytearray(raw[y*stride+1:(y+1)*stride])
    for i in range(len(line)):
        a=line[i-ch] if i>=ch else 0;b=prev[i];c=prev[i-ch] if i>=ch else 0
        if f==1: line[i]=(line[i]+a)&255
        elif f==2: line[i]=(line[i]+b)&255
        elif f==3: line[i]=(line[i]+(a+b)//2)&255
        elif f==4:
            pp=a+b-c;pa,pb,pc=abs(pp-a),abs(pp-b),abs(pp-c)
            pr=a if(pa<=pb and pa<=pc) else (b if pb<=pc else c)
            line[i]=(line[i]+pr)&255
    rows.append(bytes(line));prev=line
al=[rows[y][x*4+3] for y in range(h) for x in range(w)]
opq=sum(1 for a in al if a>200)
if opq > len(al)*0.5:
    print(f"  ❌ tray icon 幾乎全不透明（{100*opq//len(al)}%）⇒ 會顯示成方塊"); sys.exit(1)
cols={tuple(rows[y][x*4:x*4+3]) for y in range(h) for x in range(w) if rows[y][x*4+3]>200}
print(f"  ✅ template icon：{w}x{h}、不透明 {100*opq//len(al)}%、顏色 {len(cols)} 種 {list(cols)[:1]}")
PY

# ② 原生托盤：三個必要條件（每一個都是實測踩過的坑）
python3 - <<'PY2' || exit 1
import sys
m=open('tray_darwin.m',encoding='utf-8').read()
g=open('tray_darwin.go',encoding='utf-8').read()
bad=[]
# (a) 不可用 dispatch_async(main_queue)：Wails 佔住主執行緒後不跑標準 run loop，
#     排進 main queue 的 block 永遠不會執行（實測 log 只印到 dispatching…）
if 'dispatch_async(dispatch_get_main_queue' in m:
    bad.append('用了 dispatch_async(main_queue) ⇒ Wails 之下不會執行')
# (b) 必須 performSelectorOnMainThread：NSStatusItem 要主執行緒＋NSApp 已初始化
if 'performSelectorOnMainThread' not in m:
    bad.append('缺 performSelectorOnMainThread ⇒ NSStatusItem 建不起來或崩潰')
# (c) 不可 setMenu:——設了選單，按鈕 action 不會被呼叫，左鍵也會變成彈選單
if '.item setMenu:' in m or 'item.menu = self.menu;' in m and 'item.menu = nil' not in m:
    bad.append('把選單常駐掛在 statusItem 上 ⇒ 左鍵會失效')
# (d) 不可再依賴 energye/systray（實測它在 RunWithExternalLoop 下根本不建托盤）
if 'energye/systray' in g:
    bad.append('還在用 energye/systray ⇒ 外部 loop 之下不會建立托盤')
if bad:
    for b in bad: print(f"  ❌ {b}")
    sys.exit(1)
print("  ✅ 原生托盤：主執行緒建立、不常駐掛選單、未依賴 systray")
PY2

# ③ ShowWindow 要能叫回「已開但被蓋住」的視窗
for f in WindowUnminimise WindowShow WindowSetAlwaysOnTop; do
  grep -q "runtime.$f" app.go && ok "ShowWindow 有 $f" || ng "ShowWindow 缺 $f（叫不回被蓋住的視窗）"
done

# ④ 結束路徑：收訊號 → 停子行程 → 等它真的不見
grep -q "signal.Notify" supervise.go && ok "有處理 SIGTERM/SIGINT" || ng "沒有訊號處理（只能強制結束）"
grep -q "waitCollectorGone" supervise.go && ok "結束前會等 collector 真的不見" || ng "沒等子行程 ⇒ 會留孤兒"

echo
[ $FAIL -eq 0 ] && echo "✅ 托盤前置條件全過" || { echo "❌ 未過——不准交貨"; exit 1; }
