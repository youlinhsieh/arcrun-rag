#!/usr/bin/env python3
"""重新產生 Microsoft Store（msix）的圖示素材。

素材真身＝leo 的 CIS（`InkStoneCo/arcrun-cis/`），本腳本只做「等比縮 + 置中合成」。

守 CIS 的 Don't：**不拉扁、不歪斜、不加第二個顏色**。
- 方形磚 → 用方形 icon（`arcrun-icon-ink-1024.png`）等比縮。
- 寬磚 310×150 → 用**橫式 lockup**（`arcrun-lockup-h-paper-on-ink.png`）置中於墨底。
  不能拿方形 icon 硬拉成 310×150——舊版 `sips -z 150 310` 就是這樣把方形字符拉扁的。
- targetsize-16/24（工作列小圖）→ CIS 規定 26px 以下降級成 chevron，
  完整字符在這尺寸只剩約 4px 高，會糊掉。

用法（需要 Pillow）：
    python3 gen-store-assets.py
產物寫回本目錄、隨 repo 版控；`build-msix.sh` 只負責 cp 進包裡。
"""
import os
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
# CIS 住在 InkStoneCo 頂層。預設往上找，找不到時用 ARCRUN_CIS 指過去。
CIS = Path(os.environ["ARCRUN_CIS"]) if os.environ.get("ARCRUN_CIS") else None
if CIS is None:
    for parent in HERE.parents:
        cand = parent / "arcrun-cis"
        if cand.is_dir():
            CIS = cand
            break

INK = (23, 24, 26, 255)
PAPER = (253, 252, 251, 255)


def load(name: str) -> Image.Image:
    if CIS is None or not (CIS / name).exists():
        raise SystemExit(
            f"❌ 找不到 CIS 素材 {name}（找過 {CIS}）\n"
            f"   指過去：ARCRUN_CIS=/path/to/arcrun-cis python3 {Path(__file__).name}")
    return Image.open(CIS / name).convert("RGBA")


def chevron_on_ink(size: int, inset: float = 0.20) -> Image.Image:
    """雙 chevron（paper）置中於墨底——給 26px 以下的小尺寸用。

    幾何與 CIS `chevron-double.svg` 同一組座標（24-grid、stroke 2.8）。
    先超取樣畫再縮，邊緣才不會鋸齒。
    """
    ss = size * 16
    unit = ss / 24.0
    layer = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = max(1, round(2.8 * unit))
    for dx in (0, 7):
        d.line([((5 + dx) * unit, 5 * unit),
                ((12 + dx) * unit, 12 * unit),
                ((5 + dx) * unit, 19 * unit)],
               fill=PAPER, width=w, joint="curve")

    art = layer.crop(layer.split()[3].getbbox())
    target = ss * (1 - 2 * inset)
    scale = target / max(art.size)
    nw, nh = max(1, round(art.size[0] * scale)), max(1, round(art.size[1] * scale))
    art = art.resize((nw, nh), Image.LANCZOS)

    out = Image.new("RGBA", (ss, ss), INK)
    out.paste(art, ((ss - nw) // 2, (ss - nh) // 2), art)
    return out.resize((size, size), Image.LANCZOS)


def wide_tile(w: int, h: int, pad_ratio: float = 0.14) -> Image.Image:
    """寬磚：橫式 lockup 等比 fit 進墨底，四周留白（CIS clear space）。"""
    lock = load("arcrun-lockup-h-paper-on-ink.png")
    canvas = Image.new("RGBA", (w, h), INK)
    lw, lh = lock.size
    scale = min(w * (1 - 2 * pad_ratio) / lw, h * (1 - 2 * pad_ratio) / lh)
    nw, nh = max(1, round(lw * scale)), max(1, round(lh * scale))
    art = lock.resize((nw, nh), Image.LANCZOS)
    canvas.paste(art, ((w - nw) // 2, (h - nh) // 2), art)
    return canvas


def main() -> None:
    square = load("arcrun-icon-ink-1024.png")
    made = []

    for name, s in [("Square44x44Logo", 44), ("StoreLogo", 50),
                    ("Square71x71Logo", 71), ("Square150x150Logo", 150),
                    ("Square310x310Logo", 310)]:
        square.resize((s, s), Image.LANCZOS).save(HERE / f"{name}.png")
        made.append((f"{name}.png", s, s))

    # 工作列 / 開始功能表多尺寸：26px 以下用 chevron（CIS 規定），其餘用方形 icon
    for s in (16, 24, 32, 48, 256):
        img = chevron_on_ink(s) if s <= 26 else square.resize((s, s), Image.LANCZOS)
        img.save(HERE / f"Square44x44Logo.targetsize-{s}.png")
        made.append((f"Square44x44Logo.targetsize-{s}.png", s, s))

    wide_tile(310, 150).save(HERE / "Wide310x150Logo.png")
    made.append(("Wide310x150Logo.png", 310, 150))

    for n, w, h in made:
        print(f"✅ {n}: {w}x{h}")


if __name__ == "__main__":
    main()
