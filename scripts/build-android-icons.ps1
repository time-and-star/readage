$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$brandRoot = Split-Path -Parent $PSScriptRoot
$brandSourceRelativePath = 'assets/brand/readge-icon.png'
$brandSourcePath = Join-Path $brandRoot $brandSourceRelativePath
$brandSource = [System.Drawing.Bitmap]::FromFile($brandSourcePath)

function Get-BrandSha256 {
    param([string]$Path)
    $brandStream = [System.IO.File]::OpenRead($Path)
    $brandHasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($brandHasher.ComputeHash($brandStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $brandHasher.Dispose()
        $brandStream.Dispose()
    }
}

function Save-AndroidIcon {
    param([string]$RelativePath, [int]$CanvasSize, [int]$ArtworkSize)
    $brandPath = Join-Path $brandRoot $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $brandPath) | Out-Null
    $brandBitmap = [System.Drawing.Bitmap]::new($CanvasSize, $CanvasSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $brandGraphics = [System.Drawing.Graphics]::FromImage($brandBitmap)
    $brandAttributes = [System.Drawing.Imaging.ImageAttributes]::new()
    try {
        $brandGraphics.Clear([System.Drawing.Color]::Transparent)
        $brandGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $brandGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $brandGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $brandAttributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $brandOffset = [int][Math]::Floor(($CanvasSize - $ArtworkSize) / 2)
        $brandRectangle = [System.Drawing.Rectangle]::new($brandOffset, $brandOffset, $ArtworkSize, $ArtworkSize)
        # Both axes use the same factor. Padding belongs to the Android canvas,
        # not to the logo, so the desktop and mobile artwork stay identical.
        $brandGraphics.DrawImage($brandSource, $brandRectangle, 0, 0, $brandSource.Width, $brandSource.Height, [System.Drawing.GraphicsUnit]::Pixel, $brandAttributes)
        $brandBitmap.Save($brandPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $brandAttributes.Dispose()
        $brandGraphics.Dispose()
        $brandBitmap.Dispose()
    }
    return [ordered]@{
        path = $RelativePath
        size = $CanvasSize
        artworkSize = $ArtworkSize
        sha256 = Get-BrandSha256 $brandPath
    }
}

try {
    if ($brandSource.Width -ne $brandSource.Height) { throw 'The shared readge icon must be square.' }
    foreach ($brandCorner in @(@(0, 0), @(($brandSource.Width - 1), 0), @(0, ($brandSource.Height - 1)), @(($brandSource.Width - 1), ($brandSource.Height - 1)))) {
        if ($brandSource.GetPixel($brandCorner[0], $brandCorner[1]).A -ne 0) { throw 'The shared readge icon must have a transparent exterior.' }
    }
    $brandDensities = @(
        @{ Name = 'mdpi'; Legacy = 48; Foreground = 108; Artwork = 64 },
        @{ Name = 'hdpi'; Legacy = 72; Foreground = 162; Artwork = 96 },
        @{ Name = 'xhdpi'; Legacy = 96; Foreground = 216; Artwork = 128 },
        @{ Name = 'xxhdpi'; Legacy = 144; Foreground = 324; Artwork = 192 },
        @{ Name = 'xxxhdpi'; Legacy = 192; Foreground = 432; Artwork = 256 }
    )
    $brandFrames = @()
    foreach ($brandDensity in $brandDensities) {
        $brandDirectory = "android/app/src/main/res/mipmap-$($brandDensity.Name)"
        # The Manifest selects these plain PNGs, with no adaptive XML variants.
        # AdaptiveIconDrawable can fill transparent backgrounds with an opaque
        # color; a bitmap keeps the shared logo's exterior alpha intact.
        $brandFrames += Save-AndroidIcon "$brandDirectory/readge_launcher.png" $brandDensity.Legacy $brandDensity.Legacy
        $brandFrames += Save-AndroidIcon "$brandDirectory/readge_launcher_round.png" $brandDensity.Legacy $brandDensity.Legacy
        foreach ($brandOldName in @('ic_launcher.png', 'ic_launcher_round.png')) {
            $brandOldPath = Join-Path $brandRoot "$brandDirectory/$brandOldName"
            if (Test-Path -LiteralPath $brandOldPath) { Remove-Item -LiteralPath $brandOldPath }
        }
        # Android layers are 108 dp; keep the complete shared source inside the
        # central 64 dp inside the 66 dp circular safe area. The small extra
        # inset keeps antialiased edge pixels clear of launcher masks.
        $brandFrames += Save-AndroidIcon "$brandDirectory/ic_launcher_foreground.png" $brandDensity.Foreground $brandDensity.Artwork
    }
    $brandFrames += Save-AndroidIcon 'android/app/src/main/res/drawable/readge_mark.png' 256 256
    $brandManifest = [ordered]@{
        schemaVersion = 2
        source = $brandSourceRelativePath
        sourceSha256 = Get-BrandSha256 $brandSourcePath
        launcher = [ordered]@{
            icon = 'mipmap/readge_launcher'
            roundIcon = 'mipmap/readge_launcher_round'
            drawableType = 'bitmap'
        }
        adaptiveLayerDp = 108
        adaptiveArtworkDp = 64
        frames = $brandFrames
    }
    $brandManifestPath = Join-Path $brandRoot 'assets/brand/readge-android-icon-manifest.json'
    $brandManifestJson = ($brandManifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($brandManifestPath, $brandManifestJson, [System.Text.UTF8Encoding]::new($false))
    Write-Output 'readge Android icons generated from the shared transparent logo at every density.'
} finally {
    $brandSource.Dispose()
}
