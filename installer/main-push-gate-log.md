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
