# Minimal static server for fracture panel (wasm/onnx MIME + COOP/COEP for WASM threads).
$root = $PSScriptRoot
$port = 5173
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
Write-Host "serving http://127.0.0.1:$port/ (COOP/COEP on)"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.LocalPath.TrimStart('/'))
  if ([string]::IsNullOrEmpty($path)) { $path = "index.html" }
  $file = Join-Path $root ($path -replace '/', '\')
  if (-not (Test-Path $file) -or (Get-Item $file).PSIsContainer) {
    $ctx.Response.StatusCode = 404
    $buf = [Text.Encoding]::UTF8.GetBytes("404")
    $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
    $ctx.Response.Close()
    continue
  }
  $bytes = [IO.File]::ReadAllBytes($file)
  $ext = [IO.Path]::GetExtension($file).ToLower()
  $ctype = switch ($ext) {
    '.html' { 'text/html; charset=utf-8' }
    '.js' { 'text/javascript; charset=utf-8' }
    '.css' { 'text/css; charset=utf-8' }
    '.png' { 'image/png' }
    '.svg' { 'image/svg+xml' }
    '.json' { 'application/json' }
    '.wasm' { 'application/wasm' }
    '.onnx' { 'application/octet-stream' }
    default { 'application/octet-stream' }
  }
  $ctx.Response.ContentType = $ctype
  # SharedArrayBuffer / multi-thread ORT WASM (when threaded wasm is present)
  $ctx.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin"
  $ctx.Response.Headers["Cross-Origin-Embedder-Policy"] = "require-corp"
  $ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin"
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}
