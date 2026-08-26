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
