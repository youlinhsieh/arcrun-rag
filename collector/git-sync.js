const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// design.md §4「原檔進 LFS」：assets/originals/ 底下的常見二進位格式走 git-lfs。
// ⚠️ 這裡只寫 .gitattributes 宣告（冪等、不重複寫）——LFS 是否真的生效取決於部署機器
// 有沒有裝 git-lfs 並 `git lfs install`；雲端 sandbox 沒有 git-lfs 二進位，只能驗到
// .gitattributes 內容正確，驗不到真實 LFS smudge/clean filter，見 README「待本機驗」。
const LFS_PATTERNS = ['assets/originals/**/*.pdf', 'assets/originals/**/*.docx', 'assets/originals/**/*.pptx'];

function ensureGitAttributes(repoDir) {
  const gaPath = path.join(repoDir, '.gitattributes');
  const existing = fs.existsSync(gaPath) ? fs.readFileSync(gaPath, 'utf8') : '';
  const missing = LFS_PATTERNS.filter((p) => !existing.includes(p));
  if (missing.length === 0) return false;
  const lines = missing.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`);
  const next = existing.length && !existing.endsWith('\n') ? `${existing}\n` : existing;
  fs.writeFileSync(gaPath, next + lines.join('\n') + '\n', 'utf8');
  return true;
}

/**
 * target repo 的 git add/commit/push 封裝（design.md §4：git commit/push 觸發既有
 * Gitea push webhook → ingest workflow；本模組不打任何 ingest HTTP 端點）。
 */
class GitSync {
  constructor(config) {
    this.repoDir = config.targetRepoDir;
    this.authorName = config.gitAuthorName;
    this.authorEmail = config.gitAuthorEmail;
    ensureGitAttributes(this.repoDir);
  }

  _git(args) {
    return execFileSync('git', args, {
      cwd: this.repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
        GIT_COMMITTER_NAME: this.authorName,
        GIT_COMMITTER_EMAIL: this.authorEmail,
      },
      encoding: 'utf8',
    });
  }

  /** 一批變更合併成一次 commit + push；無變更則不 commit（冪等，避免空 commit 洗歷史）。 */
  commitAndPush(summary) {
    this._git(['add', '-A']);
    const status = this._git(['status', '--porcelain']);
    if (!status.trim()) {
      return { committed: false };
    }
    this._git(['commit', '-m', summary]);
    this._git(['push']);
    return { committed: true };
  }
}

module.exports = { GitSync };
