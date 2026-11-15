#!/usr/bin/env bash
# 把「映像檔＋知識庫快照＋安裝腳本＋說明」組成一個可以整包帶去客戶現場的資料夾（inkstone/arcrun-rag#339）。
#   build-package.sh --version 1.4.204-onprem.1 --image arcrun-private-cloud:1.4.204-onprem.1 \
#                    --snapshot <onprem-migrate-kb.sh export 的輸出資料夾> --readme <現場說明.md> --out <輸出根目錄>
# 結果：<out>/<version>/{install.sh,README.md,images/,kb/,SHA256SUMS}；SHA256SUMS 涵蓋全部檔案，現場 install.sh check 會驗。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=""; IMAGE=""; SNAP=""; README=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2;; --image) IMAGE="$2"; shift 2;; --snapshot) SNAP="$2"; shift 2;;
    --readme) README="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) echo "不認得的參數 $1" >&2; exit 2;;
  esac
done
[ -n "$VERSION" ] && [ -n "$IMAGE" ] && [ -n "$SNAP" ] && [ -n "$README" ] && [ -n "$OUT" ] || { sed -n '2,6p' "$0"; exit 2; }
for f in kbdb.sqlite vectors.sqlite MANIFEST.json; do [ -f "$SNAP/$f" ] || { echo "快照缺 $f" >&2; exit 2; }; done
P="$OUT/$VERSION"; rm -rf "$P"; mkdir -p "$P/images" "$P/kb"
echo "▶ 存映像檔（docker save | gzip）"
docker save "$IMAGE" | gzip -6 > "$P/images/arcrun-private-cloud-$VERSION.tar.gz"
echo "▶ 複製快照（只放執行需要的三個檔）"
cp "$SNAP/kbdb.sqlite" "$SNAP/vectors.sqlite" "$SNAP/MANIFEST.json" "$P/kb/"
cp "$HERE/install.sh" "$P/install.sh"; chmod +x "$P/install.sh"
cp "$README" "$P/README.md"
echo "▶ 算 SHA256SUMS"
(cd "$P" && find . -type f ! -name SHA256SUMS | sort | sed 's|^\./||' | xargs sha256sum > SHA256SUMS)
echo "✓ $P"; du -sh "$P"
