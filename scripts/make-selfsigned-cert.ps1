# Generates a self-signed code signing certificate for LOCAL TESTING ONLY.
#
# A self-signed cert lets you verify that the signing pipeline works end to end,
# but it will NOT remove Windows SmartScreen warnings for your users — only a
# certificate issued by a recognized CA does that. See SIGNING.md for using a
# real certificate.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/make-selfsigned-cert.ps1

param(
  [string]$Subject  = "CN=TraceBox (Self-Signed Test)",
  [string]$OutDir   = "certs",
  [string]$Password = "tracebox-dev"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pfxPath = Join-Path $OutDir "tracebox-selfsigned.pfx"

Write-Host "Creating self-signed code signing certificate..."
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(3)

$securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null

# We only need the .pfx file; remove the cert from the user store to keep it clean.
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force

$resolved = (Resolve-Path $pfxPath).Path

Write-Host ""
Write-Host "Wrote $resolved"
Write-Host ""
Write-Host "To build a signed installer with this cert, run in PowerShell:"
Write-Host ""
Write-Host "  `$env:CSC_LINK = '$resolved'"
Write-Host "  `$env:CSC_KEY_PASSWORD = '$Password'"
Write-Host "  npm run dist"
Write-Host ""
Write-Host "NOTE: self-signed signatures do NOT bypass SmartScreen. See SIGNING.md."
