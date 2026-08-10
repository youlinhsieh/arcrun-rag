#!/usr/bin/env python3
"""daemon-version.py — daemon 版本號的唯一產生器（2026-08-06 二版）

🔴 leo 08-06：「給版本號、本版更新內容、打包產品、顯示在前端，
   這一整串都應該是機械化，**不應該每次手工做**」

── 病根（實測）────────────────────────────────────────────────────
  manifest 宣告 daemon v0.18.5，線上產物拆開卻是 v0.18.4。
  原因：本 repo **一個 git tag 都沒有**，build 腳本寫的是 `git describe --tags`
  ⇒ 拿不到 v0.18.x ⇒ 版本只能靠打包時人工 `VERSION=v0.18.4 ./build-win.sh` 敲。
  人工敲 ⇒ 兩條打包線（win／mac）各敲各的 ⇒ manifest 說謊。

── 為什麼不是「數 commit 數」（一版的做法，已否決）─────────────────
  第一版用「動過 collector/ 的 commit 數」當 patch。確實不用手打，
  但**每個 commit 都變成一版**（一天 5 個 commit 就跳 5 版），
  而且每跳一版就要補一段 changelog——把機械化變成新的手工活。

── 現在的做法：版本由 changelog 決定，且不用手打數字 ──────────────
  單一真相源＝ docs-site/src/content/docs/help/changelog.md（用戶語言那份）。

    · 要出新版 ⇒ 在檔案最上面加一段標題 `## 下一版（未發佈）`，底下寫白話更新內容。
    · 打包時本腳本把它**戳成正式版號**（上一版 patch + 1）並補上今天日期。
    · 沒有「未發佈」段 ⇒ 版本＝最上面那一版（重打同一版，不會虛增）。

  ⇒ **版本號從頭到尾沒有人打過**，而且「更新內容」與「版本」天生綁在一起——
    不可能出現「版本升了但沒人知道改了什麼」，也不可能「寫了內容卻忘了升版」。
  ⇒ 不需要 git tag／Actions／輪詢（守 D20 紅線）。

  換線（0.18 → 0.19）：改 `DAEMON_LINE`，下一版就從 0.19.0 開始。

用法：
  daemon-version.py            # 印出版本（唯讀，不改檔）
  daemon-version.py --stamp    # 把「下一版（未發佈）」戳成正式版號＋日期後印出
"""
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], cwd=HERE, text=True).strip())
CHANGELOG = ROOT / "docs-site/src/content/docs/help/changelog.md"
LINE_FILE = ROOT / "DAEMON_LINE"

UNRELEASED = "## 下一版（未發佈）"
# 版本 → 當時原始碼指紋。用來擋「同一個版號、不同的執行檔」。
SOURCE_LOCK = HERE / ".version-source.json"
# 指紋演算法版本：改算法時 +1，帳本會自動作廢重記（見 check_or_record）。
FINGERPRINT_ALGO = 3
RELEASED_RE = re.compile(r"^## v(\d+)\.(\d+)\.(\d+)（", re.M)


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def source_fingerprint():
    """會被編進執行檔的原始碼指紋——直接對**工作區檔案內容**取值。

    為什麼要這道閘（2026-08-06）：
        戳完版號後又改 code、再打一次包，腳本判定「沒有未發佈段＝重打同一版」
        ⇒ 兩個內容不同的執行檔都叫 v0.18.9。
        機械產生版本號還不夠，還要保證同一個版號只對應一份原始碼。

    二修（同日，閘擋錯自己人）：
        原本算「HEAD:collector 樹雜湊 + 未提交 diff」，但那在 commit 前後
        會給出不同指紋、即使內容一模一樣——戳版號時檔案還沒提交（在 diff 裡），
        提交後樹變了、diff 空了。結果只改 wiki 也被判「版號已對應另一份原始碼」。
        改成對工作區檔案內容取值，與有沒有提交無關。
    """
    try:
        files = subprocess.check_output(
            ["git", "ls-files", "-co", "--exclude-standard", "collector"],
            cwd=ROOT, text=True).split("\n")
    except subprocess.CalledProcessError:
        return ""  # 不在 git 裡就不擋（例如從 tarball 解出來 build）
    # 🔴 2026-08-06 三修：**帳本自己不能算進指紋**（經典的自我參照）。
    #    `.version-source.json` 就住在 collector/ 底下 ⇒ 戳版號寫入它，指紋就變
    #    ⇒ 同一輪連續打 win/mac/msix，第二支就被自己的閘擋下（實撞）。
    #    （查證過：gen-icons.py 產的 .ico 是**位元一致**的，不是它造成的；
    #      dist/ 也早就 gitignore，不在名單裡。真兇只有帳本。）
    #    只排除帳本一個檔——**不要順手把 build/ 整個排掉**，
    #    那會讓「換 app icon」不算原始碼變更，等於把閘挖個洞。
    skip = {str(SOURCE_LOCK.relative_to(ROOT))}

    h = hashlib.sha256()
    for rel in sorted(f for f in files if f.strip() and f not in skip):
        fp = ROOT / rel
        if not fp.is_file():
            continue  # 已刪除的檔案
        h.update(rel.encode())
        h.update(fp.read_bytes())
    return h.hexdigest()[:16]


def artifacts_for(version):
    """磁碟上有沒有這個版號的產物（exe/dmg/msix）。有＝真的出過東西，不准重戳。"""
    dist = HERE / "dist"
    if not dist.is_dir():
        return []
    return [f.name for f in dist.iterdir()
            if version in f.name and f.suffix in (".exe", ".dmg", ".msix", ".zip")]


def check_or_record(version, stamp):
    """同一個版號只准對應一份原始碼；不同就擋下並說怎麼辦。"""
    fp = source_fingerprint()
    if not fp:
        return
    lock = json.loads(SOURCE_LOCK.read_text()) if SOURCE_LOCK.exists() else {}
    # 指紋演算法一改，舊紀錄就是「用不同單位量出來的數字」，比對沒有意義。
    # 帳本自己記演算法版本，不合就整本作廢重記——比留著誤擋自己人好。
    if lock.get("_algo") != FINGERPRINT_ALGO:
        if lock:
            print("i  指紋演算法已更新（v%s），舊紀錄作廢重記" % FINGERPRINT_ALGO,
                  file=sys.stderr)
        lock = {"_algo": FINGERPRINT_ALGO}
    known = lock.get(version)
    # 🔴 2026-08-06：打包**失敗**時版號已被戳、產物卻沒生出來 ⇒ 那個版號被白白燒掉，
    #    修完再打就被自己的閘擋下，只能去手改 JSON（爛示範，遲早有人順手改成「都放行」）。
    #    ⇒ 沒有任何產物的版號＝**從未出貨**，本來就該可以重戳。
    #    判準是「磁碟上有沒有這個版號的產物」，不是「我覺得它沒出貨」。
    if known and known != fp and not artifacts_for(version):
        print("ℹ️  %s 之前戳過但**沒有產出任何檔案**（打包失敗），視為未出貨 → 重新對應這次的原始碼"
              % version, file=sys.stderr)
        known = None
        lock.pop(version, None)
    if known and known != fp:
        die("""❌ %s 這個版號已經對應過另一份原始碼了（記錄 %s，現在 %s）。

   代表你在戳完版號之後又改了 code。再打一次會產生
   **兩個內容不同、卻都叫 %s 的執行檔** —— 那就是「版本號說謊」。

   要出新版：在 changelog 最上面加一段

     ## 下一版（未發佈）

     - （用戶語言的更新內容）

   然後重跑打包，版號會自動變成下一個。""" % (version, known, fp, version))
    if stamp and lock.get(version) != fp:
        lock[version] = fp
        SOURCE_LOCK.write_text(json.dumps(lock, indent=1, ensure_ascii=False) + "\n")


def main():
    stamp = "--stamp" in sys.argv
    if not CHANGELOG.exists():
        die("❌ 找不到 changelog：%s" % CHANGELOG)
    line = LINE_FILE.read_text().strip() if LINE_FILE.exists() else "0.18"
    if not re.fullmatch(r"\d+\.\d+", line):
        die("❌ DAEMON_LINE 必須是 MAJOR.MINOR（例 0.18），現在是 %r" % line)

    text = CHANGELOG.read_text()
    top = RELEASED_RE.search(text)
    if not top:
        die("❌ changelog 裡找不到任何 `## vX.Y.Z（…）` 的版本段落")
    prev = (int(top.group(1)), int(top.group(2)), int(top.group(3)))

    has_unreleased = UNRELEASED in text
    if has_unreleased and text.index(UNRELEASED) > top.start():
        die("❌ `%s` 必須放在所有已發佈版本的**上面**（它代表還沒出的那一版）" % UNRELEASED)

    if not has_unreleased:
        # 沒有待發佈內容＝重打同一版。冪等，不虛增。
        version = "v%d.%d.%d" % prev
        check_or_record(version, stamp)
        if stamp:
            print("  ℹ️ changelog 沒有「下一版（未發佈）」段，版本維持 %s（重打同一版）"
                  % version, file=sys.stderr)
        print(version)
        return

    # 有待發佈內容 ⇒ 升版。換線時從該線的 .0 開始。
    major, minor = (int(x) for x in line.split("."))
    if (major, minor) != (prev[0], prev[1]):
        nxt = (major, minor, 0)
    else:
        nxt = (prev[0], prev[1], prev[2] + 1)
    version = "v%d.%d.%d" % nxt

    if stamp:
        check_or_record(version, True)
        today = datetime.date.today().isoformat()
        heading = "## %s（%s）" % (version, today)
        CHANGELOG.write_text(text.replace(UNRELEASED, heading, 1))
        print("  ✅ changelog：「下一版（未發佈）」→ %s" % heading, file=sys.stderr)

    print(version)


if __name__ == "__main__":
    main()
