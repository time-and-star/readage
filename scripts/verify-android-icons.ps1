param(
    [string]$ArchivePath = 'android/app/build/outputs/apk/debug/app-debug.apk',
    [string]$ReportPath = 'output/icon-fix/android-apk-icons-verification.json'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobileArchivePath = if ([System.IO.Path]::IsPathRooted($ArchivePath)) { $ArchivePath } else { Join-Path $mobileRoot $ArchivePath }
$mobilePolicyScript = Join-Path $mobileRoot 'scripts/android-icon-policy.mjs'
$mobileSourceJson = (& node $mobilePolicyScript --sources $mobileRoot) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Canonical Android icon source verification failed.' }
$mobileSourceInfo = $mobileSourceJson | ConvertFrom-Json
$mobileManifest = $mobileSourceInfo.manifest
$mobileAapt2Path = Join-Path $mobileRoot 'tmp/android-tools/sdk/build-tools/36.0.0/aapt2.exe'
if (-not (Test-Path -LiteralPath $mobileAapt2Path)) {
    $mobileSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    if (-not $mobileSdk) { throw 'No Android SDK found for compiled icon verification.' }
    $mobileAapt2Path = Join-Path $mobileSdk 'build-tools/36.0.0/aapt2.exe'
}
$mobileResourceDump = (& $mobileAapt2Path dump resources $mobileArchivePath) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect compiled icon resources.' }
$mobileManifestDump = (& $mobileAapt2Path dump xmltree --file AndroidManifest.xml $mobileArchivePath) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the APK Manifest.' }
$mobileArchive = [System.IO.Compression.ZipFile]::OpenRead($mobileArchivePath)
$mobileResults = @()
try {
    $mobilePolicyBundle = [ordered]@{ root = $mobileRoot; manifestDump = $mobileManifestDump; resourceDump = $mobileResourceDump }
    $mobilePolicyBundlePath = Join-Path ([System.IO.Path]::GetTempPath()) ("readge-icon-policy-" + [guid]::NewGuid().ToString('N') + '.json')
    try {
        [System.IO.File]::WriteAllText($mobilePolicyBundlePath, ($mobilePolicyBundle | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
        $mobilePolicyJson = (& node $mobilePolicyScript --compiled $mobilePolicyBundlePath) -join "`n"
        if ($LASTEXITCODE -ne 0) { throw 'The final APK violates the Android transparent icon delivery policy.' }
        $mobilePolicy = $mobilePolicyJson | ConvertFrom-Json
    } finally {
        if (Test-Path -LiteralPath $mobilePolicyBundlePath) { Remove-Item -LiteralPath $mobilePolicyBundlePath }
    }
    foreach ($mobileFrame in $mobileManifest.frames) {
        $mobileResourcePath = $mobileFrame.path -replace '^android/app/src/main/', ''
        $mobileResourceFolder = [System.IO.Path]::GetDirectoryName($mobileResourcePath).Replace('\', '/')
        $mobileResourceName = [System.IO.Path]::GetFileName($mobileResourcePath)
        $mobileResourcePattern = '^' + [regex]::Escape($mobileResourceFolder) + '(?:-v\d+)?/' + [regex]::Escape($mobileResourceName) + '$'
        $mobileMatches = @($mobileArchive.Entries | Where-Object { $_.FullName -match $mobileResourcePattern })
        if ($mobileMatches.Count -ne 1) { throw "Expected one compiled resource for $mobileResourcePath, found $($mobileMatches.Count)." }
        $mobileEntry = $mobileMatches[0]
        $mobileEntryStream = $mobileEntry.Open()
        $mobileExpected = [System.Drawing.Bitmap]::FromFile((Join-Path $mobileRoot $mobileFrame.path))
        $mobileCompiled = [System.Drawing.Bitmap]::FromStream($mobileEntryStream)
        try {
            if ($mobileCompiled.Width -ne $mobileFrame.size -or $mobileCompiled.Height -ne $mobileFrame.size) { throw "Wrong compiled dimensions for $mobileResourcePath." }
            $mobileMismatches = 0
            $mobileOutsideCircle = 0
            $mobileMaxRadius = 0.0
            $mobileIsForeground = $mobileResourceName -eq 'ic_launcher_foreground.png'
            $mobileCenter = $mobileCompiled.Width / 2.0
            $mobileSafeRadius = $mobileCompiled.Width * 33.0 / 108.0
            for ($mobileY = 0; $mobileY -lt $mobileCompiled.Height; $mobileY++) {
                for ($mobileX = 0; $mobileX -lt $mobileCompiled.Width; $mobileX++) {
                    $mobileActualPixel = $mobileCompiled.GetPixel($mobileX, $mobileY)
                    $mobileExpectedPixel = $mobileExpected.GetPixel($mobileX, $mobileY)
                    # Transparent RGB values can change during PNG crunching;
                    # compare alpha plus all pixels that can affect rendering.
                    if ($mobileActualPixel.A -ne $mobileExpectedPixel.A -or ($mobileActualPixel.A -gt 0 -and $mobileActualPixel.ToArgb() -ne $mobileExpectedPixel.ToArgb())) { $mobileMismatches++ }
                    if ($mobileIsForeground -and $mobileActualPixel.A -gt 32) {
                        $mobileRadius = [Math]::Sqrt([Math]::Pow($mobileX + 0.5 - $mobileCenter, 2) + [Math]::Pow($mobileY + 0.5 - $mobileCenter, 2))
                        $mobileMaxRadius = [Math]::Max($mobileMaxRadius, $mobileRadius)
                        if ($mobileRadius -gt $mobileSafeRadius) { $mobileOutsideCircle++ }
                    }
                }
            }
            foreach ($mobileCorner in @(@(0, 0), @(($mobileCompiled.Width - 1), 0), @(0, ($mobileCompiled.Height - 1)), @(($mobileCompiled.Width - 1), ($mobileCompiled.Height - 1)))) {
                if ($mobileCompiled.GetPixel($mobileCorner[0], $mobileCorner[1]).A -ne 0) { throw "Opaque compiled corner: $mobileResourcePath." }
            }
            if ($mobileMismatches -ne 0) { throw "$mobileResourcePath has $mobileMismatches decoded pixel differences from the generated PNG." }
            if ($mobileOutsideCircle -ne 0) { throw "$mobileResourcePath has $mobileOutsideCircle visible pixels outside the adaptive safe circle." }
            $mobileResults += [ordered]@{
                resource = $mobileEntry.FullName
                size = $mobileCompiled.Width
                cornerAlpha = 0
                decodedPixelDifferences = $mobileMismatches
                safeCircleVisiblePixelsOutside = $mobileOutsideCircle
                maximumVisibleRadius = [Math]::Round($mobileMaxRadius, 3)
                generatedSha256 = $mobileFrame.sha256
            }
        } finally {
            $mobileCompiled.Dispose()
            $mobileExpected.Dispose()
            $mobileEntryStream.Dispose()
        }
    }
} finally { $mobileArchive.Dispose() }

$mobileHasher = [System.Security.Cryptography.SHA256]::Create()
$mobileFileStream = [System.IO.File]::OpenRead($mobileArchivePath)
try { $mobileArchiveHash = [BitConverter]::ToString($mobileHasher.ComputeHash($mobileFileStream)).Replace('-', '').ToLowerInvariant() }
finally { $mobileHasher.Dispose(); $mobileFileStream.Dispose() }
$mobileReport = [ordered]@{
    archive = $ArchivePath
    archiveBytes = (Get-Item -LiteralPath $mobileArchivePath).Length
    archiveSha256 = $mobileArchiveHash
    sourceSha256 = $mobileManifest.sourceSha256
    applicationId = $mobilePolicy.applicationId
    versionCode = $mobilePolicy.versionCode
    versionName = $mobilePolicy.versionName
    launcherDrawableType = $mobilePolicy.launcherDrawableType
    selectedLauncherPngCount = $mobilePolicy.selectedLauncherPngCount
    selectedAdaptiveXmlCount = $mobilePolicy.selectedAdaptiveXmlCount
    verifiedPngCount = $mobileResults.Count
    frames = $mobileResults
    launcher = $mobilePolicy.launcher
    applicationLauncher = $mobilePolicy.applicationLauncher
    deviceRenderingVerified = $false
    deviceRenderingNote = 'Selected resources are plain transparent PNGs with no background wrapper. OEM launchers may redraw cached icons later; transparent device rendering over time still requires actual screenshots.'
}
$mobileReportFullPath = if ([System.IO.Path]::IsPathRooted($ReportPath)) { $ReportPath } else { Join-Path $mobileRoot $ReportPath }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $mobileReportFullPath) | Out-Null
[System.IO.File]::WriteAllText($mobileReportFullPath, (($mobileReport | ConvertTo-Json -Depth 6) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Output "Verified $($mobileResults.Count) compiled Android PNGs and both selected transparent bitmap launcher resources. Report: $ReportPath"
