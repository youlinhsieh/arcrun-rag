#!/usr/bin/env python3
"""gen-stage-icon.py — 由正式版 appicon.png 產生 Stage 版 App 圖示（inkstone/arcrun-rag#135）。

為什麼用程式畫、不另放一張美術檔：兩份各自維護的圖會漂移（gen-icons.py 的前車之鑑），
「正式版圖＋右下橘色 STAGE 角標」永遠與正式版同一張底。

用法：python3 gen-stage-icon.py <輸出.png>      # 讀 build/appicon.png，寫出帶角標的版本
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SRC = HERE / "build" / "appicon.png"
ORANGE = (0xF5, 0x7C, 0x00, 0xFF)


def render():
    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    d = ImageDraw.Draw(img)
    # 右下角一條橘色斜帶＋「STAGE」字樣：縮到 Dock 的 32px 也看得出是橘色一塊。
    bw, bh = int(w * 0.62), int(h * 0.20)
    x1, y1 = w - int(w * 0.04), h - int(h * 0.05)
    x0, y0 = x1 - bw, y1 - bh
    d.rounded_rectangle([x0, y0, x1, y1], radius=bh // 2, fill=ORANGE, outline=(255, 255, 255, 255), width=max(2, w // 128))
    font = None
    for cand in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            font = ImageFont.truetype(cand, int(bh * 0.62))
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = "STAGE"
    tb = d.textbbox((0, 0), text, font=font)
    tx = x0 + (bw - (tb[2] - tb[0])) // 2 - tb[0]
    ty = y0 + (bh - (tb[3] - tb[1])) // 2 - tb[1]
    d.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
    return img


def main():
    if len(sys.argv) != 2:
        sys.exit("用法：gen-stage-icon.py <輸出.png>")
    if not SRC.exists():
        sys.exit("❌ 找不到來源圖：%s" % SRC)
    render().save(sys.argv[1], format="PNG")
    print("✅ Stage 圖示：%s" % sys.argv[1])


if __name__ == "__main__":
    main()
