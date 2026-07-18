function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`collector: 缺少環境變數 ${name}（見 README.md 設定表）`);
  }
  return v;
}

function loadConfig() {
  return {
    watchDir: requireEnv('WATCH_DIR'),
    targetRepoDir: requireEnv('TARGET_REPO_DIR'),
    targetSubdir: process.env.TARGET_SUBDIR || 'collected/',
    debounceMs: parseInt(process.env.DEBOUNCE_MS || '3000', 10),
    gitAuthorName: process.env.GIT_AUTHOR_NAME || 'collector',
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'collector@localhost',
  };
}

module.exports = { loadConfig, requireEnv };
