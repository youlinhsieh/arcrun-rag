//go:build !windows

package main

func ensureEmbeddedCollector() (string, error) { return "", nil }
