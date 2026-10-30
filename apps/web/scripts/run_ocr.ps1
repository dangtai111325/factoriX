$source = Get-Content "scripts/ImageOcrHelper.cs" -Raw

$winmdPath = "C:\Windows\System32\WinMetadata\Windows.Media.Ocr.winmd"
$winmdFoundation = "C:\Windows\System32\WinMetadata\Windows.Foundation.winmd"
$winmdGlobalization = "C:\Windows\System32\WinMetadata\Windows.Globalization.winmd"
$winmdGraphics = "C:\Windows\System32\WinMetadata\Windows.Graphics.winmd"
$winmdStorage = "C:\Windows\System32\WinMetadata\Windows.Storage.winmd"

$refs = @(
    "System.Runtime.WindowsRuntime",
    "System.Threading.Tasks",
    $winmdPath,
    $winmdFoundation,
    $winmdGlobalization,
    $winmdGraphics,
    $winmdStorage
)

Add-Type -TypeDefinition $source -ReferencedAssemblies $refs

$task = [ImageOcrHelper]::ProcessAll("C:\Users\Ave-T14-001\Downloads\images", "scripts/all_images_ocr.txt")
$res = $task.GetAwaiter().GetResult()
Write-Host $res
