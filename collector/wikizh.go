// wikizh.go — 目錄行附「統一中文譯名」（inkstone/arcrun-rag#264 c21860，應急補丁）。
//
// 病：英文手冊／錯誤碼原稿的目錄行只有英文節錄，用中文描述症狀（「設定檔寫不進去」「刀具不適用」「圓弧半徑太小」）
// 做關鍵字搜尋搜不到；雲端 AI 寫的中文又不一致（Configuration file 有時譯「檔案」，tool 有時「工具」有時「刀具」）。
//
// 做法（不重送文件卡、不跑 AI）：目錄層加一段用**固定術語表**逐詞對出來的中文，術語永遠同一個譯法
// （tool＝刀具、configuration file＝設定檔、radius＝半徑…）。原本的英文節錄一字不動，中文附在後面：
//
//	｜中：<依原稿語序逐詞譯出，未收錄的詞略過>｜詞：<去重的關鍵詞>
//
// 這是機械式逐詞對照，不是通順翻譯；目的只有一個——中文症狀描述的字眼要在目錄行裡找得到。
// 術語表是通用英文技術詞彙（工具機／控制器／軟體常見詞），不含任何錯誤碼或客戶特例。
// 通用修法看 inkstone/Arcrun#317 c21840（萃卡時帶一致中文術語），之後由它取代本補丁。
package collector

import (
	"regexp"
	"strings"
)

// zhGlossary：英文（小寫）=中文。多詞片語寫成「a b=譯」；譯文空白＝虛詞，略過。
// 同義詞以 | 分隔時，第一個放進「中」句，其餘只放進「詞」。
const zhGlossary = `
configuration file=設定檔|配置檔
configuration files=設定檔|配置檔
config file=設定檔|配置檔
circular arc=圓弧
circular=圓形
arc=圓弧
circle=圓
radius=半徑
diameter=直徑
too small=太小|過小
too large=太大|過大
too big=太大|過大
too high=過高|太高
too low=過低|太低
too long=過長|太長
too short=過短|太短
too many=太多|過多
too great=過大
too much=過多
cannot be written=無法寫入|寫不進去|寫入失敗
cannot be read=無法讀取|讀不到
cannot be opened=無法開啟|打不開
cannot be loaded=無法載入
cannot be found=找不到
cannot be saved=無法儲存
cannot be executed=無法執行
cannot be deleted=無法刪除
cannot be created=無法建立
cannot be=無法
cannot=無法
can not=無法
not possible=不可能|無法
not allowed=不允許|不可
not permitted=不允許|不可
not permissible=不允許|不可
not defined=未定義
not available=無法使用|不可用
not supported=不支援
not found=找不到
not enough=不足
not suitable=不適用|不合適
not ready=未就緒
not active=未啟用
not exist=不存在
does not exist=不存在
no longer=不再
unsuitable=不適用|不合適
suitable=適用|合適
tool=刀具
tools=刀具
cutting tool=刀具
tool radius=刀具半徑
tool length=刀長
tool table=刀具表
tool change=換刀
tool holder=刀把
machining=加工
machined=加工
milling=銑削
turning=車削
grinding=磨削
drilling=鑽孔
thread=螺紋
pocket=型腔
cutout=切口
chamfer=倒角
rounding=倒圓
contour=輪廓
workpiece=工件
blank=毛胚
part=零件
datum=基準點
preset=預設點
probe=探針
probing=探測
touch probe=測頭
measurement=量測
measuring=量測
measured=量測
cycle=循環
cycles=循環
program=程式
programs=程式
programmed=已編程|程式中指定
programming=編程
subprogram=子程式
nc program=NC程式
nc block=NC單節
block=單節
blocks=單節
file=檔案
files=檔案
directory=目錄
folder=資料夾
disk=磁碟
hard disk=硬碟
drive full=磁碟已滿
write-protected=寫入保護|唯讀
write protection=寫入保護|唯讀
write=寫入
written=寫入
writing=寫入
read=讀取
reading=讀取
open=開啟
opened=開啟
opening=開啟
load=載入
loaded=載入
loading=載入
save=儲存
saved=儲存
delete=刪除
deleted=刪除
create=建立
created=建立
copy=複製
transfer=傳輸
transferred=傳輸
transmission=傳輸
communication=通訊
connection=連線
connected=已連接
connect=連接
cable=纜線
wiring=接線
interface=介面
network=網路
bus=匯流排
server=伺服器
timeout=逾時
time out=逾時
exceeded=超過
exceeds=超過
exceed=超過
exceeding=超過
limit=限值|極限
limits=限值|極限
range=範圍
outside=超出
out of range=超出範圍
maximum=最大
minimum=最小
max=最大
min=最小
permissible=容許
tolerance=公差
axis=軸
axes=軸
rotary axis=旋轉軸
rotary=旋轉
spindle=主軸
motor=馬達
encoder=編碼器
drive=驅動器
drives=驅動器
inverter=變頻器
power supply=電源
supply voltage=供應電壓
power=電源
voltage=電壓
current=電流
temperature=溫度
frequency=頻率
speed=速度
velocity=速度
feed=進給
feed rate=進給率
acceleration=加速度
torque=扭矩
position=位置
positioning=定位
positions=位置
coordinate=座標
coordinates=座標
direction=方向
angle=角度
length=長度
width=寬度
depth=深度
distance=距離
height=高度
size=尺寸
plane=平面
tilted=傾斜
tilting=傾斜
orientation=定向
rotation=旋轉
linear=直線
line=線
point=點
start point=起點
end point=終點
starting point=起點
start=開始
end=結束
center=中心
edge=邊緣
surface=表面
geometry=幾何
kinematics=運動學
kinematic=運動學
compensation=補償
collision=碰撞
overload=過載
overheating=過熱
short circuit=短路
circuit=電路
brake=煞車
braking=煞車
emergency stop=緊急停止
emergency=緊急
stop=停止
stopped=已停止
safety=安全
safe=安全
safety-related=安全相關
sto=STO安全扭矩關閉
door=門
guard=防護
fault=故障
faulty=故障
defective=損壞|故障
damaged=損壞
failure=失效
failed=失敗
fail=失敗
error=錯誤
errors=錯誤
incorrect=不正確|錯誤
incorrectly=不正確
wrong=錯誤
invalid=無效
illegal=非法|無效
impermissible=不允許
erroneous=錯誤
inconsistent=不一致
contradictory=互相矛盾|矛盾
incompatible=不相容
unknown=未知
undefined=未定義
defined=已定義
define=定義
definition=定義
missing=遺失|缺少
lost=遺失
unavailable=無法使用
available=可用
insufficient=不足
incomplete=不完整
empty=空的
already=已經
duplicate=重複
twice=重複
active=啟用中
inactive=未啟用
activated=已啟用
deactivated=已停用
enabled=已啟用
disabled=已停用
locked=鎖定
lock=鎖定
released=已釋放
release=釋放
selected=已選取
select=選取
selection=選取
entered=輸入
enter=輸入
entry=輸入項|項目
input=輸入
inputs=輸入
output=輸出
outputs=輸出
signal=訊號
signals=訊號
parameter=參數
parameters=參數
param=參數
value=數值
values=數值
number=編號|數量
name=名稱
text=文字
string=字串
character=字元
characters=字元
format=格式
syntax=語法
command=指令
function=功能
functions=功能
operation=操作
mode=模式
option=選項
setting=設定
settings=設定
set=設定
configured=已設定
configuration=設定|配置
config=設定
change=變更
changed=已變更
changing=變更
update=更新
version=版本
firmware=韌體
software=軟體
hardware=硬體
system=系統
internal=內部
external=外部
memory=記憶體
buffer=緩衝區
overflow=溢位
stack=堆疊
table=表格
list=清單
column=欄位
row=列
record=紀錄
database=資料庫
data=資料
information=資訊
message=訊息
messages=訊息
warning=警告
alarm=警報
display=顯示
screen=畫面
keyboard=鍵盤
key=按鍵
button=按鈕
switch=開關
switched=切換
handwheel=手輪
panel=面板
machine=機台
control=控制器
controller=控制器
plc=PLC
module=模組
component=元件
device=裝置
devices=裝置
unit=單元
board=板卡
sensor=感測器
scale=尺規
test=測試
self-test=自我測試
check=檢查
checksum=檢查碼
calibration=校正
initialization=初始化
startup=啟動
start-up=啟動
restart=重新啟動
reboot=重新啟動
shutdown=關機
reset=重置
simulation=模擬
monitoring=監控
monitor=監控
watchdog=看門狗
license=授權
password=密碼
access=存取
authorization=授權
user=使用者
pallet=工作台
chip=切屑
coolant=冷卻液
lubrication=潤滑
fan=風扇
filter=濾波器
pulse=脈衝
reference=參考
reference point=參考點
home=原點
zero=零點
offset=偏移
negative=負
positive=正
double=重複
parallel=平行
program interrupted=程式中斷
interrupted=中斷
aborted=中止
canceled=取消
cancelled=取消
interruption=中斷
mismatch=不符
match=相符
difference=差異
deviation=偏差
error code=錯誤碼
variable=變數
overrun=超出
oscillation=振動
vibration=振動
unbalance=不平衡
wheel=砂輪
dressing=修整
infeed=切入
plunging=插入
approach=趨近
retract=退刀
`

type zhEntry struct {
	first string   // 放進「中」句的譯文
	all   []string // 放進「詞」的全部譯文
}

var (
	zhDict    map[string]zhEntry
	zhMaxWord = 1
	zhWordRe  = regexp.MustCompile(`[A-Za-z][A-Za-z\-]*`)
	zhLabelRe = regexp.MustCompile(`^\*\*(.+?)\*\*[:：]?\s*$`)
)

func init() {
	zhDict = map[string]zhEntry{}
	for _, ln := range strings.Split(zhGlossary, "\n") {
		ln = strings.TrimSpace(ln)
		k, v, ok := strings.Cut(ln, "=")
		if !ok || k == "" {
			continue
		}
		parts := strings.Split(v, "|")
		zhDict[k] = zhEntry{first: parts[0], all: parts}
		if n := len(strings.Fields(k)); n > zhMaxWord {
			zhMaxWord = n
		}
	}
}

// zhTranslate：把一段英文逐詞（最長片語優先）對成中文；回傳（依語序連起來的中文，去重的關鍵詞）。
func zhTranslate(en string) (string, []string) {
	words := zhWordRe.FindAllString(strings.ToLower(en), -1)
	var phrase strings.Builder
	var terms []string
	seen := map[string]bool{}
	for i := 0; i < len(words); {
		hit := false
		for n := zhMaxWord; n >= 1; n-- {
			if i+n > len(words) {
				continue
			}
			if e, ok := zhDict[strings.Join(words[i:i+n], " ")]; ok {
				phrase.WriteString(e.first)
				for _, t := range e.all {
					if !seen[t] {
						seen[t] = true
						terms = append(terms, t)
					}
				}
				i += n
				hit = true
				break
			}
		}
		if !hit {
			i++
		}
	}
	return phrase.String(), terms
}

// zhSections：取原稿裡「說明症狀」的段落全文（Error message／Cause…），沒有粗體小標就取開頭一小段。
// 回傳 symptom（Error message＋Cause，用來譯成句）與 rest（其餘小標，如 Error correction，只進關鍵詞）。
func zhSections(text string) (symptom, rest string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	label := ""
	hasLabel := false
	var sym, other, plain []string
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t == "---" && (hasLabel || len(plain) > 0) {
			break
		}
		if m := zhLabelRe.FindStringSubmatch(t); m != nil {
			label = strings.ToLower(m[1])
			hasLabel = true
			continue
		}
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, ">") || strings.HasPrefix(t, "|") {
			continue
		}
		t = strings.TrimLeft(t, "-+* \t")
		switch {
		case !hasLabel:
			if len(plain) < 3 {
				plain = append(plain, t)
			}
		case strings.Contains(label, "message") || strings.Contains(label, "cause"):
			sym = append(sym, t)
		default:
			other = append(other, t)
		}
	}
	if !hasLabel {
		return strings.Join(plain, "\n"), ""
	}
	return strings.Join(sym, "\n"), strings.Join(other, "\n")
}

const (
	zhPhraseMax = 90 // 「中」句字數上限
	zhTermsMax  = 14 // 「詞」個數上限
)

// zhTag：由原稿開頭文字產生要附在目錄行後的中文段；沒有任何術語命中就回 ""。
func zhTag(text string) string {
	sym, rest := zhSections(text)
	// 每一行（一個句子／一個項目）各自逐詞譯，行與行之間用「，」隔開，避免跨句湊出假的相鄰字串。
	var pieces, terms []string
	for _, ln := range strings.Split(sym, "\n") {
		p, ts := zhTranslate(ln)
		if p != "" && (len(pieces) == 0 || pieces[len(pieces)-1] != p) {
			pieces = append(pieces, p)
		}
		terms = append(terms, ts...)
	}
	phrase := strings.Join(pieces, "，")
	_, restTerms := zhTranslate(rest)
	if phrase == "" && len(terms) == 0 {
		return ""
	}
	seen := map[string]bool{}
	var uniq []string
	for _, t := range terms {
		if !seen[t] {
			seen[t] = true
			uniq = append(uniq, t)
		}
	}
	terms = uniq
	for _, t := range restTerms {
		if !seen[t] {
			seen[t] = true
			terms = append(terms, t)
		}
	}
	if r := []rune(phrase); len(r) > zhPhraseMax {
		phrase = string(r[:zhPhraseMax])
	}
	if len(terms) > zhTermsMax {
		terms = terms[:zhTermsMax]
	}
	out := ""
	if phrase != "" {
		out += "｜中：" + phrase
	}
	if len(terms) > 0 {
		out += "｜詞：" + strings.Join(terms, "、")
	}
	return out
}
