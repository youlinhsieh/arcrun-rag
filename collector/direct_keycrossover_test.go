package collector

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inkstone/arcrun-rag#240 c18055：geek 帶著 youlin 的 api_key 的設定，載入後要被修正並寫回。
func TestLoadDirectConfigHealsKeyCrossover(t *testing.T) {
	dir := t.TempDir()
	p := writeDirectConfig(t, dir, map[string]any{
		"manifest": filepath.Join(dir, "m.json"),
		"accounts": []map[string]any{
			{"instance_name": "geek", "cypher_url": "https://g.example", "namespace": "nsgeek", "api_key": "nsyoulin",
				"watch_folders": []string{dir}},
			{"instance_name": "youlin", "cypher_url": "https://y.example", "namespace": "nsyoulin", "api_key": "nsyoulin",
				"watch_folders": []string{dir}},
			{"instance_name": "custom", "cypher_url": "https://c.example", "namespace": "nsc", "api_key": "own-custom-key",
				"watch_folders": []string{dir}},
		},
	})
	c, err := LoadDirectConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.Accounts[0].APIKey != "nsgeek" {
		t.Fatalf("geek 的 api_key 應改回自己的 namespace，got %q", c.Accounts[0].APIKey)
	}
	if c.Accounts[1].APIKey != "nsyoulin" || c.Accounts[2].APIKey != "own-custom-key" {
		t.Fatalf("不該動別人：%q / %q", c.Accounts[1].APIKey, c.Accounts[2].APIKey)
	}
	b, _ := os.ReadFile(p)
	if strings.Contains(string(b), `"api_key": "nsyoulin"`) && strings.Count(string(b), "nsyoulin") > 3 {
		t.Logf("file: %s", b)
	}
	c2, err := LoadDirectConfig(p)
	if err != nil || c2.Accounts[0].APIKey != "nsgeek" {
		t.Fatalf("回寫後重載仍應是 nsgeek：%v %v", err, c2.Accounts[0].APIKey)
	}
}
