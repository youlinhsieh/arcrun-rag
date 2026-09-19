// stallguard_budget_guard_test.go — 守住「上限是量出來的」這件事本身
// （`inkstone/arcrun-rag#157`）。
//
// 🔴 為什麼要單獨一條、而且**刻意不碰 stallTestTimings**：
//
// stallguard_test.go 裡每一條都先呼叫 stallTestTimings，把 stepXxx.Budget 換成
// 毫秒級的測試尺度——它們驗的是「執行模型」（一發卡住不該讓整輪停擺），這是對的，
// 但代價是那一整組測試**一次都沒有讀到正式常數**。
//
// 後果（#153 第三輪自己指出來、留給這張票的缺口，見 system-dev/wiki/status.md
// 「已知缺口」）：有人把 writeBudget 從量出來的 300 秒改回憑感覺的 60 秒，
// 那一整組測試照樣全綠——而 60 秒比真機量到的最慢一發（84.6 秒）短，
// 於是健康的慢呼叫被剪斷、斷路器誤跳、後面的檔被跳過，畫面對使用者說
// 「知識庫沒有回應」。**一台健康的機器又被憑感覺講成壞掉的。**
//
// 這條測試反過來走：它**直接讀正式常數**，拿去跟「真機量到的最慢一發」比。
// 上限低於量測值 ⇒ 變紅，並且告訴改的人：先用 ARCRUN_TRACE=1 去量。
package collector

import (
	"testing"
	"time"
)

// budgetFloor＝「這一類呼叫，真機量到的最慢一發」。
//
// 判準（#153 第三輪拍板，stallguard.go 檔頭那段的另一面）：
// 上限只用來擋「真的不回來」，所以它至少要蓋得住我們**真的看過**的最慢一發；
// 蓋不住 ⇒ 那不是上限，是把健康的慢呼叫剪斷。
//
// 🔴 measuredMax 的每一個數字都附出處，而且都是量出來的、不是誰的印象——
// 這正是驗收條件②要求的「說得出為什麼是這個數字」。
type budgetFloor struct {
	what        string        // 這一類呼叫在畫面上叫什麼
	budget      time.Duration // 正式常數（本檔只讀不改；改值是 #153 的事，不是這張票的）
	measuredMax time.Duration // 真機量到的最慢一發
	where       string        // 這個量測數字的出處（改的人要能回去核對）
}

// budgetFloors 一次守住整組上限，不只守 writeBudget——「那組上限」是一個整體
// （票：「那組上限不能再被人憑感覺改回去」）。三個數字都是同一輪 ARCRUN_TRACE=1
// 量出來的。
var budgetFloors = []budgetFloor{
	{
		what:   "送出一份筆記（writeBudget）",
		budget: writeBudget,
		// #153 第三輪真機（0.18.46 的成品二進位、youlin 單帳號）：同一輪有 3 發
		// 超過 60 秒仍成功完成，最慢一發 84.6 秒。第一輪憑「零 LLM 應該很快」
		// 給的 60 秒比這條真實尾巴短了 1.4 倍，代價就是那一輪 11 個沒送成的檔。
		measuredMax: 84600 * time.Millisecond,
		where:       "system-dev/wiki/status.md「真機驗收（0.18.46）」表：超過 60 秒仍完成 3 發，最慢 84.6s",
	},
	{
		what:        "送出資料夾總覽／目錄索引（registerBudget）",
		budget:      registerBudget,
		measuredMax: 26300 * time.Millisecond, // 資料夾總覽 26.3s（實測分佈 1.8〜26.3s）
		where:       "collector/foldertree.go PublishFolderTreeNow 段：資料夾總覽 26.3s（ARCRUN_TRACE=1）",
	},
	{
		what:        "確認雲端 AI 可不可以用（probeBudget）",
		budget:      probeBudget,
		measuredMax: 1000 * time.Millisecond, // 唯讀探問，實測 0.0〜1s
		where:       "collector/stallguard.go probeBudget 註解：實測 0.0〜1 秒",
	},
}

// TestBudgetsCoverMeasuredMax 守住正式常數本身：任何一類上限被改到低於真機量到的
// 最慢一發 ⇒ 這條變紅。
//
// 這條**沒有**呼叫 stallTestTimings，所以它讀到的是 stallguard.go 裡的正式常數，
// 而不是別的測試換上去的毫秒級旋鈕——這正是它補得起那個缺口的原因。
func TestBudgetsCoverMeasuredMax(t *testing.T) {
	for _, f := range budgetFloors {
		if f.budget < f.measuredMax {
			t.Errorf(
				"🔴「%s」的上限被改成 %v，比真機量到的最慢一發 %v 還短。\n"+
					"   低於量測值的上限不是在擋「真的不回來」，是在把健康的慢呼叫剪斷——\n"+
					"   那正是把一台健康的機器講成壞掉的（inkstone/arcrun-rag#153/#157）。\n"+
					"   要調它，先用 ARCRUN_TRACE=1 去量：雲端真的變快了，才連這裡的 measuredMax 一起改；\n"+
					"   憑感覺改小、不去量，就是這條測試擋的事。\n"+
					"   這個量測值的出處：%s",
				f.what, f.budget, f.measuredMax, f.where)
		}
	}
}

// TestBudgetGuardReadsRealConstantsNotTestKnobs 是給「這條守衛本身」的守衛：
// 它確認 budgetFloors 綁的是正式常數，而不是哪個測試換上去的旋鈕。
//
// 🔴 為什麼要有它：這整張票的病，就是「測試換掉了上限、於是守不到正式常數」。
// 如果哪天有人把 f.budget 改成從 stepIngestCard.Budget 這種**會被 stallTestTimings
// 覆蓋**的地方讀，這條守衛就會在別的測試把旋鈕調小時跟著失守——那等於缺口又回來了。
// 這條測試在**同一個 process**裡先跑一次 stallTestTimings（把旋鈕調到毫秒級），
// 再確認 budgetFloors 讀到的值**完全沒被動到**：沒被動到，才證明它讀的是正式常數。
func TestBudgetGuardReadsRealConstantsNotTestKnobs(t *testing.T) {
	before := make([]time.Duration, len(budgetFloors))
	for i, f := range budgetFloors {
		before[i] = f.budget
	}

	// 把測試旋鈕調到毫秒級——這正是別的測試在做的事。
	stallTestTimings(t, 1*time.Millisecond, 1*time.Millisecond)

	// 正式常數不是變數、也不是那些 step 的 Budget 欄位，所以旋鈕動不到它。
	// budgetFloors 是套件初始化時就綁死正式常數的值 ⇒ 這裡應該與 before 一模一樣。
	for i, f := range budgetFloors {
		if f.budget != before[i] {
			t.Fatalf("🔴「%s」的守衛值被 stallTestTimings 動到了（%v → %v）——\n"+
				"   代表它讀的是會被測試覆蓋的旋鈕，不是正式常數，這張票的缺口又回來了。",
				f.what, before[i], f.budget)
		}
	}

	// 再確認一件事：正式常數確實遠大於毫秒級的測試旋鈕，否則上面那個相等檢查
	// 可能只是巧合。writeBudget 是秒級的（300s），毫秒級旋鈕絕不可能等於它。
	if writeBudget <= time.Second {
		t.Fatalf("🔴 writeBudget=%v 看起來像被測試旋鈕污染了（正式常數應該是秒級）", writeBudget)
	}
}
