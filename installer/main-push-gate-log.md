# main-push 閘執行紀錄（in-process，InkStoneCo#56）

> 每一次執行都記一行——**擋下與放行都記**。只記擋下的話分母是未知的，
> 回答不了「這道閘到底有沒有在運作」（InkStoneCo#48：36 支閘只有 2 支會記錄自己擋了什麼）。
>
> 這道閘住在 node 行程裡：出貨線的 push 是 `spawnSync('git', …)` 開的子行程，
> 殼層的 `PreToolUse:Bash` hook 看不到它（2026-08-18 就是這樣推壞了 arcrun-collector 的 main）。

| 時間 | 目的地 | 分支 | 結果 | 說明 |
|---|---|---|---|---|
| 2026-08-24 18:23:34 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-24 18:26:55 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-24 19:07:32 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-24 20:15:59 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-24 21:05:28 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-24 21:06:40 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-24 21:07:52 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-24 21:21:39 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-25 12:26:31 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-25 12:26:35 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-08-25 12:29:25 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-26 08:00:50 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-26 08:18:55 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-26 08:22:35 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-26 17:13:14 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-26 17:22:08 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-26 20:51:58 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-26 21:04:03 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-27 09:18:07 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-27 09:21:58 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-27 09:22:04 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-08-27 12:49:58 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-27 12:54:08 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-27 14:01:09 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-27 14:03:50 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-27 15:10:47 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-27 15:12:56 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-27 15:16:11 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-27 15:16:16 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-08-27 19:50:15 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-27 19:55:35 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-27 21:26:55 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-27 21:30:21 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-27 22:59:34 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-28 01:45:29 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-28 01:48:25 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-28 03:44:17 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-28 03:46:42 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-28 05:04:40 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-28 05:07:35 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-28 09:15:20 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-28 09:16:44 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-29 11:35:00 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-08-29 11:38:40 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-08-29 12:42:47 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-08-29 12:47:54 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-08-29 12:48:02 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-08-29 19:09:14 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-09-13 20:09:16 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-09-13 22:47:06 | git.uncle6.me/inkstone/arcrun-rag | ship/2026-09-13-stage-records | ✅ 放行 | 目標不是 main／master |
| 2026-09-13 22:47:16 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-09-13 23:02:20 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-13 23:06:02 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-13 23:15:57 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-13 23:16:01 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-09-14 00:29:51 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-09-14 00:34:59 | git.uncle6.me/inkstone/arcrun-rag | ship/2026-09-14-1.4.65 | ✅ 放行 | 目標不是 main／master |
| 2026-09-14 00:43:06 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-14 00:47:29 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-14 06:55:16 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-09-14 07:05:34 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/inkstone/arcrun-collector，這一趟剩 0 次） |
| 2026-09-14 07:28:03 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | preflight 已按閘（git.uncle6.me/leo/arcrun-rag-bundles-staging，這一趟剩 0 次） |
| 2026-09-14 07:31:56 | git.uncle6.me/inkstone/arcrun-rag | ship/2026-09-14-1.4.66 | ✅ 放行 | 目標不是 main／master |
| 2026-09-14 07:46:47 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-14 07:51:58 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-14 07:52:01 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-09-17 11:08:50 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 566b9f1→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-17 11:27:45 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward e4327ec→HEAD，10 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-17 19:44:32 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-17 19:46:22 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-17 19:58:03 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-17 19:58:08 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-09-17 20:40:04 | git.uncle6.me/leo/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward bb11edd→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-17 20:43:06 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward d052c33→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-18 13:27:43 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-18 13:29:04 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-18 13:29:08 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-09-18 14:09:56 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 784ab29→HEAD，80 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 17:20:16 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 909f8da→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 17:28:06 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 909f8da→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 18:03:45 | git.uncle6.me/inkstone/arcrun-collector | main | ⛔ 擋下 | 機械檢查：查不到遠端 main 的現況（ls-remote 失敗）——不知道會蓋掉什麼就不推 |
| 2026-09-19 18:10:23 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward ba58400→HEAD，13 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 18:43:06 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-19 18:46:02 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-19 18:46:05 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 0 次） |
| 2026-09-19 21:20:44 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward cb1d878→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 21:46:54 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-19 21:51:11 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-19 23:32:25 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 5e0a987→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-19 23:44:53 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-19 23:48:45 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 0 次） |
| 2026-09-20 12:44:28 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward a274969→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-20 14:05:29 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 0f0ce69→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-21 00:41:13 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward a6fa84a→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 08:29:04 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip 115892c——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-09-22 08:37:14 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 115892c 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-09-22 08:40:12 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 115892c→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 08:42:42 | git.uncle6.me/inkstone/arcrun-collector | main | ⛔ 擋下 | 機械檢查：查不到遠端 main 的現況（ls-remote 失敗）——不知道會蓋掉什麼就不推 |
| 2026-09-22 09:36:43 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4cc758b→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 10:03:55 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4cc758b→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 10:08:01 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4cc758b→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 11:25:57 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 0 次） |
| 2026-09-22 13:27:25 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：查不到遠端 main 的現況（ls-remote 失敗）——不知道會蓋掉什麼就不推 |
| 2026-09-22 13:33:34 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 178aee6→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 13:35:44 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 178aee6→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 13:44:11 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3c9e808→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-22 15:25:44 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-09-22 15:44:03 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-09-22 15:44:08 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-09-26 00:29:58 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f5a5b92→HEAD，12 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-26 20:23:15 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：這一推會刪掉遠端 main 上的 1 個檔：daemon/Arcrun-0.18.59.msix |
| 2026-09-26 20:23:40 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6464f1c→HEAD，16 個檔有變（含 1 個刪除，--allow-deletions 放行）、.gitignore 沒變短 |
| 2026-09-26 20:40:34 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4a73fe8→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 09:48:52 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2c81ea6→HEAD，21 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 09:51:36 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d133881→HEAD，0 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 09:53:49 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6e5cad2→HEAD，37 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 14:26:51 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d133881→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 14:27:51 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 398919d→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 20:36:55 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 64bfe2b→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 20:40:23 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward b322466→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 21:35:02 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-09-29 21:50:10 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-09-29 21:50:16 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-09-29 23:00:12 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 27deab5→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 23:34:11 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 61011e1→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-29 23:36:49 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-09-29 23:39:43 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-09-30 12:53:38 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 774726c→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-09-30 12:55:38 | git.uncle6.me/inkstone/arcrun-rag | ship/1.4.81-oauth-n8n | ✅ 放行 | 目標不是 main／master |
| 2026-09-30 21:05:26 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip 4b1bde2——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-09-30 21:09:03 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-09-30 21:21:13 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-07 08:47:03 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward d61f6cd→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 11:33:28 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-07 11:47:38 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-07 11:47:43 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-07 12:51:19 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 200aad2→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 15:01:56 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4f71a54→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 16:41:00 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-07 16:59:12 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-07 22:10:05 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1d33b48→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 22:24:20 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9a84c2f→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 22:26:35 | git.uncle6.me/inkstone/arcrun-rag | ship/293-stage-1.4.85 | ✅ 放行 | 目標不是 main／master |
| 2026-10-07 22:37:35 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3d5633b→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 22:39:16 | git.uncle6.me/inkstone/arcrun-rag | ship/293-stage-1.4.85 | ✅ 放行 | 目標不是 main／master |
| 2026-10-07 22:59:09 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d154fc1→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 23:01:11 | git.uncle6.me/inkstone/arcrun-rag | ship/293-stage-1.4.85 | ✅ 放行 | 目標不是 main／master |
| 2026-10-07 23:08:20 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9ad4194→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-07 23:10:00 | git.uncle6.me/inkstone/arcrun-rag | ship/293-stage-1.4.85 | ✅ 放行 | 目標不是 main／master |
| 2026-10-08 00:07:08 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 7458791→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-08 09:21:26 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ee89532→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-08 09:23:12 | git.uncle6.me/inkstone/arcrun-rag | ship/293-stage-1.4.85 | ✅ 放行 | 目標不是 main／master |
| 2026-10-08 12:24:22 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-08 12:28:40 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-08 13:27:58 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d4a91e8→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-08 13:31:23 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 51b556f→HEAD，19 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 15:15:41 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d097ced→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 15:19:28 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward a142424→HEAD，19 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 16:46:35 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 0109b18→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 16:50:58 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 5f4fa6f→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:20:15 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3f10e88→HEAD，9 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:24:37 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6004a91→HEAD，24 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:35:56 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6ec9cd8→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:48:42 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1793b8b→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:52:32 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4ef4a42→HEAD，10 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 18:59:45 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1373b81→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:02:53 | git.uncle6.me/inkstone/arcrun-rag | feat/rag-240-home-launcher | ✅ 放行 | 目標不是 main／master |
| 2026-10-09 19:18:28 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 185bccc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:21:06 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 185bccc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:24:09 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 185bccc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:31:06 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 185bccc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:48:17 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 185bccc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 19:52:08 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3147836→HEAD，12 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 20:02:19 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 8377952→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 20:06:41 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 808f2ad→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 20:11:25 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-09 20:17:15 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-09 20:17:19 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-09 22:35:05 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 82c79f3→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 22:49:18 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward aa1f141→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 22:52:20 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward aa1f141→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 22:57:05 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward acb5466→HEAD，21 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-09 23:19:45 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-09 23:24:09 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-09 23:24:12 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-10 00:19:44 | git.uncle6.me/inkstone/arcrun-rag | feat/rag-240-home-launcher | ✅ 放行 | 目標不是 main／master |
| 2026-10-10 00:33:19 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 0f781bc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 00:38:45 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9206db7→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 00:50:08 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 00:52:11 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 01:17:13 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 01:34:34 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 8ebe003→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 01:51:16 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 01:53:32 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-10 01:53:36 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-10 02:49:30 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 10:26:01 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward cea09cd→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 10:28:07 | git.uncle6.me/inkstone/arcrun-rag | feat/297-foreach-parallel-ingest | ✅ 放行 | 目標不是 main／master |
| 2026-10-10 10:43:19 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 53f5dc5→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 10:48:04 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward d0df9d2→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 11:07:57 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 11:12:04 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-10 11:12:08 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-10 11:27:21 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward a667ec3→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 11:30:09 | git.uncle6.me/inkstone/arcrun-rag | feat/297-no-block-embed | ✅ 放行 | 目標不是 main／master |
| 2026-10-10 11:38:18 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 11:41:12 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-10 12:40:26 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 74d0d0c→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 12:42:52 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1392c18→HEAD，20 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 13:01:31 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 489469e→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 13:05:01 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 7009b48→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 13:51:13 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 22739e0→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 13:55:42 | git.uncle6.me/inkstone/arcrun-rag | ship/246-stage-daemon-0.18.84 | ✅ 放行 | 目標不是 main／master |
| 2026-10-10 13:55:46 | git.uncle6.me/inkstone/arcrun-collector | main | ⛔ 擋下 | 機械檢查：這一推會刪掉遠端 main 上的 1 個檔：cmd/arcrun-app/check-quota-meter.mjs |
| 2026-10-10 13:58:11 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward d0d044e→HEAD，21 個檔有變（含 1 個刪除，--allow-deletions 放行）、.gitignore 沒變短 |
| 2026-10-10 15:04:56 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3e6ffc5→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 15:08:25 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 591e417→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 15:43:10 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c164e16→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 15:46:50 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward e3e8ef8→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 16:06:08 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 54e7674→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 16:08:41 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 54e7674→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 16:13:36 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward f402c10→HEAD，10 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 16:46:13 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 16:48:44 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 16:52:29 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-10 16:52:35 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-10 17:31:58 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：這一推會刪掉遠端 main 上的 1 個檔：daemon/Arcrun-0.18.89.msix |
| 2026-10-10 17:32:17 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：這一推會刪掉遠端 main 上的 1 個檔：daemon/Arcrun-0.18.89.msix |
| 2026-10-10 17:32:44 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ab127c2→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 17:36:09 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6a54d25→HEAD，12 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 18:24:45 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 18:43:48 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-10 18:49:40 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-10 18:49:44 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-10 19:30:24 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1d82dff→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 19:34:17 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward d7b3f0e→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 23:36:27 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 79c7195→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-10 23:39:37 | git.uncle6.me/inkstone/arcrun-rag | integrate/0.18.95-candidate | ✅ 放行 | 目標不是 main／master |
| 2026-10-11 00:45:56 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-11 00:51:41 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-11 00:51:44 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-11 11:36:47 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3c45761→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 11:41:08 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward b8632b7→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 12:30:08 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 51dea07→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 12:34:40 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward ffd80dc→HEAD，9 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 14:26:51 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-11 14:32:09 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-11 14:32:13 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-11 16:43:28 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f7e3f8a→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 16:48:19 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 223eaee→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 17:36:32 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 04d08cb→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 17:42:38 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 14d494c→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 18:34:48 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9db9393→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 18:37:54 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward c1d8af6→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:32:05 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2a95529→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:34:41 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2a95529→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:37:25 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2a95529→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:41:01 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2a95529→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:49:04 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 647c5a2→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 19:57:33 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 5666093→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 20:16:57 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 56967f4→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 20:18:29 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 56967f4→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-11 20:21:51 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward f5d9a5e→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-14 09:32:06 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward afdf3c0→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-14 09:41:55 | git.uncle6.me/inkstone/arcrun-rag | integrate/235-stage-1014 | ✅ 放行 | 目標不是 main／master |
| 2026-10-14 09:42:04 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward e6e131a→HEAD，13 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-15 09:15:23 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1768065→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-15 09:17:10 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 22af9e1→HEAD，13 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 13:36:38 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9e7d4f8→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 13:41:39 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 468665a→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 13:43:32 | git.uncle6.me/inkstone/arcrun-rag | ship/255-stage-1016 | ✅ 放行 | 目標不是 main／master |
| 2026-10-16 13:43:44 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward de59284→HEAD，9 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 14:53:26 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ec172cc→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 14:55:42 | git.uncle6.me/inkstone/arcrun-rag | ship/270-stage-1016 | ✅ 放行 | 目標不是 main／master |
| 2026-10-16 15:15:07 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2d5a9aa→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 15:16:36 | git.uncle6.me/inkstone/arcrun-rag | ship/270-stage-1016 | ✅ 放行 | 目標不是 main／master |
| 2026-10-16 15:35:13 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 27a333b→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-16 15:36:24 | git.uncle6.me/inkstone/arcrun-rag | ship/270-stage-1016 | ✅ 放行 | 目標不是 main／master |
| 2026-10-18 16:58:33 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 90937ec→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 17:03:01 | git.uncle6.me/inkstone/arcrun-rag | ship/312-stage-1018 | ✅ 放行 | 目標不是 main／master |
| 2026-10-18 17:39:55 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward da5754d→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 17:43:12 | git.uncle6.me/inkstone/arcrun-rag | ship/1018b-stage | ✅ 放行 | 目標不是 main／master |
| 2026-10-18 18:25:22 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f6a56b1→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 18:29:55 | git.uncle6.me/inkstone/arcrun-rag | ship/110-stage-1018 | ✅ 放行 | 目標不是 main／master |
| 2026-10-18 18:30:00 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6199627→HEAD，7 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 20:49:55 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 174fd89→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 21:04:45 | git.uncle6.me/inkstone/arcrun-rag | ship/111-stage-1018 | ✅ 放行 | 目標不是 main／master |
| 2026-10-18 21:04:53 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4108396→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-18 21:58:59 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-18 22:06:50 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-18 22:06:55 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-19 08:20:32 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1a85f47→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 08:27:39 | git.uncle6.me/inkstone/arcrun-rag | ship/112-stage | ✅ 放行 | 目標不是 main／master |
| 2026-10-19 08:27:44 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward e6eb3f6→HEAD，18 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 11:14:40 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-19 11:19:36 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-19 11:19:40 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-19 12:32:21 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d373fa9→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 12:38:32 | git.uncle6.me/inkstone/arcrun-rag | ship/113-stage | ✅ 放行 | 目標不是 main／master |
| 2026-10-19 12:38:35 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 542345a→HEAD，12 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 12:58:28 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 8c37e63→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 13:05:39 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 797afc3→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-19 13:40:56 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-19 13:46:26 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-19 13:46:32 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-23 13:18:57 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6921254→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-23 13:24:39 | git.uncle6.me/inkstone/arcrun-rag | integrate/235-stage-114 | ✅ 放行 | 目標不是 main／master |
| 2026-10-23 13:24:52 | git.uncle6.me/inkstone/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward a84cbc8→HEAD，8 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-23 15:42:28 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-23 16:08:20 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-23 16:08:26 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-23 21:57:01 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 584cc11→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-23 23:49:44 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 36e1062→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-24 00:46:03 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-24 00:51:12 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-24 23:22:06 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c1fced7→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-26 02:48:59 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 0d7a245→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-26 02:53:57 | gitea | arcrun-hand/325-kbdb-placement | ✅ 放行 | 目標不是 main／master |
| 2026-10-26 05:47:37 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-26 05:50:04 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-26 05:53:46 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-26 07:30:08 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-26 07:47:30 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-26 08:57:16 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward de64388→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-26 10:15:45 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-26 10:17:25 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-26 14:35:38 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward e499e6d→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-28 14:03:32 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip db11f42——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-10-28 14:15:59 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward db11f42→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-28 14:17:48 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-collector | main | ⛔ 擋下 | 機械檢查：查不到遠端 main 的現況（ls-remote 失敗）——不知道會蓋掉什麼就不推 |
| 2026-10-28 14:39:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6d097d6→HEAD，10 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-29 20:06:18 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-29 20:26:55 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-29 20:32:46 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-29 20:32:51 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-10-31 08:13:41 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward cc4d0be→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-31 08:33:45 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-31 08:35:18 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-31 11:38:11 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 74c0cd0→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-31 12:12:54 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-31 12:14:33 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-10-31 12:18:32 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward b5b2ac8→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-31 12:46:25 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 466d11b→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-10-31 14:44:51 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-10-31 14:46:29 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-01 12:53:58 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4930050→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-01 13:02:45 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6964b10→HEAD，14 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-01 05:44:13 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3dbf93e→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-01 08:20:25 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-01 08:22:06 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-01 08:22:11 | github.com/youlinhsieh/arcrun-port | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-port，這一趟剩 19 次） |
| 2026-11-01 08:55:51 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 840ffe8→HEAD，6 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-01 09:55:59 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward e7ea952→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-01 10:25:16 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-01 10:26:38 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-02 16:29:17 | git.uncle6.me/inkstone/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d8dba99→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-02 17:21:32 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-04 09:10:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 493831c→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-04 10:19:51 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-04 10:21:53 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-04 12:13:40 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 36d71a0→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-04 12:26:39 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 8b20ade→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-04 12:39:14 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward cf7bed2→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-04 13:59:09 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-04 14:00:49 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-04 15:19:27 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 21e6557→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-06 07:05:20 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c56b4d1→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-06 08:17:58 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4548f76→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-08 13:17:45 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 506e28d→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-08 14:34:23 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-08 14:35:43 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-09 01:14:48 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 08f7a42→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 01:59:36 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-09 02:02:08 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-09 02:40:01 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2ae1382→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 02:50:45 | gitea | ship-arcrun-348 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 03:32:27 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-09 03:34:09 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-09 04:43:09 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 861e96e→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 04:48:11 | gitea | ship-arcrun-349 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 04:53:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship-arcrun-349 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 04:58:48 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship-arcrun-349 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 05:04:09 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship-arcrun-349 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 05:22:40 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-09 05:23:56 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-09 06:05:04 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ab34f3e→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 06:15:07 | gitea | ship-arcrun-350 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 06:20:43 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship-arcrun-350 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 06:51:29 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip 82fa3cc——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-11-09 06:52:21 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip 82fa3cc——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-11-09 06:53:01 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 82fa3cc→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 07:03:13 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship-arcrun-353 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 06:26:30 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 01c2a69→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 10:45:53 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward b19f35b→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 11:11:56 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 4ba4eb0→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-09 11:17:41 | gitea | arcrun-hand/351-ship-1.4.140 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 11:24:01 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | arcrun-hand/351-ship-1.4.140 | ✅ 放行 | 目標不是 main／master |
| 2026-11-09 11:45:00 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-09 11:46:25 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-09 13:35:22 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-10 03:11:03 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward db18424→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 03:59:10 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9b484ba→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 04:05:11 | gitea | arcrun-hand/359-stage-1.4.144 | ✅ 放行 | 目標不是 main／master |
| 2026-11-10 04:11:12 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | arcrun-hand/359-stage-1.4.144 | ✅ 放行 | 目標不是 main／master |
| 2026-11-10 04:17:38 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | arcrun-hand/359-stage-1.4.144 | ✅ 放行 | 目標不是 main／master |
| 2026-11-10 04:20:33 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 0100b34→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 04:26:06 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | arcrun-hand/359-stage-1.4.144 | ✅ 放行 | 目標不是 main／master |
| 2026-11-10 06:23:20 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-10 06:24:37 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-10 06:47:19 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c8ad7f7→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 07:02:24 | gitea | arcrun-rag-hand/301-ship-stage | ✅ 放行 | 目標不是 main／master |
| 2026-11-10 07:18:05 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip c4bd584——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-11-10 07:21:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c4bd584→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 08:12:21 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-10 08:13:43 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-10 08:01:05 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d5e4ab5→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 08:37:14 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 34fb439→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 11:24:05 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：本機沒有遠端 main 的 tip f290f3f——這一推不是建立在遠端現況上（會蓋掉別人的 commit） |
| 2026-11-10 11:25:23 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f290f3f→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 11:26:16 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-10 11:27:39 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-10 12:11:50 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward cff481e→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-10 12:46:13 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-10 12:47:34 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-11 02:44:15 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward bfb87ea→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 03:19:27 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6f042b9→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 07:20:05 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 60286ea 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-11-11 07:20:53 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 60286ea→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 08:02:02 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-11 08:38:55 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 55ebdb1→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 08:45:53 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 491bc07→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 09:18:08 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward a1573af→HEAD，2 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 09:33:02 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 3ec3ae3 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-11-11 09:33:58 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3ec3ae3→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 09:56:59 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 3315291→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 10:20:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 703cdbb→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 10:43:02 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-11 10:44:11 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-11 10:53:44 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 9da981d→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 11:36:46 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 572cf7f 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-11-11 11:37:38 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 572cf7f→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 12:28:09 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 08ffe75→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 13:10:52 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6eb306d→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 13:55:14 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 6d80cb9 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-11-11 13:56:01 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6d80cb9→HEAD，25 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 14:03:17 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship/374-stage165 | ✅ 放行 | 目標不是 main／master |
| 2026-11-11 14:28:38 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 338f5fd→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-11 14:35:12 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship/374-stage166 | ✅ 放行 | 目標不是 main／master |
| 2026-11-12 02:34:47 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-12 02:35:58 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-12 02:37:26 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-12 02:44:09 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 6ec698c→HEAD，25 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 02:53:28 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward b9548bc→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 03:13:16 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 099c43c→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 03:18:57 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship/stage169 | ✅ 放行 | 目標不是 main／master |
| 2026-11-12 03:41:27 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：不是 fast-forward：遠端 main 的 c5f0ebd 不在 HEAD 的歷史裡（會改寫遠端歷史） |
| 2026-11-12 03:42:41 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ⛔ 擋下 | 機械檢查：查不到遠端 main 的現況（ls-remote 失敗）——不知道會蓋掉什麼就不推 |
| 2026-11-12 03:45:26 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c5f0ebd→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 04:00:42 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 7c9de27→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 04:54:32 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-12 04:55:54 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-12 04:25:23 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ff6813c→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 04:42:51 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward bd13357→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 05:56:54 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 89d7c98→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 07:14:04 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 30e332e→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 08:41:56 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-12 08:42:52 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-12 08:47:44 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-12 08:50:29 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 323fee5→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 09:19:49 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward d29df9e→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 01:10:36 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-13 01:16:30 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-12 10:58:26 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c40dc2e→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 11:24:12 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 2283e5f→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 11:42:10 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 078bf15→HEAD，5 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 12:36:15 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 7c6b367→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 21:17:00 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 512dc95→HEAD，1 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 21:26:03 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-collector | main | ✅ 放行 | 機械檢查（stage）：fast-forward 721074a→HEAD，73 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 13:40:36 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 7770879→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 14:07:14 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 1dba4db→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-12 14:37:06 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 17d794b→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 01:18:10 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward a23cad4→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 01:46:03 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward ffd2887→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 12:35:40 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward c251c12→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 13:05:58 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward e134832→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 13:23:47 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship | ✅ 放行 | 目標不是 main／master |
| 2026-11-13 14:12:31 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f750522→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-13 14:19:07 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag | ship | ✅ 放行 | 目標不是 main／master |
| 2026-11-14 01:22:12 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward 27cf492→HEAD，3 個檔有變、沒有刪檔、.gitignore 沒變短 |
| 2026-11-14 05:48:33 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-14 05:51:16 | github.com/youlinhsieh/arcrun-rag-bundles | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag-bundles，這一趟剩 19 次） |
| 2026-11-14 05:56:59 | github.com/youlinhsieh/arcrun-rag | main | ✅ 放行 | preflight 已按閘（github.com/youlinhsieh/arcrun-rag，這一趟剩 19 次） |
| 2026-11-14 07:10:01 | 51a01bfa2665bd7bc3fd080dc40cf3e1.artifacts.cloudflare.net/git/inkstoneco/arcrun-rag-bundles-staging | main | ✅ 放行 | 機械檢查（stage）：fast-forward f25fc29→HEAD，4 個檔有變、沒有刪檔、.gitignore 沒變短 |
