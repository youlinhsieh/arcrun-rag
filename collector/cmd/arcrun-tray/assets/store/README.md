# Microsoft Store 圖示素材（msix）

這裡的 PNG 是 **產物**，但**隨 repo 版控**——因為 `build-msix.sh` 打包時只做 `cp`，
不在打包當下重算（打包機不一定拿得到 CIS 素材）。

## 真身在哪

品牌素材真身＝`InkStoneCo/arcrun-cis/`（leo 的 CIS，2026-07-31）。
**不要在這裡改圖**；要改品牌就改 CIS，然後重跑產生器。

## 重新產生

```bash
python3 gen-store-assets.py          # 需要 Pillow
# CIS 不在預設位置時：
ARCRUN_CIS=/path/to/arcrun-cis python3 gen-store-assets.py
```

## 每個檔案是什麼

| 檔案 | 尺寸 | 用途 | 取材 |
|---|---|---|---|
| `Square44x44Logo.png` | 44×44 | 應用程式清單、工作列 | 方形 icon |
| `StoreLogo.png` | 50×50 | Store 頁面小圖 | 方形 icon |
| `Square71x71Logo.png` | 71×71 | 小磚 | 方形 icon |
| `Square150x150Logo.png` | 150×150 | 中磚（預設磚） | 方形 icon |
| `Square310x310Logo.png` | 310×310 | 大磚 | 方形 icon |
| `Wide310x150Logo.png` | 310×150 | 寬磚 | **橫式 lockup** |
| `Square44x44Logo.targetsize-{16,24}.png` | 16/24 | 工作列小圖 | **雙 chevron** |
| `Square44x44Logo.targetsize-{32,48,256}.png` | 32/48/256 | 檔案總管各檢視 | 方形 icon |

## 兩條「為什麼不是直接縮」的理由（別再改回去）

1. **寬磚不能用方形 icon 硬拉**。舊版寫 `sips -z 150 310 icon.png`，
   `sips -z` 會**照給定的長寬直接拉扁**——實測產出的字符明顯變形，
   違反 CIS 的 Don't「never skew or stretch」。寬磚要用橫式 lockup。
2. **16/24px 不能用完整方形 icon**。CIS 明寫「26px 以下降級成 chevron」：
   方形 icon 裡的字符只佔畫面高度約 28%，16px 下只剩約 4px 高，糊成一團。
