# Raster (image) printing test for the SR588 (80mm Bluetooth mobile printer, COM8).
# Renders mixed Latin+Arabic to a monochrome bitmap via GDI+ (which shapes Arabic
# correctly), converts to an ESC/POS GS v 0 raster, saves a PNG preview, and streams
# it to the printer over the Bluetooth SPP serial port.

param(
  [string]$Port = 'COM8',
  [int]$Width = 576,          # 80mm printhead = 576 dots
  [int]$Threshold = 160,      # luminance < threshold => black dot
  [string]$FontName = 'Tahoma',
  [string]$PngOut = 'C:\Users\thris\AppData\Local\Temp\claude\C--Users-thris-Documents-cravings-v2\1c837f16-850c-4503-9171-d5a88a3fcf14\scratchpad\raster-preview.png',
  [switch]$NoPrint
)

Add-Type -AssemblyName System.Drawing

# ---- 1. Draw the receipt sample onto a bitmap ----
$H = 230
$bmp = New-Object System.Drawing.Bitmap $Width, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$black  = [System.Drawing.Brushes]::Black
$blackP = [System.Drawing.Pens]::Black
$fTitle = New-Object System.Drawing.Font($FontName, 18, [System.Drawing.FontStyle]::Bold)
$fBody  = New-Object System.Drawing.Font($FontName, 13)
$fBold  = New-Object System.Drawing.Font($FontName, 13, [System.Drawing.FontStyle]::Bold)

$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$right = New-Object System.Drawing.StringFormat
$right.Alignment = [System.Drawing.StringAlignment]::Far

$g.DrawString("AL BASHA", $fTitle, $black, (New-Object System.Drawing.RectangleF 0, 6, $Width, 34), $center)
$y = 48
$g.FillRectangle($black, 8, $y, ($Width - 16), 2); $y += 12
$g.DrawString("1 x Chicken Burger برجر دجاج", $fBold, $black, 8, $y); $y += 26
$g.DrawString("1 x Shrimp Burger برجر جمبري", $fBody, $black, 8, $y); $y += 26
$g.DrawString("1 x Fries Chicken بطاطس دجاج", $fBody, $black, 8, $y); $y += 26
$g.FillRectangle($black, 8, $y, ($Width - 16), 2); $y += 12
$g.DrawString("TOTAL:", $fBold, $black, 8, $y)
$g.DrawString("SAR 27.00", $fBold, $black, (New-Object System.Drawing.RectangleF 0, $y, ($Width - 8), 22), $right); $y += 30
$g.DrawString("شكرا لزيارتكم - Thank you", $fBody, $black, 8, $y)
$g.Flush()

if ($PngOut) { $bmp.Save($PngOut, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output "PNG saved: $PngOut" }

# ---- 2. Convert bitmap -> ESC/POS GS v 0 raster ----
$rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $H
$locked = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $locked.Stride
$total = $stride * $H
$pix = New-Object byte[] $total
[System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $pix, 0, $total)
$bmp.UnlockBits($locked)

$bytesPerRow = [int][Math]::Ceiling($Width / 8.0)
$out = New-Object System.Collections.Generic.List[byte]
$out.Add(0x1B); $out.Add(0x40)                                  # ESC @ init
$out.Add(0x1D); $out.Add(0x76); $out.Add(0x30); $out.Add(0x00)  # GS v 0 m
$out.Add([byte]($bytesPerRow -band 0xFF)); $out.Add([byte](($bytesPerRow -shr 8) -band 0xFF))
$out.Add([byte]($H -band 0xFF)); $out.Add([byte](($H -shr 8) -band 0xFF))

for ($row = 0; $row -lt $H; $row++) {
  $rowBase = $row * $stride
  for ($bx = 0; $bx -lt $bytesPerRow; $bx++) {
    $b = 0
    for ($bit = 0; $bit -lt 8; $bit++) {
      $x = ($bx * 8) + $bit
      if ($x -lt $Width) {
        $idx = $rowBase + ($x * 4)
        $lum = (0.114 * $pix[$idx]) + (0.587 * $pix[$idx + 1]) + (0.299 * $pix[$idx + 2])
        if ($lum -lt $Threshold) { $b = $b -bor (0x80 -shr $bit) }
      }
    }
    $out.Add([byte]$b)
  }
}
$out.Add(0x0A); $out.Add(0x0A); $out.Add(0x0A); $out.Add(0x0A)
$payload = $out.ToArray()

if ($NoPrint) { Write-Output "NoPrint set; built $($payload.Length) bytes ($Width x $H)"; return }

# ---- 3. Stream to the printer over Bluetooth SPP ----
try {
  $sp = New-Object System.IO.Ports.SerialPort $Port, 9600, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
  $sp.WriteTimeout = 8000
  $sp.Open()
  $offset = 0; $chunk = 1024
  while ($offset -lt $payload.Length) {
    $len = [Math]::Min($chunk, $payload.Length - $offset)
    $sp.Write($payload, $offset, $len)
    Start-Sleep -Milliseconds 60
    $offset += $len
  }
  Start-Sleep -Milliseconds 800
  $sp.Close()
  Write-Output "OK: sent $($payload.Length) raster bytes ($Width x $H) to $Port"
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
}
