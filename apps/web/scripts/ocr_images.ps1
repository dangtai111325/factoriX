Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null

function Await-Async($asyncOp) {
    return [System.WindowsRuntimeSystemExtensions]::AsTask($asyncOp).GetAwaiter().GetResult()
}

$lang = [Windows.Globalization.Language]::new("en-US")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)

if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

if (-not $engine) {
    Write-Host "ERROR: No WinRT OCR engine available."
    exit 1
}

Write-Host "OCR Engine initialized successfully: $($engine.RecognizerLanguage.DisplayName)"

$files = Get-ChildItem "C:\Users\Ave-T14-001\Downloads\images\*.png" | Sort-Object Name
$results = @()

foreach ($file in $files) {
    try {
        $storageFile = Await-Async ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file.FullName))
        $stream = Await-Async ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read))
        $decoder = Await-Async ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
        $bitmap = Await-Async ($decoder.GetSoftwareBitmapAsync())
        $ocrResult = Await-Async ($engine.RecognizeAsync($bitmap))
        
        $text = $ocrResult.Text
        $lines = $text -split "`r?`n"
        $topLines = $lines | Select-Object -First 8
        
        $results += [PSCustomObject]@{
            File = $file.Name
            TopLines = ($topLines -join " // ")
            FullText = $text
        }
        Write-Host "OK: $($file.Name) -> $($topLines[0])"
    } catch {
        Write-Host "ERR: $($file.Name): $_"
    }
}

$results | ConvertTo-Json -Depth 4 | Out-File -FilePath "scripts/ocr_results.json" -Encoding utf8
Write-Host "Done! Saved $($results.Count) results to scripts/ocr_results.json"
