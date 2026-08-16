---
tags: [Logseq, 外掛, 需求]
gloss: Logseq 外掛的需求文件，涵蓋平台支援、權限、稽核與更新
created: 2026-08-16
updated: 2026-08-16
---
# Requirements (Logseq-plugin)

← [[00-INDEX]]

## 摘要
這份文件是一個 Logseq 外掛的需求規格，載明外掛繼承根目錄 CONSTITUTION.md 的限制，並列出外掛在啟用後應提供的功能、支援的作業系統、權限控管方式，以及更新與稽核的規定。

## 重點
- 使用者啟用外掛時，系統必須增強功能
- 外掛必須繼承自根目錄 CONSTITUTION.md 的限制
- 系統必須在使用者使用 Logseq 時啟用外掛
- 外掛功能必須在 Logseq 中執行
- 系統必須在 Windows、macOS 或 Linux 上運行
- 外掛程式必須在使用者未授權時拒絕存取敏感資料
- 系統必須記錄使用者操作日誌
- 外掛程式必須每 30 天檢查一次更新

## 實體
- **Logseq**（工具）— 這份需求所針對的筆記軟體
- **CONSTITUTION.md**（檔案）— 根目錄的限制來源

## 關聯
### 內文知識關係
### 卡片關係
### 出處
- `../requirements.md` >> 提及 >> Requirements (Logseq-plugin)
