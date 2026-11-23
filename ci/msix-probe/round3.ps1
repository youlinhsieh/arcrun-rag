# round3.ps1 — 前兩輪在 runner 上都重現不了（三種啟動法都活著、WACK 全 PASS、Defender 乾淨）
# 第四輪（同檔）：第三輪證明點設定流程正常；重做斷網（上輪舊實例沒殺掉）與標準使用者（上輪 Add-Type 失敗沒真的啟動）
# 第三輪補審核員會做、runner 還沒做的三件事（票：inkstone/arcrun-rag#387）：
#   1. 點下去：開始設定 → 連線 → 返回 → 免費申請（審核員一定會點）
#   2. 斷網啟動（審核機可能沒網路或擋外連）
#   3. 標準使用者（非管理員）安裝並啟動
param([string]$Msix, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Log($m) { $line = "$(Get-Date -Format o)  $m"; Write-Host $line; Add-Content -Path "$Out\round3.log" -Value $line }
function Shot($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
    $sm = New-Object Drawing.Bitmap $bmp, ([int]($b.Width * 0.6)), ([int]($b.Height * 0.6))
    $ms = New-Object IO.MemoryStream
    $enc = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $ep = New-Object Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), 55L
    $sm.Save($ms, $enc, $ep)
    Write-Host "SHOT-BEGIN r3-$name"; Write-Host ([Convert]::ToBase64String($ms.ToArray())); Write-Host "SHOT-END"
  } catch { Log "screenshot failed: $_" }
}
function Alive() { @(Get-Process -Name Arcrun -ErrorAction SilentlyContinue) }
function Report($label) {
  $p = Alive
  if ($p.Count -gt 0) { Log "[$label] ALIVE pids=$(($p | ForEach-Object Id) -join ',') title='$($p[0].MainWindowTitle)'" } else { Log "[$label] NOT RUNNING" }
}
function Kill() {
  for ($i = 0; $i -lt 5; $i++) {
    Get-Process -Name Arcrun -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    & taskkill.exe /F /T /IM Arcrun.exe 2>&1 | Out-Null
    Start-Sleep 2
    if (-not (Alive)) { Log "kill: Arcrun gone"; return }
  }
  Log "kill: Arcrun STILL RUNNING pids=$((Alive | ForEach-Object Id) -join ',')"
}

# 簽名＋安裝（同 probe.ps1）
$work = "$env:RUNNER_TEMP\r3"; Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($Msix, "$work\unpacked")
$mf = [xml](Get-Content "$work\unpacked\AppxManifest.xml" -Raw)
$pub = $mf.Package.Identity.Publisher; $name = $mf.Package.Identity.Name
$cert = New-SelfSignedCertificate -Type Custom -Subject $pub -KeyUsage DigitalSignature -FriendlyName 'msix-probe-r3' -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
$pfx = "$work\c.pfx"; $pw = ConvertTo-SecureString -String 'probe' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\Root' -Password $pw | Out-Null
$signed = "C:\probe-r3\signed.msix"; New-Item -ItemType Directory -Force C:\probe-r3 | Out-Null; Copy-Item $Msix $signed -Force
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1
& $signtool.FullName sign /fd SHA256 /f $pfx /p probe $signed 2>&1 | Out-Null
Add-AppxPackage -Path $signed
$pkg = Get-AppxPackage -Name $name
$aumid = "$($pkg.PackageFamilyName)!Arcrun"
$exeInPkg = Join-Path $pkg.InstallLocation 'Arcrun.exe'
Log "installed $($pkg.PackageFullName)"

# ── 2. 斷網啟動 ───────────────────────────────────────────────
Log "2. offline launch"; Kill; Report 'before-offline'
New-NetFirewallRule -DisplayName 'arcrun-offline' -Direction Outbound -Program $exeInPkg -Action Block | Out-Null
New-NetFirewallRule -DisplayName 'arcrun-offline-wv' -Direction Outbound -Program 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe' -Action Block -ErrorAction SilentlyContinue | Out-Null
Start-Process explorer.exe "shell:AppsFolder\$aumid"; Start-Sleep 30; Report 'offline-30s'
$p = Alive; if ($p) { Log "offline pid start time: $($p[0].StartTime.ToString('o'))" }
Shot 'offline'
Kill
Remove-NetFirewallRule -DisplayName 'arcrun-offline','arcrun-offline-wv' -ErrorAction SilentlyContinue

# ── 3. 標準使用者 ─────────────────────────────────────────────
Log "3. standard user"
Remove-AppxPackage $pkg.PackageFullName -ErrorAction SilentlyContinue
$upw = 'Pr0be-' + [guid]::NewGuid().ToString('N').Substring(0, 12) + '!'
$sec = ConvertTo-SecureString $upw -AsPlainText -Force
New-LocalUser -Name arctest -Password $sec -PasswordNeverExpires | Out-Null
Add-LocalGroupMember -Group Users -Member arctest -ErrorAction SilentlyContinue
Log "arctest is admin: $([bool](Get-LocalGroupMember Administrators | Where-Object Name -like '*arctest'))"
$child = @'
$ErrorActionPreference = 'Continue'
$log = 'C:\probe-r3\stduser.log'
function L($m) { Add-Content $log "$(Get-Date -Format o)  [$env:USERNAME] $m" }
L "whoami: $(whoami) admin=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))"
try { Add-AppxPackage -Path C:\probe-r3\signed.msix -ErrorAction Stop; L 'Add-AppxPackage OK' } catch { L "Add-AppxPackage FAILED: $_" }
$pkg = Get-AppxPackage -Name 'NAME_PLACEHOLDER'
L "pkg: $($pkg.PackageFullName)"
try {
Add-Type -ErrorAction Stop -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager { int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, int options, out uint pid); }
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] public class AAM { }
public static class Act { public static uint Run(string id) { uint pid; ((IApplicationActivationManager)new AAM()).ActivateApplication(id, null, 0, out pid); return pid; } }
"@
} catch { L "Add-Type failed: $_" }
try { $id = [Act]::Run("$($pkg.PackageFamilyName)!Arcrun"); L "activated pid=$id" } catch { L "activate failed: $_" }
Start-Sleep 40
$p = @(Get-Process -Name Arcrun -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*arctest')
L "alive after 40s: $($p.Count)"
Get-ChildItem "$env:USERPROFILE\.arcrun-rag" -Force -ErrorAction SilentlyContinue | ForEach-Object { L "home file: $($_.Name)" }
Get-Content "$env:USERPROFILE\.arcrun-rag\app.log" -ErrorAction SilentlyContinue | ForEach-Object { L "app.log: $_" }
'@
$child = $child.Replace('NAME_PLACEHOLDER', $name)
Set-Content C:\probe-r3\stduser.ps1 $child
icacls C:\probe-r3 /grant 'Users:(OI)(CI)M' | Out-Null
$cred = New-Object Management.Automation.PSCredential ('arctest', $sec)
try {
  $sp = Start-Process (Get-Command pwsh).Source -Credential $cred -LoadUserProfile -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\probe-r3\stduser.ps1' -PassThru -ErrorAction Stop
  if (-not $sp.WaitForExit(180000)) { Log "std user script timeout" }
} catch { Log "Start-Process as arctest failed: $_" }
Shot 'stduser'
Get-Content C:\probe-r3\stduser.log -ErrorAction SilentlyContinue | ForEach-Object { Log "std> $_" }
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-8)} -ErrorAction SilentlyContinue |
  Where-Object { $_.Id -in 1000,1001,1002 -or $_.Message -match 'Arcrun' } | Select-Object -First 10 |
  ForEach-Object { Log "event $($_.Id) $($_.ProviderName): $($_.Message -replace '\s+',' ')" }
Get-Process -Name Arcrun -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-LocalUser arctest -ErrorAction SilentlyContinue
