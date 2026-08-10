//go:build windows

package main

import (
	"crypto/sha256"
	_ "embed"
	"os"
	"path/filepath"
)

//go:embed arcrun-collector.exe
var collectorExeBytes []byte

// ensureEmbeddedCollector 把內嵌的 collector.exe 解壓到 ~/.arcrun-rag/bin/。
// 用 sha256 比對避免每次啟動都重寫磁碟；回傳可執行的絕對路徑。
// t77-lite（leo 2026-07-28：「Windows 解開有 2 個 exe 被瀏覽器擋住；如果只有 1 個，
// 我還可以把 exe 改成 e_e 讓朋友改回來」）
func ensureEmbeddedCollector() (string, error) {
	dest := filepath.Join(appDir(), "bin", "arcrun-collector.exe")
	embedded := sha256.Sum256(collectorExeBytes)
	if existing, err := os.ReadFile(dest); err == nil {
		if sha256.Sum256(existing) == embedded {
			return dest, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(dest, collectorExeBytes, 0o755); err != nil {
		return "", err
	}
	return dest, nil
}
