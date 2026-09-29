// inkstone/arcrun-rag#13 c15011：模擬 Arcrun `code` 零件沙箱的真實信封語意
// （registry/components/code/sandbox.mjs 的 `runCode`），給本機測試用。
//
// 🔴 為什麼需要這支檔案（不是為了完整而加，是這次真的被咬過）：
// c14992／c15011 這兩輪都先寫了「拒收就 `return {success:false,...}`」，本機
// 測試也都直接呼叫 `new Function('input', code)` 拿返回值檢查 `.success`——
// **兩次都顯示通過，兩次都在 stage 撞到「下游照跑」**。真因是 QuickJS 沙箱的
// 真實行為是「user code 正常 return 的值一律包成
// `{success:true, data:<返回值>}`」，只有 **throw** 才會讓沙箱回
// `{success:false, error, error_type:'UserCodeError'}`（見
// inkstone/Arcrun `registry/components/code/sandbox.mjs` 第 189/207 行）。
// 直接呼叫返回值檢查 `.success` 測的是「這支函式回了什麼」，不是「graph
// 執行器的 isFailure() 會看到什麼」——這兩件事在 `return {success:false}`
// 的情況下是**不同**的，而本機測試如果不模擬這層信封包裝，就永遠測不出這個
// 落差，跟 stage 撞到的現象完全一樣：本機測試過、stage 還是錯。
//
// 用法：simulateCodeNode(code, input) 回傳跟真實 `code` 零件 HTTP 回應同形狀
// 的信封：{success:true, data:<返回值>}（正常 return）或
// {success:false, error:<訊息>, error_type:'UserCodeError'}（throw）。
// 測試斷言一律對著這個信封的**頂層** `.success`，不要直接呼叫函式看內部
// return 值的 `.success`（那樣又會重蹈這兩輪的覆轍）。
function simulateCodeNode(code, input) {
  try {
    const fn = new Function('input', code + '\n');
    const value = fn(input);
    // QuickJS 沙箱的返回值會經過 JSON.stringify/JSON.parse 一次（見
    // sandbox.mjs `JSON.stringify(__out)` → host 再 `JSON.parse(outJson)`），
    // `undefined` 欄位、函式等非 JSON-able 的東西在真實環境會被丟掉——
    // 這裡用同一招讓模擬更貼近真實信封的形狀。
    const data = value === undefined ? null : JSON.parse(JSON.stringify(value));
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e), error_type: 'UserCodeError' };
  }
}

module.exports = { simulateCodeNode };
