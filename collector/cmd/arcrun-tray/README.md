# Arcrun RAG 托盤殼（arcrun-tray）— 建置／簽章／TCC 交接

> CP-1 第 6 關 daemon 產品化。leo 2026-07-21 定框架＝**fyne**（窮舉七案後推薦，見頂層
> `journeys/daemon-tray-shell-options.md`）。**建置/簽章/公證/TCC 授權＝leo/地端在真機做**（紅線②③）。

## 這顆殼做什麼

一個**選單列（Mac）/系統匣（Windows）icon**，讓不開 terminal 的人也能用：
- 狀態一眼看（看守中 · 上次同步 HH:MM／啟動中／出錯自動重試／已暫停）
- 選單：**選擇知識資料夾**（系統原生對話框）／打開資料夾／暫停·繼續看守
- 關掉視窗＝縮回背景續看守（不是結束）

它**看守** `arcrun-collector direct`（同綑執行檔），把它當背景常駐；崩了自動重起。

## 哪些已驗、哪些待真機驗（誠實界定，mindset §7）

| 部分 | 狀態 | 驗法 |
|------|------|------|
| **看守核心** `collector/supervisor`（子行程管理／狀態解析／崩潰重起／停止） | ✅ **sandbox `go test` 驗過**（純 stdlib，5 測全綠，含重起/停止/狀態解析） | `cd collector && go test ./supervisor/` |
| collector 引擎（未動） | ✅ 既有測試無回歸 | `cd collector && go test ./...` |
| **fyne GUI 本體**（本 main.go：tray icon／選單／原生選資料夾） | ⏳ **待真機 build**——fyne 需 CGo＋GL/webview，無螢幕 sandbox 編不了 | 真機 `go mod tidy && fyne package` |
| macOS **TCC 同意流** | ⏳ 待真 Mac 驗（沙箱測不到真 TCC 語意＝假綠，故不盲寫） | 見下「TCC」 |

> ⚠️ **fyne API 細節（fyne.Do／SetSystemTrayMenu 刷新／Lifecycle）以首次真機 build 為準**——
> 本檔按 fyne v2.5 API 寫，但未經編譯器。第一次 `go mod tidy && go build` 若有 API 出入，就地修。

## 建置（leo/地端，真機）

```bash
cd collector/cmd/arcrun-tray
go mod tidy                       # 拉 fyne 依賴（首次需網路）
# 把 collector 執行檔一起放進 bundle（托盤靠同層 arcrun-collector）
（cd ../.. && GOOS=darwin GOARCH=arm64 go build -o cmd/arcrun-tray/arcrun-collector .）
# 打包 .app（Mac）／.exe（Win）
go run fyne.io/fyne/v2/cmd/fyne@latest package -os darwin -icon icon.png -name "Arcrun RAG"
# Windows：-os windows
```
> icon.png 待放（leo logo 進行中）；Mac 選單列建議 **template 單色 icon**（自動深淺色）。

## 簽章／公證（Mac，leo/地端）

未簽章的 .app 會被 Gatekeeper 擋（右鍵開可繞，但非產品體驗）。正式版：
```bash
codesign --deep --force --options runtime --sign "Developer ID Application: <你>" "Arcrun.app"
xcrun notarytool submit "Arcrun RAG.zip" --apple-id … --team-id … --wait
xcrun stapler staple "Arcrun.app"
```

## TCC（macOS，只有真 Mac 驗得到）

**預設 watch_folder ＝ `~/ArcrunRAG`（本殼已這樣設）——刻意避開 `~/Documents`**：launchd/背景程序碰
`~/Documents` 會被 TCC 擋（2026-07-19 實撞）。預設在非 TCC 禁區＝**零授權即可用**。

用戶若堅持把資料夾設在 `~/Documents`/`~/Desktop`/`~/Downloads`：
1. 首次讀取被拒 → 本殼應偵測並引導：**系統設定 → 隱私權與安全性 → 檔案與資料夾**（或完整磁碟取用權）勾選 Arcrun RAG。
2. 這一步**必須在真 Mac 上驗**（跳不跳授權框、launchd 背景 vs GUI 前景差異）。sandbox 只能測到 `os.Open` 成不成，測不到真 TCC＝假綠，故本輪不寫死。

## 安裝（用戶視角，最終形態）

下載 → 拖進「應用程式」→ 開啟 → 選一個資料夾 → 完成。cypher_url/namespace/api_key 由**安裝器**寫進
`~/.arcrun-rag/config.json`（用戶不碰）。**現行 `docs/manual/product-install-guide.md` 是廢棄的
Docker 六步，產品化時要重寫成這段。**
