using System;
using System.IO;
using System.Collections.Generic;
using System.Threading.Tasks;
using Windows.Globalization;
using Windows.Media.Ocr;
using Windows.Graphics.Imaging;
using Windows.Storage;

public class ImageOcrHelper
{
    public static async Task<string> ProcessAll(string folderPath, string outputFile)
    {
        var lang = new Language("en-US");
        var engine = OcrEngine.TryCreateFromLanguage(lang);
        if (engine == null) return "No OCR engine";

        var files = Directory.GetFiles(folderPath, "*.png");
        Array.Sort(files);
        var linesOut = new List<string>();

        foreach (var file in files)
        {
            try
            {
                var sf = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(file));
                using (var stream = await sf.OpenAsync(FileAccessMode.Read))
                {
                    var decoder = await BitmapDecoder.CreateAsync(stream);
                    var bitmap = await decoder.GetSoftwareBitmapAsync();
                    var res = await engine.RecognizeAsync(bitmap);
                    var fileName = Path.GetFileName(file);
                    var textLines = res.Text.Replace("\r", "").Split('\n');
                    var top5 = new List<string>();
                    for (int i = 0; i < Math.Min(8, textLines.Length); i++)
                    {
                        if (!string.IsNullOrWhiteSpace(textLines[i]))
                            top5.Add(textLines[i].Trim());
                    }
                    linesOut.Add($"=== FILE: {fileName} ===");
                    linesOut.Add(string.Join(" // ", top5));
                    linesOut.Add("--- FULL TEXT ---");
                    linesOut.Add(res.Text);
                    linesOut.Add("\n");
                }
            }
            catch (Exception ex)
            {
                linesOut.Add($"=== FILE: {Path.GetFileName(file)} ERROR: {ex.Message} ===");
            }
        }

        File.WriteAllLines(outputFile, linesOut);
        return $"OK: {files.Length} files processed";
    }
}
