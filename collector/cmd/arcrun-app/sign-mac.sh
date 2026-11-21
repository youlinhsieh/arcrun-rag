#!/usr/bin/env bash
# sign-mac.sh — Mac 小幫手的 Developer ID 簽章＋Apple 公證＋staple（inkstone/arcrun-rag#353）
#
# 目的：從官網下載、雙擊打開，Gatekeeper 不出「無法驗證開發者」；每版出貨自動如此，不用 leo 動手。
#
#   ./sign-mac.sh app  <path/to/X.app>   用 Developer ID＋hardened runtime＋timestamp 簽 .app
#   ./sign-mac.sh dmg  <path/to/X.dmg>   簽 DMG → 送 Apple 公證並等結果 → staple → 本機自驗
#   ./sign-mac.sh check <X.app|X.dmg>    只驗（spctl／stapler），不簽
#
# 素材（不進 git、不印、不進 log）住在執行這支的那台 Mac：
#   $APPLE_SECRETS_DIR（預設 ~/Documents/tech_projects/InkStoneCo/.secrets-apple）
#     devid-application.key         私鑰（PEM）
#     developerID_application.cer   Developer ID Application 憑證
#     AuthKey_<KeyID>.p8            App Store Connect Team Key（公證用）
#     apple-signing.env             只放 ID 與檔名（非機密），有的話會被 source，可覆蓋下列預設
#   可覆蓋的變數：APPLE_DEVID_IDENTITY／APPLE_NOTARY_KEY_ID／APPLE_NOTARY_ISSUER／
#                 APPLE_DEVID_KEY／APPLE_DEVID_CER／APPLE_NOTARY_P8
#
# 作法（不要求任何人手動匯入鑰匙圈）：每次執行建一個臨時 keychain，把私鑰＋憑證包成 p12 匯入，
# 跑完（含失敗）一定刪掉並還原 keychain 搜尋清單；p12 密碼是隨機值，只存在這個行程裡。
#
# 沒有素材時：
#   app → 退回 ad-hoc 簽（本機開發用，會被 Gatekeeper 擋，與改版前相同）並明講
#   dmg → 沒有 REQUIRE_NOTARIZE=1 就跳過公證並明講；REQUIRE_NOTARIZE=1（出貨線用）則直接失敗，
#         不准把沒公證的 DMG 當正式版送出去。
set -euo pipefail

MODE="${1:-}"; TARGET="${2:-}"
[ -n "$MODE" ] && [ -n "$TARGET" ] || { sed -n 2,8p "$0" >&2; exit 2; }

SECRETS_DIR="${APPLE_SECRETS_DIR:-$HOME/Documents/tech_projects/InkStoneCo/.secrets-apple}"
if [ -f "$SECRETS_DIR/apple-signing.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$SECRETS_DIR/apple-signing.env"; set +a
fi
# 預設值是 inkstone/arcrun-rag#351 c1794925380034885 公開的 ID（非機密）
IDENTITY="${APPLE_DEVID_IDENTITY:-Developer ID Application: Youlin Hsieh (5PL6D78368)}"
NOTARY_KEY_ID="${APPLE_NOTARY_KEY_ID:-64LA3HB5BL}"
NOTARY_ISSUER="${APPLE_NOTARY_ISSUER:-d8fb5249-cd7d-4411-90c6-d9d04e51f395}"
KEY_FILE="${APPLE_DEVID_KEY:-$SECRETS_DIR/devid-application.key}"
CER_FILE="${APPLE_DEVID_CER:-$SECRETS_DIR/developerID_application.cer}"
P8_FILE="${APPLE_NOTARY_P8:-$SECRETS_DIR/AuthKey_${NOTARY_KEY_ID}.p8}"

have_material() { [ -f "$KEY_FILE" ] && [ -f "$CER_FILE" ]; }

KC=""; KC_PW=""; OLD_KCS=""; WORK=""
cleanup() {
  if [ -n "$KC" ]; then
    # shellcheck disable=SC2086
    [ -n "$OLD_KCS" ] && security list-keychains -d user -s $OLD_KCS >/dev/null 2>&1 || true
    security delete-keychain "$KC" >/dev/null 2>&1 || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

setup_keychain() {
  WORK="$(mktemp -d)"
  KC="$WORK/arcrun-sign.keychain-db"
  KC_PW="$(openssl rand -hex 16)"
  local p12_pw; p12_pw="$(openssl rand -hex 16)"
  # .cer 可能是 DER 或 PEM，兩種都試
  openssl x509 -inform DER -in "$CER_FILE" -out "$WORK/cert.pem" 2>/dev/null \
    || openssl x509 -in "$CER_FILE" -out "$WORK/cert.pem"
  openssl pkcs12 -export -inkey "$KEY_FILE" -in "$WORK/cert.pem" -out "$WORK/id.p12" -passout "pass:$p12_pw" >/dev/null
  security create-keychain -p "$KC_PW" "$KC"
  security set-keychain-settings -lut 3600 "$KC"
  security unlock-keychain -p "$KC_PW" "$KC"
  OLD_KCS="$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KC" $OLD_KCS
  security import "$WORK/id.p12" -k "$KC" -P "$p12_pw" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PW" "$KC" >/dev/null
  # 中繼憑證（Apple Developer ID G2 CA）：系統沒有就補，否則 codesign 組不出信任鏈
  if ! security find-identity -v -p codesigning "$KC" | grep -qF "$IDENTITY"; then
    curl -fsSL -o "$WORK/g2.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer \
      && security import "$WORK/g2.cer" -k "$KC" >/dev/null || true
  fi
  security find-identity -v -p codesigning "$KC" | grep -qF "$IDENTITY" \
    || { echo "❌ 臨時 keychain 裡找不到可用的簽章身分：$IDENTITY（私鑰與憑證不相符、或憑證已過期／撤銷）" >&2; exit 1; }
}

sign_app() {
  local app="$1"
  if ! have_material; then
    echo "⚠️  找不到 Developer ID 素材（$SECRETS_DIR）——退回 ad-hoc 簽。這個 .app 會被 Gatekeeper 擋，只能本機開發用。" >&2
    codesign --force --deep --sign - "$app" 2>/dev/null || true
    return 0
  fi
  setup_keychain
  # 由內往外簽：先簽 bundle 內所有 Mach-O／dylib／framework，最後簽 .app 本身（不用 --deep，Apple 不建議）
  while IFS= read -r f; do
    codesign --force --options runtime --timestamp --keychain "$KC" --sign "$IDENTITY" "$f"
  done < <(find "$app/Contents" \( -name '*.dylib' -o -name '*.so' -o -perm -u+x -type f \) ! -path "$app/Contents/MacOS/*" ! -name '*.plist' 2>/dev/null | while read -r p; do file "$p" | grep -q 'Mach-O' && echo "$p"; done)
  # 🔴 主執行檔（含 `--collector` 身分的同一支）要帶 entitlements：wazero 跑 PDFium 要可執行記憶體，
  #    hardened runtime 沒這個 entitlement 會被 kernel 砍（inkstone/arcrun-rag#353 c6）。不是拿掉 runtime，是補一項。
  local ent; ent="$(cd "$(dirname "$0")" && pwd)/arcrun-app.entitlements"
  [ -f "$ent" ] || { echo "❌ 找不到 $ent" >&2; return 1; }
  for b in "$app/Contents/MacOS/"*; do
    codesign --force --options runtime --timestamp --entitlements "$ent" --keychain "$KC" --sign "$IDENTITY" "$b"
  done
  codesign --force --options runtime --timestamp --entitlements "$ent" --keychain "$KC" --sign "$IDENTITY" "$app"
  codesign -d --entitlements - "$app" 2>&1 | grep -q allow-unsigned-executable-memory \
    || { echo "❌ 簽完 entitlement 沒帶上" >&2; return 1; }
  codesign --verify --strict --deep --verbose=2 "$app"
  echo "   ✅ Developer ID 簽章完成：$app"
}

notarize_dmg() {
  local dmg="$1"
  if ! have_material || [ ! -f "$P8_FILE" ]; then
    if [ "${REQUIRE_NOTARIZE:-0}" = "1" ]; then
      echo "❌ REQUIRE_NOTARIZE=1 但缺簽章／公證素材（$SECRETS_DIR）——不准出沒公證的 DMG。" >&2; exit 1
    fi
    echo "⚠️  沒有簽章／公證素材——DMG 未簽未公證，下載後會被 Gatekeeper 擋。" >&2
    return 0
  fi
  setup_keychain
  codesign --force --timestamp --keychain "$KC" --sign "$IDENTITY" "$dmg"
  echo "   送 Apple 公證（等結果，通常數分鐘）…"
  local out; out="$(mktemp)"
  if ! xcrun notarytool submit "$dmg" --key "$P8_FILE" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait --output-format plist >"$out" 2>&1; then
    echo "❌ notarytool 失敗（輸出已隱去金鑰路徑以外的內容，如下）：" >&2; cat "$out" >&2; rm -f "$out"; exit 1
  fi
  local status sid
  status="$(/usr/libexec/PlistBuddy -c 'Print :status' "$out" 2>/dev/null || echo '?')"
  sid="$(/usr/libexec/PlistBuddy -c 'Print :id' "$out" 2>/dev/null || echo '?')"
  rm -f "$out"
  if [ "$status" != "Accepted" ]; then
    echo "❌ Apple 公證結果：$status（submission $sid）。看原因：xcrun notarytool log $sid --key … " >&2; exit 1
  fi
  echo "   ✅ 公證通過（submission $sid）"
  xcrun stapler staple "$dmg"
}

check() {
  local t="$1"
  case "$t" in
    *.dmg) spctl -a -vvv -t open --context context:primary-signature "$t" 2>&1 || true
           xcrun stapler validate "$t"
           echo "（也請以 spctl -a -vvv -t install '$t' 確認 source=Notarized Developer ID）" ;;
    *.app) codesign --verify --strict --deep --verbose=2 "$t"
           spctl -a -vvv -t exec "$t" 2>&1 || true ;;
    *) echo "❌ 只認 .app／.dmg" >&2; exit 2 ;;
  esac
}

case "$MODE" in
  app)   sign_app "$TARGET" ;;
  dmg)   notarize_dmg "$TARGET"; echo "   ✅ stapled：$TARGET" ;;
  check) check "$TARGET" ;;
  *) echo "❌ 模式只有 app／dmg／check" >&2; exit 2 ;;
esac
