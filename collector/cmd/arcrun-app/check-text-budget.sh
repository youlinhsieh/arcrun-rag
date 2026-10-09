#!/usr/bin/env bash
# check-text-budget.sh — 打包閘：畫面字數預算（inkstone/arcrun-rag#240 c18306）
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
