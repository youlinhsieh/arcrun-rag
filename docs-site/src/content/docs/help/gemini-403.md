---
title: Gemini 金鑰被擋（403）
description: 只有選用 Gemini 的人會遇到；一般人不需要看這頁。
---

:::note[大部分人用不到這頁]
從 **v0.15.6** 起，預設用你自己 Cloudflare 帳號內建的 AI，**完全不需要 Gemini 金鑰**。

只有主動在「AI 設定…」選了 Gemini 的人才需要看這頁。
:::

## 症狀

整理檔案全部失敗，錯誤訊息裡有 `403` 或 `PERMISSION_DENIED`。

## Google 的原始回應長這樣

```json
{
  "error": {
    "code": 403,
    "message": "Permission denied",
    "status": "PERMISSION_DENIED"
  }
}
```

## 這是什麼意思

**不是你設錯，是你的 Google 帳號被限制了。**

Google 官方說法：

> Getting a 403 API error response and / or seeing "Unavailable" next to your project
> indicates **a flag has been placed on your account**.

## 怎麼確認

拿你的金鑰打這個網址（把 `YOUR_KEY` 換掉）：

```
https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY
```

- **回 200** → 金鑰本身是好的，是帳號層級被限制
- **回 403** → 金鑰無效或已被撤銷

## 解法

| 做法 | 有效嗎 |
|---|---|
| **改用雲端 AI（不填 Gemini 金鑰）** | ✅ **最推薦，一分鐘解決** |
| 換一個 Google 帳號申請新金鑰 | ✅ 可行 |
| 在同一帳號建新專案 | ❌ 沒用，限制在帳號層級 |
| 申訴 | ⚠️ 沒有官方表單，只能到[社群論壇](https://discuss.ai.google.dev/c/gemini-api/4)發問 |

## 最快的解法

點小圖示 → **AI 設定…** → 選「**雲端 AI（推薦・不必申請任何金鑰）**」→ 儲存。

![AI 設定](/docs/images/daemon_AI_setting.png)

這樣就完全繞開 Google 了。
