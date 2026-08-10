//go:build !darwin

package main

// hideDockIcon 在非 macOS 平台是 no-op（Windows 系統匣本來就不佔工作列）。
func hideDockIcon() {}
