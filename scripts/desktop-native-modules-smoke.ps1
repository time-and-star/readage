param([Parameter(Mandatory=$true)][string]$Fixture, [Parameter(Mandatory=$true)][string]$AppDirectory)
$ErrorActionPreference = 'Stop'
$fixturePath = [IO.Path]::GetFullPath($Fixture)
$appPath = [IO.Path]::GetFullPath($AppDirectory)
$outputFile = Join-Path (Get-Location) 'build/desktop/native-modules-verification.json'
$expected = @{
  translation = @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll','vcomp140.dll')
  onnx = @('msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll')
  japanese = @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')
}
$deadline = [DateTime]::UtcNow.AddSeconds(120)
while ([DateTime]::UtcNow -lt $deadline) {
  $candidates = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe' OR Name='python.exe' OR Name='readge.exe'"
  $selected = @{
    translation = $candidates | Where-Object { $_.Name -eq 'llama-server.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($fixturePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    japanese = $candidates | Where-Object { $_.Name -eq 'python.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($fixturePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    onnx = $candidates | Where-Object { $_.Name -eq 'readge.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appPath, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -like '*kokoro-service.mjs*' } | Select-Object -First 1
  }
  $records = @()
  $ready = $true
  foreach ($kind in $expected.Keys) {
    $candidate = $selected[$kind]
    if (-not $candidate) { $ready = $false; continue }
    try {
      $modules = (Get-Process -Id $candidate.ProcessId).Modules | Where-Object { $expected[$kind] -contains $_.ModuleName.ToLowerInvariant() }
      if (@($modules).Count -ne $expected[$kind].Count) { $ready = $false; continue }
      foreach ($module in $modules) {
        $local = $module.FileName.StartsWith($fixturePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
        $records += [pscustomobject]@{component=$kind;processId=$candidate.ProcessId;module=$module.ModuleName;path=$module.FileName;appLocal=$local;version=$module.FileVersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $module.FileName -Algorithm SHA256).Hash.ToLowerInvariant()}
      }
    } catch { $ready = $false }
  }
  if ($ready) {
    $bad = @($records | Where-Object { -not $_.appLocal })
    $result = [pscustomobject]@{ok=($bad.Count -eq 0);fixture=$fixturePath;appDirectory=$appPath;checkedAt=[DateTime]::UtcNow.ToString('o');modules=$records;systemVcRuntimeUsed=($bad.Count -ne 0)}
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputFile -Encoding utf8
    $result | ConvertTo-Json -Depth 5
    if ($bad.Count -ne 0) { throw 'A required VC DLL was loaded from outside the isolated bundled workspace.' }
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
throw 'Could not observe all three owned native components with their VC dependencies.'
