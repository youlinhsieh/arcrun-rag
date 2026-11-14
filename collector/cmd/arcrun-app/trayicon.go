package main

// trayicon.go — 托盤圖示的頻道標記（inkstone/arcrun-rag#135）。
//
// 為什麼在這裡畫、不另放一份美術檔：圖示本來就是 //go:embed 進來的，執行期要換成帶標記的版本只是多畫幾個像素；
// 兩份各自維護的圖會漂移，而「正式版圖＋一顆點」永遠是同一張圖。
//   - macOS 選單列圖示是「模板圖」（系統只看形狀、自己上色），換顏色分不出來，所以 Mac 用文字（trayLabel）。
//   - Windows 系統匣吃彩色圖，右下角加一顆橘色圓點。

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/png"

	"arcrun-rag/collector/channel"
)

// trayLabel 是 macOS 選單列 icon 旁的文字；正式版空字串（＝與以前完全相同）。
func trayLabel(c channel.Info) string {
	if !c.IsStage() || c.Tag == "" {
		return ""
	}
	return " " + c.Tag
}

// stageBadgeColor 是 Stage 標記的顏色（橘）。
var stageBadgeColor = color.RGBA{R: 0xF5, G: 0x7C, B: 0x00, A: 0xFF}

// badgePNG 在 PNG 的右下角畫一顆帶白邊的圓點，回傳新的 PNG。解不開就原樣回傳（寧可沒標記，也不要托盤消失）。
func badgePNG(src []byte, c color.Color) []byte {
	img, err := png.Decode(bytes.NewReader(src))
	if err != nil {
		return src
	}
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, img, b.Min, draw.Src)
	w, h := b.Dx(), b.Dy()
	r := w * 3 / 10 // 圓點半徑：約圖寬的 30%
	cx, cy := b.Min.X+w-r-1, b.Min.Y+h-r-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			d := (x-cx)*(x-cx) + (y-cy)*(y-cy)
			switch {
			case d <= r*r:
				dst.Set(x, y, c)
			case d <= (r+1)*(r+1)+r/2: // 一圈白邊，讓點在深色與淺色底上都看得見
				dst.Set(x, y, color.White)
			}
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, dst); err != nil {
		return src
	}
	return out.Bytes()
}

// icoFromPNG 把單張 PNG 包成 .ico（Vista 起 ICO 可直接內嵌 PNG）。
func icoFromPNG(p []byte) []byte {
	cfg, err := png.DecodeConfig(bytes.NewReader(p))
	if err != nil {
		return nil
	}
	dim := func(n int) byte {
		if n >= 256 {
			return 0 // 0 代表 256
		}
		return byte(n)
	}
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, [3]uint16{0, 1, 1}) // reserved, type=icon, count=1
	buf.Write([]byte{dim(cfg.Width), dim(cfg.Height), 0, 0})        // w, h, palette, reserved
	_ = binary.Write(&buf, binary.LittleEndian, [2]uint16{1, 32})   // planes, bpp
	_ = binary.Write(&buf, binary.LittleEndian, uint32(len(p)))     // data size
	_ = binary.Write(&buf, binary.LittleEndian, uint32(22))         // data offset（6＋16）
	buf.Write(p)
	return buf.Bytes()
}

// stageTrayICO 是 Windows 用的 Stage 版托盤圖（正式圖＋橘點）；做不出來回 nil（呼叫端退回正式圖）。
func stageTrayICO() []byte {
	return icoFromPNG(badgePNG(trayIcon, stageBadgeColor))
}
