package collector

import (
	"os"
	"strings"
	"testing"
)

const realXLSX = "/private/tmp/claude-501/-Users-youlinhsieh-Documents-tech-projects-InkStoneCo/92a75156-c295-4c79-bfeb-de1a20e4ed26/scratchpad/office-poc/real.xlsx"

func TestCSV_轉成Markdown表格(t *testing.T) {
	csv := "工單號,船名,金額\nWO-1001,海運三號,\"350,000\"\nWO-1002,長榮七號,\"128,500\"\n"
	got, err := ConvertToText("維修.csv", []byte(csv))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	// 標題行 + 分隔線 = Markdown 表格的辨識特徵
	if !strings.Contains(got, "| 工單號 | 船名 | 金額 |") {
		t.Errorf("應有標題行，實得:\n%s", got)
	}
	if !strings.Contains(got, "| --- |") {
		t.Errorf("應有分隔線（否則 LLM 認不出是表格），實得:\n%s", got)
	}
	// 引號包住的逗號數字不可被拆成兩欄
	if !strings.Contains(got, "350,000") {
		t.Errorf("引號內的逗號不該被當欄位分隔，實得:\n%s", got)
	}
	t.Logf("CSV 轉出:\n%s", got)
}

func TestCSV_去BOM(t *testing.T) {
	// Excel 另存 CSV 幾乎一定帶 BOM，不去掉第一個欄名會多出看不見的字元 → 標題對不上
	withBOM := append([]byte{0xEF, 0xBB, 0xBF}, []byte("欄一,欄二\n值1,值2\n")...)
	got, err := ConvertToText("a.csv", withBOM)
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	if !strings.Contains(got, "| 欄一 |") {
		t.Errorf("BOM 應被去掉，實得: %q", got[:min(60, len(got))])
	}
}

func TestCSV_欄位含直線要跳脫(t *testing.T) {
	// 儲存格內容有 | 會把 Markdown 表格欄位切錯位
	got, err := ConvertToText("a.csv", []byte("名稱,備註\n產品A,\"甲|乙\"\n"))
	if err != nil {
		t.Fatalf("不該出錯: %v", err)
	}
	if !strings.Contains(got, `甲\|乙`) {
		t.Errorf("儲存格內的 | 應被跳脫，實得:\n%s", got)
	}
}

func TestCSV_每列欄數不同不該整份失敗(t *testing.T) {
	// 手工表格常見：尾列缺欄
	got, err := ConvertToText("a.csv", []byte("A,B,C\n1,2,3\n4,5\n"))
	if err != nil {
		t.Fatalf("欄數不齊不該整份失敗: %v", err)
	}
	if !strings.Contains(got, "4") || !strings.Contains(got, "5") {
		t.Errorf("缺欄的列仍應保留內容，實得:\n%s", got)
	}
}

func TestXLSX_真Excel檔含多工作表(t *testing.T) {
	data, err := os.ReadFile(realXLSX)
	if err != nil {
		t.Skip("無真 xlsx 測資，跳過")
	}
	got, err := ConvertToText("real.xlsx", data)
	if err != nil {
		t.Fatalf("真 Excel 檔應該讀得了: %v", err)
	}
	// 第一個工作表的內容
	for _, want := range []string{"工單號", "海運三號", "主機大修", "350,000"} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少第一工作表的 %q，實得:\n%s", want, got)
		}
	}
	// 第二個工作表——只取第一頁會漏資料，企業檔案常一檔多分頁
	for _, want := range []string{"料號", "主軸承", "45,000"} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少第二工作表的 %q（多工作表沒被讀到），實得:\n%s", want, got)
		}
	}
	t.Logf("真 Excel 轉出:\n%s", got)
}

func TestXLSX_壞檔要報錯不當機(t *testing.T) {
	_, err := ConvertToText("a.xlsx", []byte("這不是 zip，是舊版 .xls 改名"))
	if err == nil {
		t.Error("壞檔應該報錯")
	}
}

func TestTable_空表格回ErrNoText(t *testing.T) {
	_, err := ConvertToText("empty.csv", []byte(""))
	if err == nil {
		t.Error("空 CSV 應回錯而不是空字串（否則會靜默送空卡給 LLM）")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func TestXLSX_要用使用者取的分頁名而非sheet1(t *testing.T) {
	data, err := os.ReadFile(realXLSX)
	if err != nil {
		t.Skip("無真 xlsx 測資")
	}
	got, _ := ConvertToText("real.xlsx", data)
	// 企業分頁名本身就是語意（「維修紀錄」「報價單」），用 sheet1 會讓 LLM 少掉脈絡
	for _, want := range []string{"## 維修紀錄", "## 報價單"} {
		if !strings.Contains(got, want) {
			t.Errorf("應使用分頁名 %q，實得:\n%s", want, got)
		}
	}
	if strings.Contains(got, "## sheet1") {
		t.Errorf("不該退回檔名 sheet1，實得:\n%s", got)
	}
}
