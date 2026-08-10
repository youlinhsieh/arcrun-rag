// Command collector 是 collector 的獨立命令列執行檔。
//
// 真正的邏輯全在 arcrun-rag/collector 套件裡（Run）。這支只是薄薄的外殼，
// 讓「單獨跑 collector」這條路（開發、除錯、伺服器端批次）繼續可用；
// 桌面 App 則直接呼叫同一個 Run——**兩者共用同一份程式碼，不是兩份**。
package main

import (
	"os"

	collector "arcrun-rag/collector"
)

func main() { os.Exit(collector.Run(os.Args[1:])) }
