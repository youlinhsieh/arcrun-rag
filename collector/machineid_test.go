package collector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 第①層：抓得到就給一個**人看得懂**的名字，且形狀就是 leo 舉的那個例子。
func TestResolveMachineReadableID(t *testing.T) {
	dir := t.TempDir()
	got := ResolveMachine(dir, "")
	if !strings.Contains(got.ID, "@") {
		t.Fatalf("ID 應該是 <使用者>@<主機> 的形狀，got %q", got.ID)
	}
	if got.Label != got.ID {
		t.Fatalf("沒設 machine_label 時顯示名該等於 ID，got label=%q id=%q", got.Label, got.ID)
	}
	if !got.Minted {
		t.Fatalf("第一次呼叫應該是現鑄")
	}
	if _, err := os.Stat(filepath.Join(dir, machineFileName)); err != nil {
		t.Fatalf("身分應該落檔（否則下次重開機就變成另一台機器）：%v", err)
	}
}

// 🔴 ID 一鑄就不變：改機器名不可以讓庫裡憑空多出一台機器。
func TestResolveMachineIDIsStable(t *testing.T) {
	dir := t.TempDir()
	first := ResolveMachine(dir, "")
	second := ResolveMachine(dir, "")
	if first.ID != second.ID {
		t.Fatalf("同一台機器兩次呼叫 ID 不同：%q vs %q", first.ID, second.ID)
	}
	if second.Minted {
		t.Fatalf("第二次不該重鑄")
	}
	// 手動把檔案裡的 host 改掉（模擬使用者在 macOS 改了電腦名稱）——ID 仍不該變。
	raw, _ := os.ReadFile(filepath.Join(dir, machineFileName))
	var saved MachineIdentity
	_ = json.Unmarshal(raw, &saved)
	saved.Host = "改過的名字"
	b, _ := json.Marshal(saved)
	_ = os.WriteFile(filepath.Join(dir, machineFileName), b, 0o600)
	third := ResolveMachine(dir, "")
	if third.ID != first.ID {
		t.Fatalf("host 變了 ID 就跟著變＝那台機器的舊知識會掛到新機器底下：%q vs %q", third.ID, first.ID)
	}
}

// 第②層：使用者改成自己看得懂的稱呼，**只動顯示名**。
func TestResolveMachineLabelOverride(t *testing.T) {
	dir := t.TempDir()
	base := ResolveMachine(dir, "")
	got := ResolveMachine(dir, "教育部 Leo 的 Mac")
	if got.Label != "教育部 Leo 的 Mac" {
		t.Fatalf("machine_label 沒生效，got %q", got.Label)
	}
	if got.ID != base.ID {
		t.Fatalf("改顯示名不該動到 ID：%q vs %q", got.ID, base.ID)
	}
}

// 第③層：什麼都抓不到時，**兩台仍必須不同**。
func TestMintFallbackIsUnique(t *testing.T) {
	a := mintFallbackForTest()
	b := mintFallbackForTest()
	if a == "" || b == "" {
		t.Fatalf("後備 ID 不該是空字串（空值會讓兩台被當成同一台）")
	}
	if a == b {
		t.Fatalf("兩次後備 ID 相同＝兩台機器會被當成同一台：%q", a)
	}
	if !strings.HasPrefix(a, unknownMachinePrefix) {
		t.Fatalf("後備 ID 該看得出是「沒認出來」，got %q", a)
	}
}

func mintFallbackForTest() string { return unknownMachinePrefix + randomMachineSuffix() }

// 顯示名清洗：保留 CJK（leo 要打中文），砍掉會把 metadata_json 字串提前結束的字元。
func TestSanitizeMachinePart(t *testing.T) {
	cases := map[string]string{
		"教育部 Leo 的 Mac": "教育部 Leo 的 Mac",
		"a\"b":            "a-b",
		"a\\b":            "a-b",
		"a/b":             "a-b",
		"  Leo-MBA  ":     "Leo-MBA",
		"a\nb":            "ab",
	}
	for in, want := range cases {
		if got := sanitizeMachinePart(in); got != want {
			t.Errorf("sanitizeMachinePart(%q) = %q, want %q", in, got, want)
		}
	}
	if got := sanitizeMachinePart(strings.Repeat("長", 200)); len([]rune(got)) != 64 {
		t.Errorf("超長名字該截到 64 rune，got %d", len([]rune(got)))
	}
}

// 主機名的網路後綴不該進畫面：leo 要看的是 `Leo-MBA`，不是 `Leo-MBA.local`。
func TestShortHostnameTrimsSuffix(t *testing.T) {
	h := shortHostname()
	if strings.Contains(h, ".") {
		t.Errorf("shortHostname 應該只留第一段，got %q", h)
	}
}

// config 上的 machine_label 要能一路走到 DirectConfig.machineIdentity()（多帳號共用同一份）。
func TestDirectConfigMachineIdentity(t *testing.T) {
	dir := t.TempDir()
	cfg := &DirectConfig{Manifest: filepath.Join(dir, "manifest.json"), MachineLabel: "教育部 Leo 的 Mac"}
	got := cfg.machineIdentity()
	if got.Label != "教育部 Leo 的 Mac" {
		t.Fatalf("config 的 machine_label 沒生效，got %q", got.Label)
	}
	sub := cfg.makeAccountSubConfig(AccountConfig{Namespace: "ns", CypherURL: "https://example.invalid"})
	if sub.machineIdentity().ID != got.ID {
		t.Fatalf("每個帳號送的機器身分必須一致：%q vs %q", sub.machineIdentity().ID, got.ID)
	}
	if _, err := os.Stat(filepath.Join(dir, machineFileName)); err != nil {
		t.Fatalf("身分檔該落在 manifest 同一個目錄：%v", err)
	}
}
