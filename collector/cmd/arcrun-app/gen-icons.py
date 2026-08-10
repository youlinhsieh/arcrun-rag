#!/usr/bin/env python3
"""gen-icons.py — 從 build/appicon.png 產生 Windows 用的 .ico（2026-08-06）

🔴 為什麼要有這支：
    leo 08-06 封測回報「托盤及視窗 icon 是『W』，不是 CIS 的 chevron 標誌（a＞＞）」。
    真兇＝`build/windows/icon.ico` 是 `wails init` 生成後**從沒被換過的 Wails 預設圖**；
    換 CIS logo 那次只換了 `build/appicon.png`，Windows 這顆沒人動。
    而 `tray_windows.go` 又 embed 同一顆 ⇒ 視窗與托盤兩處都是 W。

    根治不是「這次手動換一顆」——是**讓它不可能再漂移**：
    icon.ico／trayicon.ico 一律由 appicon.png 現場產生，
    build-win.sh 每次都跑這支，check-cis.sh 驗「committed == 重新產生的」。

用法：
    python3 gen-icons.py            # 產生（覆寫）
    python3 gen-icons.py --check    # 只驗證，不寫檔；不一致回傳 1
"""
import hashlib
import io
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "build" / "appicon.png"
APP_ICO = HERE / "build" / "windows" / "icon.ico"
TRAY_ICO = HERE / "build" / "trayicon.ico"

# 視窗／工作列／檔案總管會用到的完整尺寸階梯。
APP_SIZES = [16, 24, 32, 48, 64, 128, 256]
# 系統匣只吃小尺寸（Windows 依 DPI 取 16 或 32）。
TRAY_SIZES = [16, 24, 32, 48]


def render(sizes):
    """把 appicon.png 縮成多尺寸，包成一顆 .ico。"""
    if not SRC.exists():
        sys.exit("❌ 找不到來源圖：%s" % SRC)
    src = Image.open(SRC).convert("RGBA")
    buf = io.BytesIO()
    # Pillow 的 ICO 儲存會自己依 sizes 產生各層。
    src.save(buf, format="ICO", sizes=[(s, s) for s in sizes])
    return buf.getvalue()


def main():
    check_only = "--check" in sys.argv
    fail = 0
    targets = ((APP_ICO, APP_SIZES, "視窗/工作列 icon"),
               (TRAY_ICO, TRAY_SIZES, "系統匣 icon"))
    for path, sizes, label in targets:
        want = render(sizes)
        have = path.read_bytes() if path.exists() else b""
        if check_only:
            if hashlib.sha256(want).digest() == hashlib.sha256(have).digest():
                print("  ✅ %s（%s）與 appicon.png 一致" % (label, path.name))
            else:
                print("  ❌ %s（%s）與 appicon.png 不一致 "
                      "⇒ 跑 `python3 gen-icons.py` 重產" % (label, path.name))
                fail = 1
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(want)
            print("  ✅ 產生 %s（%d bytes，%d 種尺寸）"
                  % (path.relative_to(HERE), len(want), len(sizes)))
    return fail


if __name__ == "__main__":
    sys.exit(main())
