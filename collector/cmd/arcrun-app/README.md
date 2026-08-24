# Arcrun 桌面小幫手（Wails）— 地端 build 說明

> 這份取代了原本 `wails init` 留下的英文樣板 README（那份只寫「用 `wails build`」，
> 而這裡真正的打包線是旁邊那四支腳本，不是裸的 `wails build`）。
>
> 🔴 **為什麼會有這份**（leo 2026-08-24，`inkstone/arcrun-rag#137`）：
> 「daemon 部分要傳給地端做，**或是你做好給它 build**」——採後者。
> 雲端只交**編得起來的 code**，安裝檔（DMG／exe／msix）由地端打，
> 因為那需要 macOS／Windows 環境與簽章，雲端沒有。

---

## 一、一次性前置（每台機器裝一次）

| 需要 | 怎麼裝 | 用來做什麼 |
|---|---|---|
| Go **1.25+** | `brew install go`（`go.mod` 寫 `go 1.25.0`；較舊的 Go 會自己抓 toolchain） | 編 App 與 collector |
| Node 18+ | `brew install node` | 編前端（Vite） |
| Wails CLI v2 | `go install github.com/wailsapp/wails/v2/cmd/wails@v2.13.0` | 打包 |
| mingw-w64 | `brew install mingw-w64` | **只有要打 Windows 版才需要**（WebView2 要 CGo 交叉編譯） |
| cmake、icu4c | `brew install cmake icu4c` ＋ `bash build-msix.sh --setup` | **只有要送 Microsoft Store 才需要** |

> `wails` 裝完記得 `export PATH="$PATH:$(go env GOPATH)/bin"`（四支 build 腳本自己也會補這行）。

## 二、打包：跑既有的腳本，不要自己下 `wails build`

```sh
cd collector/cmd/arcrun-app

./build-mac.sh      # → build/bin/Arcrun.app
./build-dmg.sh      # → dist/Arcrun-<版本>.dmg      （自己會先跑 build-mac.sh）
./build-win.sh      # → dist/Arcrun-<版本>.exe      （在 Mac 上交叉編譯，需 mingw-w64）
./build-msix.sh     # → dist/Arcrun-<版本>.msix     （送 Store 用；不必自購憑證）
```

🔴 **版本號不要手打。** `daemon-version.py --stamp` 會從 `collector/CHANGELOG.md`
最上面那個「下一版（未發佈）」段落戳出版號並補上日期——四支腳本都已經呼叫它。
本次（`#137`）的 changelog 段落已經寫好，所以**這一版打出來會是 `0.18.35`**
（`./daemon-version.py` 唯讀查詢可以先確認）。

🔴 打包前若改過任何 `collector/` 底下的檔，指紋會變 ⇒ 同一個版號不准對應兩份原始碼，
腳本會擋下來並告訴你怎麼辦。那是刻意的閘，不要繞過它。

## 三、交貨前自己先驗（這三支都在本目錄，跑得很快）

```sh
go test ./...                       # 後端（含本次新增的 App 啟動器 12 條）
bash check-cis.sh                   # CIS 合規（色票／lockup／選中態）
npm --prefix frontend run build && node check-launcher.mjs   # 畫面與互動（需 playwright）
```

`check-launcher.mjs` 會真的把 `frontend/dist` 渲染出來、真的點下去，
截圖丟在 `/tmp/arcrun-launcher-shots/`。沒裝 playwright 它會自己跳過
（`npm i -D playwright && npx playwright install chromium`）。

macOS 上另外還有 `check-render.sh`（量 lockup 像素與深色模式），需要本機的 Chrome。

## 四、只有在真機上才驗得到的（雲端做不到，地端請補）

雲端這台沒有 GUI、也沒有 WebView，所以下面這些**沒有被驗過**，
打包完請在真機上走一次：

1. `wails dev`（或直接開打好的 `Arcrun.app`）能不能起來、視窗尺寸對不對。
2. 系統匣：Mac 是原生 `NSStatusItem`（`tray_darwin.m`）、Windows 是 `energye/systray`；
   點 icon 開窗、右鍵只有「結束 Arcrun」。
3. **App 啟動器**（本次新增）：打開就落在「App 界面」，九宮格列出的是你連的那個
   知識庫實際裝了的 App；點一個進去、按一下它的動作，看結果回不回得來。
4. Windows：WebView2 有沒有裝、SmartScreen 會不會攔、Defender 會不會誤判。

## 五、平台檔案對照（改東西前先看這張）

| 檔 | build tag | 說明 |
|---|---|---|
| `tray_darwin.go` / `tray_darwin.m` | `darwin` | macOS 原生 NSStatusItem |
| `tray_windows.go` | `windows` | Windows systray |
| `tray_other.go` | `!darwin && !windows` | **no-op**。讓 `go build`／`go test` 在 Linux／CI 上跑得起來，對出貨零影響（Linux 不是出貨平台） |
| `dock_darwin.go` / `dock_other.go` | 同上 | Dock icon 隱藏 |

## 六、開發時的即時預覽

```sh
wails dev
```
Vite 熱重載；`http://localhost:34115` 可以用瀏覽器連進去，Go 方法一樣叫得到。
