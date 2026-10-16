$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$brandRoot = Split-Path -Parent $PSScriptRoot
$brandSourcePath = Join-Path $brandRoot 'assets/brand/readge-icon.png'
$brandSource = [System.Drawing.Image]::FromFile($brandSourcePath)
try {
    if ($brandSource.Width -ne $brandSource.Height) { throw 'readge icon must be square.' }
    $brandTargets = @(
        @{ Size = 256; Path = 'assets/brand/readge-icon-256.png' },
        @{ Size = 16; Path = 'public/brand/readge-icon-16.png' },
        @{ Size = 32; Path = 'public/brand/readge-icon-32.png' },
        @{ Size = 180; Path = 'public/brand/readge-icon-180.png' },
        @{ Size = 192; Path = 'public/brand/readge-icon-192.png' },
        @{ Size = 512; Path = 'public/brand/readge-icon-512.png' },
        @{ Size = 16; Path = 'extension/icons/icon-16.png' },
        @{ Size = 32; Path = 'extension/icons/icon-32.png' },
        @{ Size = 48; Path = 'extension/icons/icon-48.png' },
        @{ Size = 128; Path = 'extension/icons/icon-128.png' },
        @{ Size = 16; Path = 'desktop/resources/readge-icon-16.png' },
        @{ Size = 32; Path = 'desktop/resources/readge-icon-32.png' },
        @{ Size = 48; Path = 'desktop/resources/readge-icon-48.png' },
        @{ Size = 128; Path = 'desktop/resources/readge-icon-128.png' },
        @{ Size = 256; Path = 'desktop/resources/readge-icon-256.png' }
    )
    foreach ($brandTarget in $brandTargets) {
        $brandPath = Join-Path $brandRoot $brandTarget.Path
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $brandPath) | Out-Null
        $brandBitmap = [System.Drawing.Bitmap]::new($brandTarget.Size, $brandTarget.Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $brandGraphics = [System.Drawing.Graphics]::FromImage($brandBitmap)
        $brandAttributes = [System.Drawing.Imaging.ImageAttributes]::new()
        try {
            $brandGraphics.Clear([System.Drawing.Color]::Transparent)
            $brandGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $brandGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $brandGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $brandAttributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $brandRectangle = [System.Drawing.Rectangle]::new(0, 0, $brandTarget.Size, $brandTarget.Size)
            $brandGraphics.DrawImage($brandSource, $brandRectangle, 0, 0, $brandSource.Width, $brandSource.Height, [System.Drawing.GraphicsUnit]::Pixel, $brandAttributes)
            $brandBitmap.Save($brandPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $brandAttributes.Dispose()
            $brandGraphics.Dispose()
            $brandBitmap.Dispose()
        }
    }
    Write-Output 'readge application, browser, extension and desktop icons generated.'
} finally {
    $brandSource.Dispose()
}
