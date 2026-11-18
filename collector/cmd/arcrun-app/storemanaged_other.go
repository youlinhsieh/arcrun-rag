//go:build !windows

package main

// detectPackageIdentity：Mac／Linux 沒有 msix 套件身分，自我更新照舊。
func detectPackageIdentity() bool { return false }
