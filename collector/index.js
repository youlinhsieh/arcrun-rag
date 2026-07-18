const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { loadConfig } = require('./config');
const { transformFile, NotImplementedError } = require('./transform');
const { GitSync } = require('./git-sync');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function outputPathFor(config, relOutputPath) {
  return path.join(config.targetRepoDir, config.targetSubdir, relOutputPath);
}

function handleAddOrChange(config, srcPath) {
  try {
    const { relOutputPath, content, originalCopy } = transformFile(srcPath, config.watchDir);
    const outPath = outputPathFor(config, relOutputPath);
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`[collector] 寫入 ${relOutputPath}`);

    if (originalCopy) {
      const origOutPath = outputPathFor(config, originalCopy.relPath);
      ensureDir(path.dirname(origOutPath));
      fs.copyFileSync(srcPath, origOutPath);
      console.log(`[collector] 原檔複製 ${originalCopy.relPath}（LFS 追蹤需部署機器已裝 git-lfs）`);
    }
  } catch (e) {
    if (e instanceof NotImplementedError) {
      console.warn(`[collector] 跳過（待 T4）：${e.message}`);
    } else {
      console.error(`[collector] 轉檔失敗 ${srcPath}：${e.message}`);
    }
  }
}

function handleUnlink(config, srcPath) {
  const relSrc = path.relative(config.watchDir, srcPath);
  const outPath = outputPathFor(config, relSrc);
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
    console.log(`[collector] 移除 ${relSrc}（來源已刪除，deprecated 標記交給 ingest workflow）`);
  }
}

function startCollector(config, { git = new GitSync(config) } = {}) {
  ensureDir(path.join(config.targetRepoDir, config.targetSubdir));

  let pendingCount = 0;
  let debounceTimer = null;

  const flush = () => {
    if (pendingCount === 0) return;
    const n = pendingCount;
    pendingCount = 0;
    const result = git.commitAndPush(`collector: 同步 ${n} 項變更`);
    if (result.committed) {
      console.log(`[collector] 已 commit+push（${n} 項變更）`);
    }
  };

  const schedule = () => {
    pendingCount += 1;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, config.debounceMs);
  };

  const watcher = chokidar.watch(config.watchDir, {
    ignoreInitial: false, // 首次啟動＝首灌，掃過整個資料夾
    persistent: true,
  });

  watcher
    .on('add', (p) => { handleAddOrChange(config, p); schedule(); })
    .on('change', (p) => { handleAddOrChange(config, p); schedule(); })
    .on('unlink', (p) => { handleUnlink(config, p); schedule(); });

  console.log(`[collector] watch 中：${config.watchDir} → ${config.targetRepoDir}/${config.targetSubdir}`);
  return watcher;
}

if (require.main === module) {
  const config = loadConfig();
  startCollector(config);
}

module.exports = { startCollector };
