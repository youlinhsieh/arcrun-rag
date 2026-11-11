package main

import "testing"

// #330：同意通報後要看得到票號。回應可能是乾淨的小包、巢狀信封、被切在半途的長回應。
func TestFeedbackTicketRef(t *testing.T) {
	cases := map[string]string{
		`{"success":true,"data":{"success":true,"repo":"inkstone/arcrun-rag","number":512,"url":"u"}}`: "inkstone/arcrun-rag#512",
		`{"success":true,"data":{"data":{"repo":"inkstone/arcrun-rag","number":7,"merged":true}}}`:     "inkstone/arcrun-rag#7",
		`{"success":true,"data":{"success":true,"number":9}}`:                                          "inkstone/arcrun-rag#9", // 沒帶 repo＝收件端預設
		`{"trace":[{"x":1}],"data":{"repo":"inkstone/ISEP","number":3` + `,"url":"…"`:                  "inkstone/ISEP#3",       // 被切在半途
		`{"success":true,"data":{"success":true}}`:                                                     "",
		`not json`: "",
		`{"success":true,"data":{"text":"我寫了 \"number\": 5 這種字","repo":"x/y","number":11}}`: "x/y#11",
	}
	for in, want := range cases {
		if got := feedbackTicketRef([]byte(in)); got != want {
			t.Errorf("%s\n got %q want %q", in, got, want)
		}
	}
}
