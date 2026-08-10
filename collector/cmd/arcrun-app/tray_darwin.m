//go:build darwin
// tray_darwin.m — macOS 選單列 icon（t194 三修，原生實作）
//
// 🔴 為什麼不用 energye/systray：實測證明它在 Wails 之下**根本沒建立托盤**。
//    systray.go:83 的 setInternalLoop(true) 只在 systray.Run() 裡呼叫；
//    RunWithExternalLoop 沒有 ⇒ registerSystray() 第一行就
//    `if (!internalLoop) return;` ⇒ delegate 從沒建立
//    ⇒ onReady 不會被呼叫、enable_on_click 不會執行、左右鍵事件根本不存在。
//    最小重現（scratchpad/traytest）：READY 從未印出、點擊無反應。
//    ⇒ 直接用 NSStatusItem，行為完全由我們掌握。
#import <Cocoa/Cocoa.h>

extern void trayOnLeftClick(void);
extern void trayOnQuit(void);

@interface ArcrunTray : NSObject
@property (strong) NSStatusItem *item;
@property (strong) NSMenu *menu;
- (void)onClick:(id)sender;
- (void)onQuit:(id)sender;
@end

@implementation ArcrunTray
// 左鍵＝開視窗；右鍵＝彈選單。用 currentEvent 分辨（與系統慣例一致）。
- (void)onClick:(id)sender {
  NSEvent *e = [NSApp currentEvent];
  if (e.type == NSEventTypeRightMouseUp ||
      (e.type == NSEventTypeLeftMouseUp && (e.modifierFlags & NSEventModifierFlagControl))) {
    // 右鍵（或 Ctrl+左鍵，macOS 慣例）：把選單彈在 icon 底下。
    // popUpStatusItemMenu 自 10.14 起 deprecated ⇒ 改用「暫時掛上選單、
    // 送一次 click、再拿掉」——這是官方建議的替代寫法，且不會讓左鍵失效。
    self.item.menu = self.menu;
    [self.item.button performClick:nil];
    self.item.menu = nil;
    return;
  }
  trayOnLeftClick();
}
- (void)onQuit:(id)sender { trayOnQuit(); }
@end

static ArcrunTray *gTray = nil;
static void createTrayNow(NSData *iconData, NSString *tip, NSString *quitTitle);

// 用一個小物件把參數帶到主執行緒（performSelectorOnMainThread 只能傳一個 object）
@interface ArcrunTrayBoot : NSObject
@property (strong) NSData *iconData;
@property (strong) NSString *tip;
@property (strong) NSString *quitTitle;
- (void)run;
@end
@implementation ArcrunTrayBoot
- (void)run { createTrayNow(self.iconData, self.tip, self.quitTitle); }
@end

// createTray：兩個條件同時要滿足，缺一個都會靜默失敗（兩個我都踩過）：
//   ① **主執行緒**——NSStatusItem 內部會 new NSWindow
//      （在別的 goroutine 呼叫 ⇒ "NSWindow should only be instantiated on the main thread!"）
//   ② **NSApplication 已初始化**——[NSStatusBar systemStatusBar] 在 NSApp
//      還沒 finishLaunching 時拿不到東西 ⇒ icon 不會出現、也不報錯
//      （實測：在 wails.Run() 之前呼叫 ⇒ menu bar item 數 = 0）
// ⇒ 用 dispatch_async 丟到 main queue：Wails 起來後才會被執行，且保證在主執行緒。
void createTray(const char *iconBytes, int iconLen, const char *tooltip, const char *quitTitle) {
  // 先把參數複製一份——呼叫端的 C 字串在 dispatch 執行時可能已被釋放
  NSData *iconData = [NSData dataWithBytes:iconBytes length:iconLen];
  NSString *tip = [NSString stringWithUTF8String:tooltip];
  NSString *qt  = [NSString stringWithUTF8String:quitTitle];
  // 🔴 **不能用 dispatch_async(main_queue)**——實測 Wails 佔住主執行緒後
  //    沒有跑標準 run loop，排進 main queue 的 block **永遠不會被執行**
  //    （log 只印到 "dispatching…"，block 內完全沒動靜）。
  //    改用 performSelectorOnMainThread：它走的是 run loop 的 common modes，
  //    在 Wails 的 loop 之下仍會被處理。
  ArcrunTrayBoot *boot = [[ArcrunTrayBoot alloc] init];
  boot.iconData = iconData; boot.tip = tip; boot.quitTitle = qt;
  [boot performSelectorOnMainThread:@selector(run) withObject:nil waitUntilDone:NO];
}

static void createTrayNow(NSData *iconData, NSString *tip, NSString *quitTitle) {
  gTray = [[ArcrunTray alloc] init];
  gTray.item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];

  NSImage *img = [[NSImage alloc] initWithData:iconData];
  [img setSize:NSMakeSize(18, 18)];
  [img setTemplate:YES];          // 由系統依深淺色自動上色
  gTray.item.button.image = img;
  gTray.item.button.toolTip = tip;

  // 右鍵選單只有一項（leo：「托盤裡只剩下按右鍵會結束」）
  gTray.menu = [[NSMenu alloc] init];
  NSMenuItem *q = [[NSMenuItem alloc] initWithTitle:quitTitle
                                             action:@selector(onQuit:) keyEquivalent:@""];
  [q setTarget:gTray];
  [gTray.menu addItem:q];

  // ⚠️ **不要** setMenu:——一旦設了選單，按鈕的 action 就不會被呼叫，
  //    左鍵也會變成彈選單（這正是 systray 那個「建了選單滑鼠事件失效」的同一件事）。
  //    改成自己在 onClick: 裡判斷左右鍵，右鍵才 popUpStatusItemMenu。
  [gTray.item.button setTarget:gTray];
  [gTray.item.button setAction:@selector(onClick:)];
  [gTray.item.button sendActionOn:(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)];
}
