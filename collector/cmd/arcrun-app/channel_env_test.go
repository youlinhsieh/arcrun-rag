package main

// channel_env_test.go — 打包腳本的頻道參數（channel-env.sh）與執行檔裡的頻道表（collector/channel）是同一組事實，
// 兩個出口不准漂開（inkstone/arcrun-rag#135）。漂開的下場：腳本打出叫 A 的 .app，裡面的程式卻自稱 B，
// 或 Stage 的 DMG 放進 dist 被當成正式版出貨。

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"arcrun-rag/collector/channel"
)

// 真的 source 那支腳本，讀它展開後的變數（不是用正則猜）。
func channelEnvFor(t *testing.T, ch string) map[string]string {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("沒有 bash")
	}
	cmd := exec.Command("bash", "-c", `source ./channel-env.sh && printf '%s\n' "APP_NAME=$APP_NAME" "BUNDLE_NAME=$BUNDLE_NAME" "DMG_VOLUME=$DMG_VOLUME" "DIST_DIR=$DIST_DIR" "CH_LDFLAGS=$CH_LDFLAGS"`)
	cmd.Env = append(os.Environ(), "CHANNEL="+ch)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("channel-env.sh（CHANNEL=%s）失敗：%v\n%s", ch, err, out)
	}
	m := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if k, v, ok := strings.Cut(l, "="); ok {
			m[k] = v
		}
	}
	return m
}

func TestChannelEnvMatchesGoTable(t *testing.T) {
	for _, name := range []string{"prod", "stage"} {
		got, want := channelEnvFor(t, name), channel.For(name)
		for k, w := range map[string]string{"APP_NAME": want.AppName, "BUNDLE_NAME": want.BundleName, "DMG_VOLUME": want.DmgVolume} {
			if got[k] != w {
				t.Errorf("%s：channel-env.sh 的 %s=%q，channel.go 是 %q", name, k, got[k], w)
			}
		}
	}
	// 注入旗標：prod 空（不改變任何行為）；stage 必須正好把 name 設成 stage。
	if v := channelEnvFor(t, "prod")["CH_LDFLAGS"]; v != "" {
		t.Errorf("正式版不准有任何額外 ldflags：%q", v)
	}
	if v := channelEnvFor(t, "stage")["CH_LDFLAGS"]; v != "-X arcrun-rag/collector/channel.name=stage" {
		t.Errorf("stage ldflags 不對：%q", v)
	}
	// 產物目錄要和出貨登錄簿一致（installer 那邊的 mjs 測試比對 ship.targets.json）。
	if d := channelEnvFor(t, "prod")["DIST_DIR"]; d != "dist" {
		t.Errorf("prod 產物目錄應為 dist：%q", d)
	}
	if d := channelEnvFor(t, "stage")["DIST_DIR"]; d != "dist-stage" {
		t.Errorf("stage 產物目錄應為 dist-stage：%q", d)
	}
}

func TestChannelEnvRejectsTypos(t *testing.T) {
	cmd := exec.Command("bash", "-c", `source ./channel-env.sh`)
	cmd.Env = append(os.Environ(), "CHANNEL=staging")
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("CHANNEL=staging 必須失敗，不能退回 prod（會讓人以為打了 stage）：%s", out)
	}
}
