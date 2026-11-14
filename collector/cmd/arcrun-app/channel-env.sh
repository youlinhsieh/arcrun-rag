#!/usr/bin/env bash
# channel-env.sh — 打包腳本共用：把 `CHANNEL=stage|prod` 展開成這一次打包要用的「身分」
# （inkstone/arcrun-rag#135，leo 2026-11-12）。被 build-mac.sh／build-dmg.sh／build-win.sh `source`。
#
#   CHANNEL=stage ./build-dmg.sh   → dist-stage/Arcrun-<版>.dmg（裡面是 Arcrun Stage.app，bundle id com.wails.arcrun-app-stage）
#   ./build-dmg.sh                 → dist/Arcrun-<版>.dmg（今天的 Arcrun，一個位元都不變）
#
# 🔴 這裡的值與 `collector/channel/channel.go` 那張表是**同一組事實的兩個出口**
# （一個給打包腳本、一個給執行檔）。channel_env_test.go 會逐項比對，漂開就擋。
# 不准在別處再手寫一份。
#
# 只准兩個值；打錯字不退回 prod（那會讓人以為打了 stage 其實出的是正式版）。
CHANNEL="${CHANNEL:-prod}"
case "$CHANNEL" in
  prod)
    APP_NAME="Arcrun"
    BUNDLE_NAME="arcrun-app"
    DMG_VOLUME="Arcrun"
    DIST_DIR="dist"
    CH_LDFLAGS=""
    ;;
  stage)
    APP_NAME="Arcrun Stage"
    BUNDLE_NAME="arcrun-app-stage"
    DMG_VOLUME="Arcrun Stage"
    DIST_DIR="dist-stage"
    CH_LDFLAGS="-X arcrun-rag/collector/channel.name=stage"
    ;;
  *)
    echo "❌ CHANNEL 只准 prod 或 stage（給了：${CHANNEL}）" >&2
    exit 2
    ;;
esac
export CHANNEL APP_NAME BUNDLE_NAME DMG_VOLUME DIST_DIR CH_LDFLAGS
