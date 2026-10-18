#!/usr/bin/env bash
# check-text-budget.sh — 打包閘：畫面字數預算（inkstone/arcrun-rag#240 c18306）＋元素 BOM（#261）
# 1) Go：GetState 回給前端的字串在預算內（go test，textbudget_test.go）
# 2) 瀏覽器：真 GetState 輸出掛在建好的前端上，逛過每一頁量「看得到的字」（check-text-budget.mjs）
# 預算數值只有一份：repo 根的 schemas/text-budget.json（安裝器的檢查也讀它）。
set -euo pipefail
cd "$(dirname "$0")"
go test -run 'TextBudget|GetStateStrings' . >/dev/null
(cd frontend && npm run build >/dev/null)
OUT="$(mktemp -t arcrun-state.XXXXXX)"
trap 'rm -f "$OUT"' EXIT
ARCRUN_DUMP_STATE="$OUT" go test -run TestDumpStateManual . >/dev/null
node check-text-budget.mjs "$OUT"
# 用量分頁（#246）：同一份 GetState 輸出，真瀏覽器逛一次
node check-usage.mjs "$OUT"
# 元素 BOM（#261）：每個元素都要登記它回答用戶哪一個問題，同一個意義不准多個元素講；先自我驗證判準真的會擋
node check-element-bom.mjs "$OUT" --selftest
node check-element-bom.mjs "$OUT"
