# release-line-gate 執行紀錄

> 每一次執行都記一行——**擋下與放行都記**。只記擋下的話分母是未知的，
> 回答不了「這道閘到底有沒有在運作」（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）。

| 時間 | 目標 | 版本線 | 結果 | 擋下什麼 |
|---|---|---|---|---|
| 2026-08-18 12:38:00 | prod | bundle 1.4.46；daemon v0.18.28 | ⛔ 擋下 | 每條版本線都已發佈到 youlinhsieh/arcrun-rag |
| 2026-08-18 13:30:39 | selftest | bundle 1.4.45；daemon v0.18.29 | ⛔ 擋下 | 版本發佈落在產品 repo，不是產物倉庫 |
| 2026-08-18 13:30:48 | selftest | bundle 1.4.45；daemon v0.18.29 | ⛔ 擋下 | 版本發佈落在產品 repo，不是產物倉庫 |
| 2026-08-18 13:34:18 | selftest | bundle 1.4.45；daemon v0.18.29 | ⛔ 擋下 | 版本發佈落在產品 repo，不是產物倉庫 |
| 2026-08-18 15:48:05 | stage | bundle 1.4.48；daemon v0.18.30 | ✅ 放行 | — |
| 2026-08-18 15:49:13 | stage | bundle 1.4.48；daemon v0.18.30 | ✅ 放行 | — |
| 2026-08-18 18:00:06 | stage | bundle 1.4.49；daemon 0.18.33 | ✅ 放行 | — |
| 2026-08-18 22:58:32 | stage | bundle 1.4.49；daemon 0.18.33 | ✅ 放行 | — |
| 2026-08-20 11:28:24 | stage | bundle 1.4.49；daemon 0.18.34 | ✅ 放行 | — |
| 2026-08-23 19:24:16 | stage | bundle 1.4.49；daemon 0.18.34 | ✅ 放行 | — |
| 2026-08-24 16:50:59 | stage | bundle 1.4.50；daemon 0.18.34 | ✅ 放行 | — |
| 2026-08-24 18:29:51 | stage | bundle 1.4.51；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-24 19:13:00 | stage | bundle 1.4.52；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-24 20:20:36 | stage | bundle 1.4.53；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-25 12:29:38 | prod | bundle 1.4.53；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-25 21:42:08 | stage | bundle 1.4.53；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-25 21:51:12 | stage | bundle 1.4.53；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-25 21:57:19 | prod | bundle 1.4.53；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-26 08:02:23 | stage | bundle 1.4.54；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-26 08:22:43 | prod | bundle 1.4.54；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-26 08:46:02 | stage | bundle 1.4.54；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-26 09:07:11 | prod | bundle 1.4.54；daemon 0.18.36 | ✅ 放行 | — |
| 2026-08-26 17:25:24 | stage | bundle 1.4.55；daemon 0.18.37 | ✅ 放行 | — |
| 2026-08-26 21:13:07 | stage | bundle 1.4.56；daemon 0.18.38 | ✅ 放行 | — |
| 2026-08-27 09:27:06 | prod | bundle 1.4.56；daemon 0.18.38 | ✅ 放行 | — |
| 2026-08-27 12:56:14 | stage | bundle 1.4.57；daemon 0.18.39 | ✅ 放行 | — |
| 2026-08-27 14:05:32 | stage | bundle 1.4.57；daemon 0.18.40 | ✅ 放行 | — |
| 2026-08-27 15:12:17 | stage | bundle 1.4.58；daemon 0.18.40 | ✅ 放行 | — |
| 2026-08-27 15:17:43 | prod | bundle 1.4.58；daemon 0.18.40 | ✅ 放行 | — |
| 2026-08-27 19:57:28 | stage | bundle 1.4.59；daemon 0.18.41 | ✅ 放行 | — |
| 2026-08-27 21:34:07 | stage | bundle 1.4.59；daemon 0.18.42 | ✅ 放行 | — |
| 2026-08-27 22:52:40 | stage | bundle 1.4.60；daemon 0.18.42 | ✅ 放行 | — |
| 2026-08-27 22:56:13 | stage | bundle 1.4.60；daemon 0.18.42 | ✅ 放行 | — |
| 2026-08-27 23:02:20 | stage | bundle 1.4.60；daemon 0.18.42 | ✅ 放行 | — |
| 2026-08-28 01:49:48 | stage | bundle 1.4.60；daemon 0.18.43 | ✅ 放行 | — |
| 2026-08-28 03:47:53 | stage | bundle 1.4.60；daemon 0.18.44 | ✅ 放行 | — |
| 2026-08-28 05:08:50 | stage | bundle 1.4.60；daemon 0.18.46 | ✅ 放行 | — |
| 2026-08-28 09:12:23 | stage | bundle 1.4.61；daemon 0.18.48 | ✅ 放行 | — |
| 2026-08-28 09:14:48 | stage | bundle 1.4.61；daemon 0.18.48 | ✅ 放行 | — |
| 2026-08-28 09:17:24 | stage | bundle 1.4.61；daemon 0.18.48 | ✅ 放行 | — |
| 2026-08-29 11:41:44 | stage | bundle 1.4.62；daemon 0.18.49 | ✅ 放行 | — |
| 2026-08-29 13:05:41 | stage | bundle 1.4.62；daemon 0.18.49 | ✅ 放行 | — |
| 2026-08-29 13:13:00 | prod | bundle 1.4.62；daemon 0.18.49 | ✅ 放行 | — |
| 2026-08-29 19:13:28 | stage | bundle 1.4.63；daemon 0.18.49 | ✅ 放行 | — |
| 2026-09-01 19:06:29 | stage | bundle 1.4.63；daemon 0.18.49；installer 1.0.5 | ✅ 放行 | — |
| 2026-09-01 23:49:20 | stage | bundle 1.4.63；daemon 0.18.49；installer 1.0.5 | ⛔ 擋下 | 每條版本線都已發佈（bundle→inkstone/arcrun-rag、daemon→inkstone/arcrun-collector、installer→inkstone/arcrun-rag） |
| 2026-09-01 23:56:41 | stage | bundle 1.4.63；daemon 0.18.49；installer 1.0.5 | ✅ 放行 | — |
| 2026-09-13 22:53:04 | stage | bundle 1.4.64；daemon 0.18.52；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-13 23:17:19 | prod | bundle 1.4.64；daemon 0.18.52；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-14 00:35:11 | stage | bundle 1.4.65；daemon 0.18.52；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-14 00:47:39 | prod | bundle 1.4.65；daemon 0.18.52；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-14 07:07:04 | stage | bundle 1.4.66；daemon 0.18.53；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-14 07:32:01 | stage | bundle 1.4.67；daemon 0.18.53；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-14 07:53:16 | prod | bundle 1.4.67；daemon 0.18.53；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-17 11:07:56 | stage | bundle 1.4.67；daemon 0.18.55；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-17 11:29:40 | stage | bundle 1.4.67；daemon 0.18.55；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-17 19:59:24 | prod | bundle 1.4.67；daemon 0.18.55；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-17 20:43:53 | stage | bundle 1.4.67；daemon 0.18.56；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-18 13:29:19 | prod | bundle 1.4.67；daemon 0.18.56；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-18 14:12:47 | stage | bundle 1.4.67；daemon 0.18.56；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-19 18:15:34 | stage | bundle 1.4.68；daemon 0.18.57；installer 1.0.10 | ✅ 放行 | — |
| 2026-09-19 21:24:57 | stage | bundle 1.4.69；daemon 0.18.57；installer 1.0.11 | ✅ 放行 | — |
| 2026-09-19 21:51:21 | prod | bundle 1.4.69；daemon 0.18.57；installer 1.0.11 | ✅ 放行 | — |
| 2026-09-19 23:35:19 | stage | bundle 1.4.70；daemon 0.18.57；installer 1.0.14 | ✅ 放行 | — |
| 2026-09-19 23:48:53 | prod | bundle 1.4.70；daemon 0.18.57；installer 1.0.14 | ✅ 放行 | — |
| 2026-09-22 10:11:53 | stage | bundle 1.4.73；daemon 0.18.59；installer 1.0.18 | ✅ 放行 | — |
| 2026-09-22 13:47:40 | stage | bundle 1.4.74；daemon 0.18.59；installer 1.0.19 | ✅ 放行 | — |
| 2026-09-22 15:53:15 | prod | bundle 1.4.74；daemon 0.18.59；installer 1.0.19 | ✅ 放行 | — |
| 2026-09-29 09:57:01 | stage | bundle 1.4.78；daemon 0.18.62；installer 1.0.34 | ✅ 放行 | — |
| 2026-09-29 14:28:08 | stage | bundle 1.4.79；daemon 0.18.63；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 20:44:02 | stage | bundle 1.4.79；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 21:51:38 | prod | bundle 1.4.79；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 23:02:26 | stage | bundle 1.4.80；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 23:35:48 | stage | bundle 1.4.80；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 23:39:51 | prod | bundle 1.4.80；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-29 23:40:50 | prod | bundle 1.4.80；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-30 12:53:23 | stage | bundle 1.4.81；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-30 12:55:44 | stage | bundle 1.4.81；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-30 21:07:49 | stage | bundle 1.4.81；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-09-30 21:42:11 | prod | bundle 1.4.81；daemon 0.18.64；installer 1.0.35 | ✅ 放行 | — |
| 2026-10-07 08:49:24 | stage | bundle 1.4.82；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 11:47:57 | prod | bundle 1.4.82；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 12:52:05 | stage | bundle 1.4.83；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 15:04:38 | stage | bundle 1.4.84；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 16:39:43 | prod | bundle 1.4.84；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 16:59:18 | prod | bundle 1.4.84；daemon 0.18.65；installer 1.0.38 | ⛔ 擋下 | 每條版本線都已發佈（bundle→youlinhsieh/arcrun-rag、daemon→youlinhsieh/arcrun-port、installer→inkstone/arcrun-rag） |
| 2026-10-07 17:04:39 | prod | bundle 1.4.84；daemon 0.18.65；installer 1.0.38 | ✅ 放行 | — |
| 2026-10-07 22:09:44 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.39 | ✅ 放行 | — |
| 2026-10-07 22:12:35 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.39 | ✅ 放行 | — |
| 2026-10-07 22:26:40 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.40 | ✅ 放行 | — |
| 2026-10-07 22:39:25 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.41 | ✅ 放行 | — |
| 2026-10-07 23:01:16 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.42 | ✅ 放行 | — |
| 2026-10-07 23:10:04 | stage | bundle 1.4.85；daemon 0.18.65；installer 1.0.43 | ✅ 放行 | — |
| 2026-10-08 00:08:50 | stage | bundle 1.4.86；daemon 0.18.65；installer 1.0.43 | ✅ 放行 | — |
| 2026-10-08 09:23:17 | stage | bundle 1.4.87；daemon 0.18.65；installer 1.0.43 | ✅ 放行 | — |
| 2026-10-08 12:28:49 | prod | bundle 1.4.87；daemon 0.18.65；installer 1.0.44 | ✅ 放行 | — |
| 2026-10-08 13:34:11 | stage | bundle 1.4.87；daemon 0.18.68；installer 1.0.44 | ✅ 放行 | — |
| 2026-10-09 15:22:51 | stage | bundle 1.4.87；daemon 0.18.69；installer 1.0.44 | ✅ 放行 | — |
| 2026-10-09 16:53:15 | stage | bundle 1.4.87；daemon 0.18.70；installer 1.0.44 | ✅ 放行 | — |
| 2026-10-09 18:26:47 | stage | bundle 1.4.88；daemon 0.18.72；installer 1.0.45 | ✅ 放行 | — |
| 2026-10-09 18:37:13 | stage | bundle 1.4.88；daemon 0.18.72；installer 1.0.46 | ✅ 放行 | — |
| 2026-10-09 18:55:02 | stage | bundle 1.4.88；daemon 0.18.73；installer 1.0.46 | ✅ 放行 | — |
| 2026-10-09 19:02:59 | stage | bundle 1.4.89；daemon 0.18.73；installer 1.0.46 | ✅ 放行 | — |
| 2026-10-09 19:54:36 | stage | bundle 1.4.89；daemon 0.18.74；installer 1.0.47 | ✅ 放行 | — |
| 2026-10-09 20:09:36 | stage | bundle 1.4.89；daemon 0.18.75；installer 1.0.47 | ✅ 放行 | — |
| 2026-10-09 20:20:25 | prod | bundle 1.4.89；daemon 0.18.75；installer 1.0.47 | ✅ 放行 | — |
| 2026-10-09 22:42:45 | stage | bundle 1.4.90；daemon 0.18.75；installer 1.0.47 | ✅ 放行 | — |
| 2026-10-09 22:44:16 | stage | bundle 1.4.90；daemon 0.18.75；installer 1.0.47 | ✅ 放行 | — |
