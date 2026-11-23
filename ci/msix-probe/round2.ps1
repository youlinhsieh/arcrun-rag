# round2.ps1 — 第一輪在 Server 2025（管理員）重現不了當機，第二輪補 Store 審核機和 runner 不同的三格
# 票：inkstone/arcrun-rag#387
#   1. Windows App Certification Kit（WACK）——Store 送審同一套自動測試，含「啟動當機／卡住」
#   2. Defender 用最新病毒碼掃 exe（封測者曾撞 Trojan:Win32/Sabsik.FL.A!ml；若被隔離＝一開就消失、沒有錯誤訊息）
#   3. 截圖直接印進 log（artifact 從雲端 session 下載不到）
param([string]$Msix, [string]$Out)
$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Log($m) { $line = "$(Get-Date -Format o)  $m"; Write-Host $line; Add-Content -Path "$Out\round2.log" -Value $line }

$work = "$env:RUNNER_TEMP\r2"; Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue; New-Item -ItemType Directory $work | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($Msix, "$work\unpacked")
$exe = "$work\unpacked\Arcrun.exe"
Log "exe sha256 $((Get-FileHash $exe).Hash)"

# ── 2. Defender ──────────────────────────────────────────────
$st = Get-MpComputerStatus -ErrorAction SilentlyContinue
Log "Defender: AMRunning=$($st.AMRunningMode) RealTime=$($st.RealTimeProtectionEnabled) Sig=$($st.AntivirusSignatureVersion) SigAge=$($st.AntivirusSignatureAge)d"
try { Update-MpSignature -UpdateSource MicrosoftUpdateServer -ErrorAction Stop; Log "Update-MpSignature OK" } catch { Log "Update-MpSignature failed: $_" }
$st = Get-MpComputerStatus -ErrorAction SilentlyContinue
Log "Defender after update: Sig=$($st.AntivirusSignatureVersion) Engine=$($st.AMEngineVersion)"
$mp = Get-ChildItem 'C:\ProgramData\Microsoft\Windows Defender\Platform\*\MpCmdRun.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $mp) { $mp = Get-Item 'C:\Program Files\Windows Defender\MpCmdRun.exe' -ErrorAction SilentlyContinue }
Log "MpCmdRun: $($mp.FullName)"
& $mp.FullName -Scan -ScanType 3 -File $exe -DisableRemediation 2>&1 | ForEach-Object { Log "mpcmdrun> $_" }
Log "mpcmdrun exit=$LASTEXITCODE (0=乾淨, 2=有偵測)"
& $mp.FullName -Scan -ScanType 3 -File $Msix -DisableRemediation 2>&1 | ForEach-Object { Log "mpcmdrun(msix)> $_" }
Get-MpThreatDetection -ErrorAction SilentlyContinue | Select-Object -First 5 | Format-List | Out-String | ForEach-Object { Log "threats> $_" }


# 側載／WACK 都要簽過的套件：做一把同 Publisher 的自簽憑證（Store 會用自己的憑證重簽）
$pub = ([xml](Get-Content "$work\unpacked\AppxManifest.xml" -Raw)).Package.Identity.Publisher
$cert = New-SelfSignedCertificate -Type Custom -Subject $pub -KeyUsage DigitalSignature -FriendlyName 'msix-probe-r2' -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')
$pfx = "$work\c.pfx"; $pw = ConvertTo-SecureString -String 'probe' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pw | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\Root' -Password $pw | Out-Null
$signed = "$work\signed.msix"; Copy-Item $Msix $signed
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName -Descending | Select-Object -First 1
& $signtool.FullName sign /fd SHA256 /f $pfx /p probe $signed 2>&1 | Out-Null
$Msix = $signed

# ── 1. WACK ─────────────────────────────────────────────────
$appcert = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $appcert) { Log "WACK: appcert.exe 不在這台 runner 上" }
else {
  # WACK 要求套件已簽或用開發者模式；它自己會安裝、啟動、移除
  $report = "$Out\wack-report.xml"
  Log "WACK: $($appcert.FullName) test -appxpackagepath $Msix"
  & $appcert.FullName reset 2>&1 | Out-Null
  $p = Start-Process -FilePath $appcert.FullName -ArgumentList @('test','-appxpackagepath',"`"$Msix`"",'-reportoutputpath',"`"$report`"") -PassThru -NoNewWindow
  if (-not $p.WaitForExit(900000)) { Log "WACK: 15 分鐘沒跑完，強制停"; $p.Kill() }
  Log "WACK exit=$($p.ExitCode)"
  if (Test-Path $report) {
    $raw = Get-Content $report -Raw
    Write-Host "WACK-RAW-BEGIN"; Write-Host $raw.Substring(0, [Math]::Min($raw.Length, 20000)); Write-Host "WACK-RAW-END"
    [xml]$x = $raw
    Log "WACK OVERALL_RESULT=$($x.REPORT.OVERALL_RESULT)"
    foreach ($t in $x.SelectNodes('//TEST')) {
      $msgs = ($t.SelectNodes('.//MESSAGE') | ForEach-Object { $_.TEXT }) -join ' | '
      Log ("WACK [{0}] {1} {2}" -f $t.RESULT.'#cdata-section', $t.NAME, $msgs)
      if (-not $t.RESULT.'#cdata-section') { Log ("WACK [{0}] {1} {2}" -f $t.RESULT, $t.NAME, $msgs) }
    }
  } else { Log "WACK: 沒有產出報告" }
}
