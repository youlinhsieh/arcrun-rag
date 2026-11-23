# probe.ps1 — 在 Windows runner 上側載一顆 msix、照使用者的路啟動、收當機證據
# 票：inkstone/arcrun-rag#387（Store 審核 10.1.2.10「啟動即當」）
param([string]$Msix, [string]$Out, [int]$WaitSec = 45)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Log($m) { $line = "$(Get-Date -Format o)  $m"; Write-Host $line; Add-Content -Path "$Out\probe.log" -Value $line }
function Shot($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
    $bmp.Save("$Out\$name.png"); Log "screenshot $name.png"
  } catch { Log "screenshot failed: $_" }
}
function Watch($label, $sec) {
  # 盯著 Arcrun 程序：一出現就抓住 handle，結束時才讀得到離開碼
  $held = @{}
  for ($i = 0; $i -lt ($sec * 4); $i++) {
    Start-Sleep -Milliseconds 250
    foreach ($p in @(Get-Process -Name Arcrun -ErrorAction SilentlyContinue)) {
      if (-not $held.ContainsKey($p.Id)) { try { $null = $p.Handle } catch {}; $held[$p.Id] = $p; Log "[$label] pid $($p.Id) started" }
    }
  }
  foreach ($k in @($held.Keys)) {
    $p = $held[$k]
    if ($p.HasExited) { Log ("[$label] pid $k EXITED code={0} (0x{0:X8})" -f $p.ExitCode) }
    else { $p.Refresh(); Log "[$label] pid $k ALIVE (window title: '$($p.MainWindowTitle)')" }
  }
  if ($held.Count -eq 0) { Log "[$label] no Arcrun process ever seen" }
  return @(Get-Process -Name Arcrun -ErrorAction SilentlyContinue).Count
}

Log "OS: $((Get-CimInstance Win32_OperatingSystem).Caption) build $([Environment]::OSVersion.Version)  user=$env:USERNAME session=$((Get-Process -Id $PID).SessionId)"
$wv = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
Log "WebView2 runtime: $($wv.pv)"

# 當機傾印：WER LocalDumps（真的崩潰才會有）
$ld = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\Arcrun.exe'
New-Item -Force $ld | Out-Null
New-ItemProperty -Force $ld -Name DumpFolder -Value "$Out\dumps" -PropertyType ExpandString | Out-Null
New-ItemProperty -Force $ld -Name DumpType -Value 1 -PropertyType DWord | Out-Null

# 1) 讀 manifest，做一把同 Publisher 的自簽憑證來簽（Store 會用自己的憑證重簽，這裡只為了側載）
$work = "$env:RUNNER_TEMP\msixwork"; Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
Copy-Item $Msix "$work\app.msix"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory("$work\app.msix", "$work\unpacked")
$manifest = [xml](Get-Content "$work\unpacked\AppxManifest.xml" -Raw)
$pub = $manifest.Package.Identity.Publisher; $name = $manifest.Package.Identity.Name
Log "Identity: $name / $pub / $($manifest.Package.Identity.Version)"
Copy-Item "$work\unpacked\AppxManifest.xml" "$Out\AppxManifest.xml"

$cert = New-SelfSignedCertificate -Type Custom -Subject $pub -KeyUsage DigitalSignature -FriendlyName 'msix-probe' -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
$pfx = "$work\c.pfx"; $pw = ConvertTo-SecureString -String 'probe' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\Root' -Password $pw | Out-Null
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1
& $signtool.FullName sign /fd SHA256 /f $pfx /p probe "$work\app.msix" 2>&1 | ForEach-Object { Log "signtool> $_" }

# 2) 安裝
$t0 = Get-Date
try { Add-AppxPackage -Path "$work\app.msix" -ErrorAction Stop; Log "Add-AppxPackage OK" }
catch { Log "Add-AppxPackage FAILED: $_"; Get-AppxLog -All | Select-Object -First 80 | Format-List | Out-File "$Out\appxlog.txt" -Width 400 }
$pkg = Get-AppxPackage -Name $name
Log "PFN: $($pkg.PackageFamilyName)  Install: $($pkg.InstallLocation)"

# 3A) 照使用者的路：開始功能表＝shell:AppsFolder\<AUMID>（帶套件身分）
$aumid = "$($pkg.PackageFamilyName)!Arcrun"
Log "A: launch shell:AppsFolder\$aumid"
Start-Process "explorer.exe" "shell:AppsFolder\$aumid"
$aliveA = Watch 'A-store-path' $WaitSec
Shot 'A-after'
Stop-Process -Name Arcrun -Force -ErrorAction SilentlyContinue; Start-Sleep 2

# 3B) 在套件裡面跑、把 stderr 接出來（Go 的 panic 會印在 stderr；GUI 程式平常看不到）
New-Item -ItemType Directory -Force C:\probe | Out-Null
$exeInPkg = Join-Path $pkg.InstallLocation 'Arcrun.exe'
Log "B: Invoke-CommandInDesktopPackage cmd /c Arcrun.exe 2> C:\probe\B-stderr.txt"
try {
  Invoke-CommandInDesktopPackage -PackageFamilyName $pkg.PackageFamilyName -AppId Arcrun -Command 'cmd.exe' -Args "/c `"`"$exeInPkg`" 1> C:\probe\B-stdout.txt 2> C:\probe\B-stderr.txt & echo exit=%ERRORLEVEL% > C:\probe\B-exit.txt`"" -PreventBreakaway
} catch { Log "B: Invoke-CommandInDesktopPackage failed: $_" }
$aliveB = Watch 'B-in-package' 30
Shot 'B-after'
Stop-Process -Name Arcrun -Force -ErrorAction SilentlyContinue; Start-Sleep 2
foreach ($f in 'B-stdout.txt','B-stderr.txt','B-exit.txt') { if (Test-Path "C:\probe\$f") { Copy-Item "C:\probe\$f" "$Out\$f"; Log "---- $f"; Get-Content "C:\probe\$f" | Select-Object -First 60 | ForEach-Object { Log "  $_" } } }

# 3C) 對照組：同一支 exe 不經套件、從一般資料夾直接跑
New-Item -ItemType Directory -Force C:\probe\bare | Out-Null
Copy-Item "$work\unpacked\Arcrun.exe" C:\probe\bare\Arcrun.exe -Force
Log "C: bare exe (no package identity)"
$null = Start-Process C:\probe\bare\Arcrun.exe -PassThru -RedirectStandardError "$Out\C-stderr.txt" -RedirectStandardOutput "$Out\C-stdout.txt"
$aliveC = Watch 'C-bare-exe' 30
Shot 'C-after'
Stop-Process -Name Arcrun -Force -ErrorAction SilentlyContinue; Start-Sleep 2
if (Test-Path "$Out\C-stderr.txt") { Log "---- C-stderr"; Get-Content "$Out\C-stderr.txt" | Select-Object -First 60 | ForEach-Object { Log "  $_" } }

# 4) 事件紀錄
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$t0} -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, Message | Format-List | Out-File "$Out\events-application.txt" -Width 400
foreach ($ln in 'Microsoft-Windows-AppModel-Runtime/Admin','Microsoft-Windows-AppXDeploymentServer/Operational','Microsoft-Windows-TWinUI/Operational') {
  $f = ($ln -replace '[/ ]','_')
  Get-WinEvent -FilterHashtable @{LogName=$ln; StartTime=$t0} -ErrorAction SilentlyContinue |
    Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List | Out-File "$Out\events-$f.txt" -Width 400
}
# 5) WER 報告
foreach ($d in "$env:ProgramData\Microsoft\Windows\WER\ReportArchive","$env:ProgramData\Microsoft\Windows\WER\ReportQueue","$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive","$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportQueue") {
  if (Test-Path $d) { Get-ChildItem $d -Recurse -Filter *.wer -ErrorAction SilentlyContinue | Where-Object LastWriteTime -ge $t0 | ForEach-Object { Copy-Item $_.FullName "$Out\WER-$($_.Directory.Name).wer" } }
}
# 6) 程式自己的 log 與 WebView2 資料夾（真實家目錄、套件虛擬化位置都找）
$pkgData = "$env:LOCALAPPDATA\Packages\$($pkg.PackageFamilyName)"
if (Test-Path $pkgData) { Get-ChildItem $pkgData -Recurse -Force -Depth 4 -ErrorAction SilentlyContinue | Select-Object FullName, Length | Out-File "$Out\pkgdata-tree.txt" -Width 400 }
if (Test-Path "$env:USERPROFILE\.arcrun-rag") { Get-ChildItem "$env:USERPROFILE\.arcrun-rag" -Recurse -Force -Depth 2 -ErrorAction SilentlyContinue | Select-Object FullName, Length | Out-File "$Out\home-arcrun-tree.txt" -Width 400 }
Get-ChildItem "$env:APPDATA" -Directory -Filter 'Arcrun*' -ErrorAction SilentlyContinue | ForEach-Object { Log "APPDATA has $($_.FullName)" }
Get-ChildItem "$env:USERPROFILE\.arcrun-rag\*.log" -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName "$Out\applog-$($_.Name)"; Log "---- $($_.Name)"; Get-Content $_.FullName -Tail 40 | ForEach-Object { Log "  $_" } }

Log "RESULT A_store_path_alive=$aliveA B_in_package_alive=$aliveB C_bare_alive=$aliveC"
Set-Content "$Out\result.txt" "A=$aliveA B=$aliveB C=$aliveC"
# 清乾淨給下一顆
Remove-AppxPackage $pkg.PackageFullName -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.arcrun-rag" -ErrorAction SilentlyContinue
Get-ChildItem "$env:APPDATA" -Directory -Filter 'Arcrun*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem 'Cert:\LocalMachine\TrustedPeople','Cert:\LocalMachine\Root','Cert:\CurrentUser\My' | Where-Object FriendlyName -eq 'msix-probe' | Remove-Item -ErrorAction SilentlyContinue
