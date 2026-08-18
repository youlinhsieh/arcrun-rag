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

── 🔴 2026-08-18（D95 第一輪）：所有輸入都搬進 collector/ 了 ────────────
  leo 08-17：「身為管理者，你要從頭到尾**不要有很多扭曲**，因為你根本不記得
  你做的這些扭曲，**每次都要查**，很直接，源碼、產出物，從 stage 到 prod。」

  本腳本原本往 **repo 根**伸手拿三樣東西：
    ① docs-site/src/content/docs/help/changelog.md（版本與更新說明）
    ② ROOT/DAEMON_LINE（版本線）
    ③ `git ls-files collector`（原始碼指紋，從 repo 根算）
  ⇒ `collector/` 算不出自己的版本，也**沒有資格被搬成獨立 repo**。

  現在三樣全在 `collector/` 底下：`CHANGELOG.md`／`DAEMON_LINE`／指紋以 collector 為根。
  本檔一律以**自己的位置**定位（`__file__` 往上兩層＝collector/），
  **不再呼叫 `git rev-parse --show-toplevel`**——那是往上伸手的入口。
  （三道既有修補全部原樣保留：指紋演算法版本作廢重記、帳本自我參照排除、
    沒有產物的版號可重戳。只有「以什麼為根」變了。）

── 現在的做法：版本由 changelog 決定，且不用手打數字 ──────────────
  單一真相源＝ collector/CHANGELOG.md（用戶語言那份）。

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

HERE = Path(__file__).resolve().parent          # collector/cmd/arcrun-app
# 🔴 daemon 的根＝`collector/`，用**自己的位置**推出來，不問 git 也不問 repo 根。
#    這一行就是「臍帶剪掉了」的本體：往上兩層剛好是 collector/，再往上一步都不走。
COLLECTOR = HERE.parents[1]
CHANGELOG = COLLECTOR / "CHANGELOG.md"
LINE_FILE = COLLECTOR / "DAEMON_LINE"

UNRELEASED = "## 下一版（未發佈）"
# 版本 → 當時原始碼指紋。用來擋「同一個版號、不同的執行檔」。
SOURCE_LOCK = HERE / ".version-source.json"
# 🔴 2026-08-18（inkstone/arcrun-rag#88）：**最新一次戳版當下，逐檔各自的雜湊**。
#
#   為什麼要多這一份：`SOURCE_LOCK` 只記一個 16 字的總指紋 ⇒ 對不上時只講得出
#   「不一樣」，講不出「**哪個檔**不一樣」。而出貨線那道閘
#   （`installer/scripts/daemon-freshness.mjs`）被明文要求
#   「回報通過時要說得出它實際比對了什麼」——只有一個總指紋是說不出來的。
#
#   只留**最新一版**：閘唯一會問的問題是「changelog 最上面那一版的成品，
#   是不是照現在這份源碼打的」，歷史版本沒人會回頭問 ⇒ 不會無限長大（約 20KB）。
#   與 `SOURCE_LOCK` 一樣**排除在指紋之外**（自我參照，見 scan_source 的 skip）。
SOURCE_FILES = HERE / ".version-source-files.json"
# 指紋演算法版本：改算法時 +1，帳本會自動作廢重記（見 check_or_record）。
# 🔴 3 → 4（2026-08-18）：指紋的**根**從 repo 根換成 collector/，被雜湊的相對路徑
#    因此全部改變（`collector/cmd/…` → `cmd/…`）⇒ 舊帳本是「用不同單位量出來的數字」，
#    比對沒有意義。照既有設計改號讓它自動整本作廢重記，不要手改 JSON。
FINGERPRINT_ALGO = 4

# 🔴 2026-08-18（inkstone/arcrun-rag#88）：**對外號是三個數字，不帶 `v`**
#   （leo 2026-08-17「不要 v」，全文 InkStoneCo `system-dev/wiki/ops-facts.md` §「定案」）。
#
#   這裡就是那個 `v` 的產地。在此之前本檔一律吐 `v0.18.28`，而那個字串一路長到
#   使用者眼前的每一處：
#     · `build-dmg.sh` 的 `Arcrun-${VERSION}.dmg`            → 產物檔名
#     · `manifest.daemon.version`                            → 桌面小幫手「檢查更新」讀的欄位
#     · `install.arcrun.dev/api/latest` 的 `daemon.version`  → 安裝頁讀的欄位
#   ⇒ 規約寫在 wiki 上，而**產生號碼的那條路照舊帶 v**。改任何字串常數都改不掉它，
#     要改的是這支唯一的產生器。
#
#   ── 過渡怎麼走：書寫形式由 changelog 那一行決定，新戳的一律裸號 ──────────
#   紅線是「既有已發出的 tag／檔名不回頭改」。這不是潔癖，是會壞東西：
#   `selfupdate.go` 的 `newerThanCurrent()` 判斷更新用的是**字串不等於**
#   （`strings.TrimSpace(latest) != cur`，比對 `manifest.daemon.version` 與編進執行檔的字串）
#   ⇒ 若「重打同一版」時把 `v0.18.28` 改吐成 `0.18.28`，每一台已安裝的機器
#     都會看到一個**內容一模一樣、卻宣稱是新版**的更新。那是自己製造的假更新。
#
#   ⇒ 所以規則只有一條：**這一版怎麼寫，看 changelog 上那一行怎麼寫；
#     而新戳出來的那一行一律裸號。** 下一次真的升版（0.18.29）就是裸的；
#     舊的 28 一輩子維持 `v0.18.28`，兩邊都不必記得任何例外。
#     這條規則**會自己過期**：頂上那段變成裸號之後，重打路徑吐的也是裸號，
#     `v?` 只剩「讀得懂歷史」的作用。
RELEASED_RE = re.compile(r"^## (v?)(\d+)\.(\d+)\.(\d+)（", re.M)


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

    四修（2026-08-18，D95 第一輪）：
        改成**以 `collector/` 為根**列檔（cwd=COLLECTOR、pathspec `.`），
        不再從 repo 根列 `collector` 這個子目錄。涵蓋的檔案集合完全相同，
        差別只有相對路徑前綴——而路徑有進雜湊，所以 FINGERPRINT_ALGO 跟著 +1。
        這樣 collector/ 搬成獨立 repo 之後，同一段程式碼算出的仍是同一個值。
    """
    return scan_source()[0]


def scan_source():
    """走訪一次原始碼樹，同時交出「總指紋」與「逐檔雜湊」。

    🔴 **一次走訪、兩個產物**是刻意的：兩者若各走各的，就可能量到不同的檔案集合
    （例如中間有人存檔），而那種不一致查起來會像鬼故事。

    回傳 `(fingerprint, {相對路徑: sha256})`；不在 git 裡就回 `("", {})`。
    總指紋的算法**一個位元都沒動**（`h.update(rel)` + `h.update(內容)`，路徑排序），
    所以 `FINGERPRINT_ALGO` 維持 4、既有帳本繼續有效。
    """
    try:
        files = subprocess.check_output(
            ["git", "ls-files", "-co", "--exclude-standard", "."],
            cwd=COLLECTOR, text=True).split("\n")
    except subprocess.CalledProcessError:
        return "", {}  # 不在 git 裡就不擋（例如從 tarball 解出來 build）
    # 🔴 2026-08-06 三修：**帳本自己不能算進指紋**（經典的自我參照）。
    #    `.version-source.json` 就住在 collector/ 底下 ⇒ 戳版號寫入它，指紋就變
    #    ⇒ 同一輪連續打 win/mac/msix，第二支就被自己的閘擋下（實撞）。
    #    （查證過：gen-icons.py 產的 .ico 是**位元一致**的，不是它造成的；
    #      dist/ 也早就 gitignore，不在名單裡。真兇只有帳本。）
    #    只排除帳本一個檔——**不要順手把 build/ 整個排掉**，
    #    那會讓「換 app icon」不算原始碼變更，等於把閘挖個洞。
    #    2026-08-18：逐檔帳本（SOURCE_FILES）是同一個形狀的自我參照，一起排除。
    skip = {
        str(SOURCE_LOCK.relative_to(COLLECTOR)),
        str(SOURCE_FILES.relative_to(COLLECTOR)),
    }

    h = hashlib.sha256()
    per_file = {}
    for rel in sorted(f for f in files if f.strip() and f not in skip):
        fp = COLLECTOR / rel
        if not fp.is_file():
            continue  # 已刪除的檔案
        data = fp.read_bytes()
        h.update(rel.encode())
        h.update(data)
        per_file[rel] = hashlib.sha256(data).hexdigest()
    return h.hexdigest()[:16], per_file


def artifacts_for(version):
    """磁碟上有沒有這個版號的產物（exe/dmg/msix）。有＝真的出過東西，不准重戳。"""
    dist = HERE / "dist"
    if not dist.is_dir():
        return []
    return [f.name for f in dist.iterdir()
            if version in f.name and f.suffix in (".exe", ".dmg", ".msix", ".zip")]


def check_or_record(version, stamp):
    """同一個版號只准對應一份原始碼；不同就擋下並說怎麼辦。"""
    fp, per_file = scan_source()
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
    # 逐檔帳本永遠寫成「**最新一次戳版**當下的樣子」——即使總指紋沒變（重打同一版），
    # 也要覆蓋，否則它會停在更早的版本、讓 `--source-state` 講不出差異。
    if stamp:
        SOURCE_FILES.write_text(json.dumps(
            {"_algo": FINGERPRINT_ALGO, "version": version,
             "fingerprint": fp, "files": per_file},
            indent=1, ensure_ascii=False, sort_keys=False) + "\n")


def source_state():
    """**唯讀**回答一個問題：「changelog 最上面那一版的成品，是不是照現在這份源碼打的？」

    ── 為什麼這個回答要住在這裡（inkstone/arcrun-rag#88，2026-08-18）──────────
    出貨線本來自己回答這題，做法是「找出宣告那一版的 commit，看之後 `collector/`
    有沒有再被 commit」。那是**用路徑與 git 歷史當代理**，不是量事實，於是：

      · 「宣告新版本」這個動作本身就要改 `collector/CHANGELOG.md`
        （D95 第一輪搬進來的，為的是讓 collector/ 自足）
        ⇒ 只改宣告、什麼程式都沒動的 commit，也被算成「源碼又動過」⇒ **閘擋自己**。
      · 反過來，`collector/` 底下有些檔案（例如打包腳本旁的 .mjs 工具）
        根本不會進到執行檔裡，動了它們也被算成「要重打包」。

    真正該問的是**同一件事實**，而那份事實這支腳本本來就在算：
    `check_or_record()` 每次戳版都把「當下的原始碼指紋」記進帳本。
    ⇒ 版本 X 的指紋 == 現在算出來的指紋，就代表 **X 的成品確實是照這份源碼打的**。
      「宣告」那一步改到的檔案，在戳版當下就已經算進去了 ⇒ 結構上不可能擋自己。

    所以這一題**搬家**到源碼這一邊回答（遷移計畫早就寫過「該搬家不是加固」），
    出貨線只負責問與擋。輸出 JSON，欄位全部是量到的值，判斷留給問的人。
    """
    fp, per_file = scan_source()
    text = CHANGELOG.read_text() if CHANGELOG.exists() else ""
    top = RELEASED_RE.search(text)
    version = ("%s%s.%s.%s" % top.groups()) if top else None

    lock = {}
    if SOURCE_LOCK.exists():
        try:
            lock = json.loads(SOURCE_LOCK.read_text())
        except ValueError:
            lock = {}
    ledger_algo = lock.get("_algo")
    # 演算法一改，舊紀錄就是「用不同單位量出來的數字」⇒ 不當成有紀錄（同 check_or_record）。
    recorded = lock.get(version) if (version and ledger_algo == FINGERPRINT_ALGO) else None

    prev_files, files_version, files_algo = {}, None, None
    if SOURCE_FILES.exists():
        try:
            doc = json.loads(SOURCE_FILES.read_text())
            files_algo = doc.get("_algo")
            files_version = doc.get("version")
            if files_algo == FINGERPRINT_ALGO:
                prev_files = doc.get("files") or {}
        except ValueError:
            pass

    changed, added, removed = [], [], []
    comparable = bool(prev_files) and files_version == version
    if comparable:
        for rel, sha in sorted(per_file.items()):
            if rel not in prev_files:
                added.append(rel)
            elif prev_files[rel] != sha:
                changed.append(rel)
        removed = sorted(r for r in prev_files if r not in per_file)

    return {
        "algo": FINGERPRINT_ALGO,
        "collector_dir": str(COLLECTOR),
        "changelog": str(CHANGELOG),
        "version": version,
        "has_unreleased": UNRELEASED in text,
        "current_fingerprint": fp or None,
        "ledger_algo": ledger_algo,
        "recorded_fingerprint": recorded,
        "file_count": len(per_file),
        "files_ledger_version": files_version,
        "files_ledger_algo": files_algo,
        "comparable_per_file": comparable,
        "changed": changed,
        "added": added,
        "removed": removed,
        "artifacts": sorted(artifacts_for(version)) if version else [],
    }


def main():
    if "--source-state" in sys.argv:
        # 🔴 唯讀：不戳版、不寫任何檔案。出貨線的閘就是靠這條路問事實的。
        json.dump(source_state(), sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
        return
    stamp = "--stamp" in sys.argv
    if not CHANGELOG.exists():
        die("❌ 找不到 changelog：%s" % CHANGELOG)
    line = LINE_FILE.read_text().strip() if LINE_FILE.exists() else "0.18"
    if not re.fullmatch(r"\d+\.\d+", line):
        die("❌ DAEMON_LINE 必須是 MAJOR.MINOR（例 0.18），現在是 %r" % line)

    text = CHANGELOG.read_text()
    top = RELEASED_RE.search(text)
    if not top:
        die("❌ changelog 裡找不到任何 `## X.Y.Z（…）` 的版本段落（舊的 `## vX.Y.Z（…）` 也認）")
    # group(1) 是那一版**當初怎麼寫的**（'v' 或空字串）——重打同一版時要原樣沿用，
    # 否則已安裝的機器會收到一個內容相同卻宣稱是新版的假更新（見 RELEASED_RE 上方）。
    prev_prefix = top.group(1)
    prev = (int(top.group(2)), int(top.group(3)), int(top.group(4)))

    has_unreleased = UNRELEASED in text
    if has_unreleased and text.index(UNRELEASED) > top.start():
        die("❌ `%s` 必須放在所有已發佈版本的**上面**（它代表還沒出的那一版）" % UNRELEASED)

    if not has_unreleased:
        # 沒有待發佈內容＝重打同一版。冪等，不虛增。
        # 🔴 沿用那一版**當初的書寫形式**：重打 `v0.18.28` 還是叫 `v0.18.28`，
        #    產物檔名與 manifest 欄位都不變 ⇒ 已安裝的機器不會看到假更新。
        version = "%s%d.%d.%d" % ((prev_prefix,) + prev)
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
    # 🔴 **裸號就是從這一行開始的**（leo 2026-08-17「對外號就是三個數字，不要 v」）。
    #
    #   這一行往下走 `heading` 寫進 changelog、`print(version)` 餵給 build-*.sh 的
    #   `${VERSION}` ⇒ 檔名（`Arcrun-0.18.x.dmg`）與 `manifest.daemon.version`
    #   ⇒ `install.arcrun.dev/api/latest` 的 `daemon.version`。
    #   **leo 看到並質問的那個 `v`，就是從這一行長出去的**，所以也只能從這一行拿掉。
    #
    #   ── 為什麼 2026-08-18 第一次改失敗，第二次才成立 ─────────────────────
    #   第一次天真地把 `v` 拿掉，當場撞到：**那個 `v` 身兼「哪一條版本線」的判別器**。
    #   出貨線那幾道閘（daemon-in-bundle-gate／ship.mjs 的 daemon-sync／
    #   `daemon-notes.changelogRelFor()`）全靠「有沒有 v」認出「這份 changelog 是不是
    #   daemon 的」。一改裸號，它們**不報錯**，而是往下比對到更舊的 `## v0.18.29（…）`
    #   ⇒ 打包出 0.18.30 的執行檔、manifest 卻宣稱是 v0.18.29。靜默，21 站全綠。
    #
    #   第二輪（本次）先換掉判別的承載：改用 `DAEMON_LINE` 宣告的那條線比對
    #   （`^## v?0\.18\.\d+（`，見 `collector/cmd/arcrun-app/daemon-notes.mjs`
    #   的 `daemonReleasedRe`）。它同時擋掉「錯的檔」與「錯的線」，且**不依賴外觀**
    #   ⇒ 裸號與既有的帶 v 舊版都認得。判別器換好之後，這一行才拿得掉。
    #
    #   ⚠️ 「重打同一版」那條路徑**不走這裡**（見上面 `has_unreleased` 為假的分支），
    #     它沿用 `prev_prefix` ⇒ 重打 `v0.18.30` 還是叫 `v0.18.30`。
    #     那不是漏改，是必要的：`selfupdate.go` 的 `newerThanCurrent()` 用字串不等於
    #     判斷有沒有新版，重打時換寫法會讓每一台已安裝的機器看到一個**內容一模一樣、
    #     卻宣稱是新版**的假更新。⇒ 只有**真的升版**才吐裸號，而那正是這一行。
    version = "%d.%d.%d" % nxt

    if stamp:
        # 🔴 2026-08-18（inkstone/arcrun-rag#88）：**順序反過來了，這是第二個自鎖。**
        #
        #   原本是「先記指紋，再把宣告寫進 changelog」。而 changelog 就住在指紋涵蓋的
        #   那棵樹底下（D95 第一輪搬進 collector/），所以記下來的是**還沒戳版**那一刻的
        #   指紋——它描述的那棵樹，從寫完宣告的那一刻起就不存在了。
        #
        #   實撞（A/B 重現，見 daemon-version.test.mjs ⑨）：build-mac.sh 戳完版打好 dmg，
        #   同一輪接著跑 build-win.sh ⇒ 沒有草稿段 ⇒ 走「重打同一版」路徑 ⇒ 現在的指紋
        #   （含已戳版的 changelog）≠ 帳本裡那個（戳版前的）⇒ 而 dist/ 已經有 dmg
        #   ⇒ 判「版號已對應另一份原始碼」⇒ **第二個平台永遠打不出來**。
        #   而 ship.mjs 的 daemon-sync 兩個平台都要，缺一就不准出貨。
        #
        #   ⇒ 先把宣告寫下去，再記指紋。帳本從此描述的是「打包當下真正的那棵樹」，
        #     這也正是出貨線那道閘（daemon-freshness.mjs）要拿來比對的東西。
        #   安全性：這條路是**升版**，帳本裡不可能已經有這個版號 ⇒ check_or_record
        #   不會在這裡 die，不存在「changelog 已改、卻中途失敗」的半套狀態。
        #   🔴 這個病是 D95 第一輪帶進來的：v0.18.29 打包時 changelog 還在 docs-site/，
        #     不在指紋範圍內，所以當時不會發作。
        today = datetime.date.today().isoformat()
        heading = "## %s（%s）" % (version, today)
        CHANGELOG.write_text(text.replace(UNRELEASED, heading, 1))
        print("  ✅ changelog：「下一版（未發佈）」→ %s" % heading, file=sys.stderr)
        check_or_record(version, True)

    print(version)


if __name__ == "__main__":
    main()
