// cardloop_vs_existing_wiki_test.go — `#134`（別把自己的卡當原稿）與 `#180`（現成的卡要收）
// 在同一個路徑上要求相反答案，這一支把**分界線本身**釘住。
//
// 🔴 這不是普通的迴歸網，是一條**有爭議的分界**：兩張票的驗收條件互斥——
//
//	#134 cardloop_test.go　`system-dev/wiki/cards/arcrun-換柱.md`　　　　　　　　**不准收**
//	#180 template_not_knowledge_test.go　`system-dev/wiki/cards/arcrun-火星座標_短片劇本_v1.md`　**必須收**
//
// 同一個目錄、同一個前綴 ⇒ **靠名字分不開**。現行分界是「**模式**」：
// curated-wiki（接一個開發 repo，`cardsRelDir` 與他的 wiki 結構性重疊）擋；
// 其餘（一般資料夾／筆記庫）收。理由與出處寫在 `ingestplan.go` 的 KeepsFile。
//
// ⚠️ 這條分界是收工方的假設，**leo 還沒裁**。要改分界，連這支一起改，
// 並在 `inkstone/Arcrun#180` 留言說明改成什麼、為什麼——不要只改 code。
package collector

import "testing"

func TestKeepsFile_機器產的卡在哪一種模式下才擋(t *testing.T) {
	const machineCard = "system-dev/wiki/cards/" + MachineMark + "火星座標_短片劇本_v1.md"
	const userCard = "system-dev/wiki/cards/我自己寫的.md"
	const liveProduct = "system-dev/wiki/cards/.wiki/換柱.md"

	// ① 接開發 repo（curated-wiki）：舊版 daemon 寫在他 wiki 裡的卡不當原稿（#134）
	repo := IngestPlan{Mode: IngestCuratedWiki, WikiRelDir: "system-dev/wiki"}
	if repo.KeepsFile(machineCard) {
		t.Errorf("curated-wiki 仍該擋 %s（#134 第③環）", machineCard)
	}
	if !repo.KeepsFile(userCard) {
		t.Errorf("使用者自己寫的卡被擋了：%s", userCard)
	}

	// ② 一般資料夾／筆記庫：leo 的 youlinhsieh-test1 就是這一種，那 9 張卡要收（#180）
	for _, m := range []IngestMode{IngestAll, ""} {
		plain := IngestPlan{Mode: m}
		if !plain.KeepsFile(machineCard) {
			t.Errorf("mode=%q 沒收 %s——#180 驗收第 3 條（那 9 張卡的內容要進得了雲端）就不成立",
				string(m), machineCard)
		}
	}

	// ②之二 `arcrun-` 是人也會用的命名習慣：**卡片產物區以外的檔一律照收**。
	//    實測 leo 的 youlinhsieh-test1 根層就有三個他自己寫的（其中一個檔名裡寫著「請勿刪」），
	//    只看前綴的話它們會被排進「下架」——不是不收而已，是把雲端已經有的撤掉。
	//    （curated-wiki 只讀那份 wiki，所以根層的檔本來就不收——那是模式的範圍，
	//     不是前綴造成的；這裡分別用兩種模式各檢一格，才不會把兩件事混在一起。）
	plainAll := IngestPlan{Mode: IngestAll}
	for _, rel := range []string{
		MachineMark + "複驗用-請勿刪-20260827c.md",
		MachineMark + "1457驗收-20260827.md",
	} {
		if !plainAll.KeepsFile(rel) {
			t.Errorf("mode=all 把使用者自己命名的根層檔擋掉了：%s", rel)
		}
	}
	if !repo.KeepsFile("system-dev/wiki/" + MachineMark + "我放在wiki根的筆記.md") {
		t.Error("curated-wiki 把卡片產物區**以外**、帶前綴的檔擋掉了")
	}

	// ③ 不管哪一種模式，**這一版正在維護的產物**（住在 `.wiki/`）永遠不是原稿。
	//    這一條才是關掉「卡片的卡片」迴圈的那道閘，前綴不是。
	for _, m := range []IngestMode{IngestCuratedWiki, IngestDocsOnly, IngestAll, ""} {
		p := IngestPlan{Mode: m, WikiRelDir: "system-dev/wiki"}
		if p.KeepsFile(liveProduct) {
			t.Errorf("mode=%q 把 `.wiki/` 裡的產物當原稿收了：%s", string(m), liveProduct)
		}
	}
}
