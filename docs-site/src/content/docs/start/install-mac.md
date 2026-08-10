---
title: 安裝（Mac）
description: Mac 安裝步驟，含「未簽章 App」擋下來時怎麼過。
---

## 第一步：安裝你的知識庫（雲端）

到 [install.arcrun.dev](https://install.arcrun.dev/)，照畫面按。

過程中會請你登入 **Cloudflare**（沒有帳號就免費註冊一個）。
這是把知識庫裝進**你自己的帳號**，所以資料是你的。

![Cloudflare 授權畫面](/docs/images/cf-auth.png)

裝完會看到成功畫面，上面有你的**知識庫網址**，等一下要用。

![安裝成功](/docs/images/if_succeed.png)

## 第二步：下載「同步小幫手」

在成功畫面按 **下載 Mac 版**，會拿到一個 `.dmg` 檔。

## 第三步：拖進「應用程式」

打開 `.dmg`，你會看到這個畫面：

```
   Arcrun.app   ──拖到──▶   Applications
```

**把左邊的 Arcrun 拖到右邊的 Applications 資料夾。** 這樣就裝好了。

:::caution[請務必拖進去，不要直接在下載資料夾裡打開]
如果你直接雙擊 `.dmg` 裡的 App 執行，之後「檢查更新」會更新不了
（更新會蓋到別的地方，而你打開的還是舊的）。
:::

## 第四步：第一次打開會被擋下來（正常，照這四步做）

Mac 會跳出「未打開『Arcrun』／Apple 無法驗證⋯」。

**這不是病毒**，是因為我們還沒買 Apple 的開發者簽章（$99/年），
macOS 對沒簽章的程式一律先攔下來。封測期間請照這四步：

### ① 先按「完成」

:::danger[千萬不要按「丟到垃圾桶」]
按錯就要重新下載一次。
:::

![未打開 Arcrun](/docs/images/mac_unsigned/1.png)

### ② 打開「系統設定 → 隱私權與安全性」，往下捲到「安全性」，按「強制打開」

![隱私權與安全性 強制打開](/docs/images/mac_unsigned/2.png)

### ③ 它會再問一次，按中間的「強制打開」

:::caution
藍色那顆是「丟到垃圾桶」，**別按錯**。
:::

![再次確認 強制打開](/docs/images/mac_unsigned/3.png)

### ④ 用 Touch ID 或輸入你電腦的密碼

![Touch ID 驗證](/docs/images/mac_unsigned/4.png)

**這四步只需要做一次**，之後直接雙擊就能開。

## 第五步：確認它在跑

打開後**Dock 不會出現圖示**（這是刻意的），
請看螢幕**最上面那排選單列**，會出現一個小圖示。點它就是主選單。

## 下一步

[連上你的知識庫](../connect/)
