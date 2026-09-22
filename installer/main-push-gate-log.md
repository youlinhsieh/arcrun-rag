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
