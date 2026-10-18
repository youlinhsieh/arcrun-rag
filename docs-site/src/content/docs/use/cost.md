---
title: 小幫手畫面上的 $ 是什麼錢
description: 用量頁出現的金額是 Cloudflare 收的，不是我們收的。這一頁講它怎麼來、去哪裡看正式帳單。
---

## 一句話

用量頁上的 **$ 加一個數字**（例如 `$ 0.99`），是 **Cloudflare 向你收的錢，不是我們收的。**

你的知識庫跑在**你自己的 Cloudflare 帳號**裡，所以用多少、收多少，都是 Cloudflare 跟你的帳號結算。
Arcrun RAG 和小幫手**不收這筆費用**，也不經手它。

## 那個數字怎麼來的

- 它是小幫手**根據 Cloudflare 回報的用量，估出來的**「超過內含額度的那一部分」。
- 它是**所有超過額度的項目加起來**的估算費用；清單各列不再各放一個 `$`，超線的錢全部合在這一個數字裡。
- 數字會隨用量往前跳，那是估算在走，**不是已經扣款**。

:::caution[要核對錢，以 Cloudflare 的帳單為準]
小幫手的數字是即時估算，Cloudflare 的帳單才是正式的，兩者可能差一點點。
正式金額請到 **[Cloudflare 帳單頁](https://dash.cloudflare.com/?to=/:account/billing)** 看
（用你當初安裝時登入的那個 Cloudflare 帳號）。
:::

## 我沒有付費方案，為什麼會有 $？

不會。**免費方案超過額度是「暫停到明天」，不是收費**，所以免費帳號的用量頁沒有金額，
只有一個 `$` 圖示，那是**升級入口**：想付費才按它，怎麼升級見 [額度怎麼算](/docs/use/quota/#怎麼升級四步)。

## 不想讓它一直往上跳

用量頁旁邊的**剎車**按鈕，就是為了這件事：快到額度線時自動放慢，不讓你多花錢。
開關在知識庫網頁的 **管理** 頁（用量頁的剎車按鈕會直接帶你過去）。

## 更多

- 價目表請看 Cloudflare 官方：[Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)、
  [D1 定價](https://developers.cloudflare.com/d1/platform/pricing/)。
  我們不把別人的價目表抄一份放在這裡，抄過來的版本遲早會過期。
- 為什麼小幫手的數字和 Cloudflare 後台不一樣：見 [額度怎麼算](/docs/use/quota/#用量表的數字從哪來為什麼和-cloudflare-後台不一樣)。
