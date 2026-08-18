#!/usr/bin/env bash
# check-standalone.sh — 證明 `collector/` 沒有任何「往上伸」的相依（D95 第一輪②的驗收閘）
#
# 🔴 leo 2026-08-17：「身為管理者，你要從頭到尾**不要有很多扭曲**，因為你根本不記得
#    你做的這些扭曲，**每次都要查**，很直接，源碼、產出物，從 stage 到 prod。」
#
# ── 為什麼主證明不是 grep ──────────────────────────────────────────────────
# grep 只證明「我想得到的那幾種寫法沒出現」，證明不了「真的自足」。
# 少想到一種寫法（`$(dirname $0)/../../..`、環境變數繞路、執行期才拼出來的路徑…）
# 就會拿到一個**假綠**——而假綠比紅還糟，因為它讓人停止檢查。
#
# ⇒ **② 才是判準**：把 collector/ 的檔案單獨複製到一個臨時目錄
#   （那裡**沒有** docs-site／installer／landing／repo 根的任何東西，
#     也不是原 repo 的子目錄，`git rev-parse --show-toplevel` 只會指到它自己），
#   在那裡跑真正的版本計算與打包前置閘。
#   **跑得起來＝真的自足**；有任何一條偷偷伸手到 repo 根，在那裡就會當場斷掉。
#
# ① 只是**快篩**，抓兩個「出現在可執行位置就一定是錯」的字樣，讓回歸早一步紅。
#
# ⚠️ 快篩必須避開一個假警報：collector 是**處理使用者知識庫**的程式，
#    它的原始碼與測試裡到處是 `system-dev/wiki/...` 這種字串——那是**使用者 vault 裡的路徑**，
#    不是本 repo 的目錄。拿目錄名當樣式掃會掃出上百筆雜訊，然後沒有人再看這份輸出。
#    ⇒ 快篩只認語法構造（`git rev-parse --show-toplevel`／`REPO_ROOT`），且**先剝掉註解與說明字串**。
#
# 用法：
#   bash collector/check-standalone.sh          # 全部檢查
#   KEEP=1 bash collector/check-standalone.sh   # 保留臨時目錄以便查看
set -uo pipefail
cd "$(dirname "$0")"
COLLECTOR="$(pwd)"
FAIL=0
ok(){ printf "  ✅ %s\n" "$1"; }
ng(){ printf "  ❌ %s\n" "$1"; FAIL=1; }

# 受控檔案清單（含未提交、排除 gitignore）——與 daemon-version.py 算指紋的口徑一致。
files_list() { git -C "$COLLECTOR" ls-files -co --exclude-standard . ; }

echo "━━━ ① 快篩：可執行位置不得出現往 repo 根定位的構造 ━━━"
HITS="$(files_list | python3 -c '
import io, sys, tokenize, re
from pathlib import Path

BAD = [
    (re.compile(r"rev-parse\b[^|;)]*--show-toplevel"), "git rev-parse --show-toplevel"),
    (re.compile(r"\bREPO_ROOT\b"),                     "REPO_ROOT"),
]
SELF = {"check-standalone.sh", "CHANGELOG.md"}

def strip_py(src):
    """用 tokenize 剝掉 Python 的註解與獨立字串（docstring）——說明文字裡提到不算違規。"""
    out = {}
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except Exception:
        return {i + 1: l for i, l in enumerate(src.split("\n"))}
    for t in toks:
        if t.type in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE):
            continue
        out.setdefault(t.start[0], "")
        out[t.start[0]] += t.string + " "
    return out

def strip_hash(src):
    """`#` / `//` / ` * ` 行註解剝掉（sh、js、mjs、go）。"""
    out = {}
    for i, l in enumerate(src.split("\n"), 1):
        s = l.split("#", 1)[0] if l.lstrip().startswith("#") else l
        if s.lstrip().startswith(("//", "*", "/*")):
            s = ""
        s = re.sub(r"#.*$", "", s) if l.lstrip().startswith("#") else s
        out[i] = s
    return out

for rel in (x.strip() for x in sys.stdin):
    if not rel or Path(rel).name in SELF:
        continue
    p = Path(rel)
    if not p.is_file() or p.suffix in (".png", ".ico", ".sum", ".md", ".json"):
        continue
    try:
        src = p.read_text(errors="ignore")
    except Exception:
        continue
    lines = strip_py(src) if p.suffix == ".py" else strip_hash(src)
    for n, code in lines.items():
        for rx, why in BAD:
            if rx.search(code):
                print(f"{rel}:{n}: [{why}] {code.strip()[:100]}")
')"
if [ -n "$HITS" ]; then
  ng "有往 repo 根定位的構造（下列都在可執行位置，不是註解）"
  printf '%s\n' "$HITS" | sed 's/^/       /'
else
  ok "沒有 git rev-parse --show-toplevel、沒有 \$REPO_ROOT"
fi

echo
echo "━━━ ② 行為證明：把 collector/ 單獨搬出去，看它還算不算得出自己的版本 ━━━"
TMP="$(mktemp -d)"
trap '[ "${KEEP:-}" = "1" ] || rm -rf "$TMP"' EXIT
DEST="$TMP/collector-standalone"
mkdir -p "$DEST"
# 只複製受控檔案——build 產物、node_modules、dist 一律不帶（它們本來就不該影響自足性）
N=0
while IFS= read -r f; do
  [ -f "$COLLECTOR/$f" ] || continue
  mkdir -p "$DEST/$(dirname "$f")"
  cp "$COLLECTOR/$f" "$DEST/$f"
  N=$((N+1))
done < <(files_list)
echo "  ℹ️ 臨時樹：$DEST（$N 個檔，不在原 repo 底下）"
# 這裡是全新的 git repo——`git rev-parse --show-toplevel` 只會指到 $DEST 自己，
# 任何原本靠 repo 根才拿得到的東西都會在這裡消失。
git -C "$DEST" init -q
git -C "$DEST" add -A
git -C "$DEST" -c user.email=x@y -c user.name=z commit -qm standalone

APP="$DEST/cmd/arcrun-app"
VER="$("$APP/daemon-version.py" 2>/dev/null)"
if [ -n "$VER" ]; then ok "daemon-version.py 在獨立樹裡算得出版本：$VER"
else ng "daemon-version.py 在獨立樹裡算不出版本（還有東西往上伸）：$("$APP/daemon-version.py" 2>&1 | head -2)"; fi

FP="$(cd "$APP" && python3 -c "
import importlib.util
s=importlib.util.spec_from_file_location('dv','daemon-version.py')
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
print(m.source_fingerprint())" 2>/dev/null)"
[ -n "$FP" ] && ok "原始碼指紋算得出來：$FP" || ng "原始碼指紋算不出來"

if (cd "$APP" && ./changelog-section.sh "$VER" --check >/dev/null 2>&1); then
  ok "changelog-section.sh --check 通過（三支 build 腳本靠它擋『忘了寫更新內容』）"
else
  ng "changelog-section.sh --check 失敗：$(cd "$APP" && ./changelog-section.sh "$VER" --check 2>&1 | head -2)"
fi

NOTES="$(cd "$APP" && ./changelog-section.sh "$VER" 2>/dev/null | head -1)"
[ -n "$NOTES" ] && ok "更新說明投影得出來：${NOTES:0:36}…" || ng "更新說明投影不出來（daemon-notes.mjs 還在往上找）"

echo
[ "$FAIL" = 0 ] && echo "✅ collector/ 自足：搬出去照樣算得出自己的版本號" \
                || echo "❌ collector/ 還有往上伸的相依（見上）"
exit "$FAIL"
