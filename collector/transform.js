const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class NotImplementedError extends Error {}

const MARKDOWN_EXT = new Set(['.md', '.markdown']);

// design.md §4 明列的第一波轉檔格式：docx/pptx/pdf。其餘格式仍走 NotImplementedError，
// 不擴大承諾範圍（品質不承諾是 design 原話，但格式範圍先照 SDD 講定的三種）。
const MARKITDOWN_EXT = new Set(['.docx', '.pptx', '.pdf']);

/**
 * 檔案 → md 轉換（T4：Markitdown adapter）。
 * srcPath: 來源檔案絕對路徑（客戶知識資料夾內）
 * 回傳：{ relOutputPath, content, originalCopy? }
 *   - originalCopy（僅 Markitdown 轉檔路徑）：{ relPath }，供 index.js 把原檔複製進
 *     target repo 的 assets/originals/（design.md §4：「原檔進 LFS」——LFS 追蹤本身
 *     依賴部署機器裝 git-lfs 並 `git lfs track`，本模組只管把原檔放進約定路徑，
 *     不假裝在雲端 sandbox 驗過真實 LFS push，見 README「待本機驗」）。
 */
function transformFile(srcPath, watchDir) {
  const ext = path.extname(srcPath).toLowerCase();
  const relSrc = path.relative(watchDir, srcPath);

  if (MARKDOWN_EXT.has(ext)) {
    const raw = fs.readFileSync(srcPath, 'utf8');
    const content = stampSourcePath(raw, relSrc);
    return { relOutputPath: relSrc, content };
  }

  if (MARKITDOWN_EXT.has(ext)) {
    const md = convertWithMarkitdown(srcPath);
    const content = stampSourcePath(md, relSrc);
    const relOutputPath = relSrc.slice(0, -ext.length) + '.md';
    return {
      relOutputPath,
      content,
      originalCopy: { relPath: path.join('assets/originals', relSrc) },
    };
  }

  // 其餘格式（xlsx/圖片/...）— 不在 design.md §4 第一波承諾範圍，誠實丟未實作。
  throw new NotImplementedError(
    `${relSrc}：格式 ${ext} 不在第一波 Markitdown 承諾範圍（docx/pptx/pdf），本骨架先跳過`,
  );
}

/** 呼叫 markitdown CLI 轉檔（品質不承諾，design.md §4 原話）。 */
function convertWithMarkitdown(srcPath) {
  try {
    return execFileSync('markitdown', [srcPath], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e) {
    throw new Error(`markitdown 轉檔失敗（${srcPath}）：${e.message}`);
  }
}

/** md frontmatter 補 source_path（溯源用，design.md §4：「md frontmatter 記原檔路徑」）。 */
function stampSourcePath(raw, relSrc) {
  const stamp = `source_path: "${relSrc}"`;
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---', 4);
    if (end !== -1) {
      const fm = raw.slice(4, end);
      if (fm.includes('source_path:')) return raw; // 已有就不重複塞
      return `---\n${stamp}\n${fm}\n---${raw.slice(end + 4)}`;
    }
  }
  return `---\n${stamp}\n---\n\n${raw}`;
}

module.exports = { transformFile, NotImplementedError };
