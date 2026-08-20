// 從 workflow YAML 抽出某個節點的 `code: |` 區塊，讓測試能直接跑**真的那段實作**
//（不是抄一份到測試裡——抄一份就變成回音，改壞了它照樣綠）。
//
// 這支原本住在 machine-scope.test.mjs 裡。搬出來共用是為了不要出現第三份寫法：
// takedown-scope.test.mjs 已經有一份自己的正則版，再抄一份就是三種做法各自漂移。
//
// ⚠️ 不能用「`code: |` 到下一個 `input:`」那條正則——
//    pick_stale 的 `input:` 寫在 `code:` **前面**，那條正則會一路吃到下一個節點去
//    （實撞：抽出來的字串含 YAML 註解，new Function 直接 SyntaxError）。
//    改成逐行掃：進到該節點後看到 `code: |`，就一直收 6 空格縮排（或空白）的行。
export function codeOf(yaml, node) {
  const lines = yaml.split('\n');
  let inNode = false, inCode = false;
  const out = [];
  for (const line of lines) {
    if (/^  [A-Za-z_][A-Za-z0-9_]*:\s*$/.test(line)) {
      if (inCode) break;
      inNode = line.trim() === node + ':';
      continue;
    }
    if (!inNode) continue;
    if (!inCode) { if (/^    code: \|\s*$/.test(line)) inCode = true; continue; }
    if (line.trim() === '') { out.push(''); continue; }
    if (!line.startsWith('      ')) break;
    out.push(line.slice(6));
  }
  if (!out.length) throw new Error(`抽不到 ${node} 的 code`);
  return out.join('\n');
}
