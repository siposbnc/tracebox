# Code Signing

TraceBox installers are signed via environment variables that `electron-builder`
reads automatically. **No certificate or password is ever stored in this
repository** — they are supplied at build time through the environment, and the
local cert files live under `certs/`, which is git-ignored.

If the signing environment variables are not set, `npm run dist` still produces a
working — but **unsigned** — installer. Unsigned installers trigger a Windows
SmartScreen warning ("Windows protected your PC") on first run.

## How signing is wired

`electron-builder` looks for two environment variables:

| Variable           | Meaning                                                        |
| ------------------ | ------------------------------------------------------------- |
| `CSC_LINK`         | Path to a `.pfx`/`.p12` file, **or** its base64-encoded bytes |
| `CSC_KEY_PASSWORD` | Password for that certificate                                  |

When both are present, the Windows build is signed automatically. There is
nothing certificate-specific committed in `electron-builder.yml`.

## Local testing with a self-signed certificate

A self-signed cert proves the pipeline works. It does **not** remove SmartScreen
warnings for end users — only a CA-issued certificate does that.

```powershell
# 1. Generate certs/tracebox-selfsigned.pfx (password: tracebox-dev)
powershell -ExecutionPolicy Bypass -File scripts/make-selfsigned-cert.ps1

# 2. Point electron-builder at it
$env:CSC_LINK = (Resolve-Path certs/tracebox-selfsigned.pfx).Path
$env:CSC_KEY_PASSWORD = "tracebox-dev"

# 3. Build the signed installer
npm run dist
```

You can confirm the signature on the output:

```powershell
Get-AuthenticodeSignature "release/TraceBox Setup 1.0.0.exe"
```

The status will be `UnknownError`/untrusted for a self-signed cert — that's
expected; it confirms a signature is present and the toolchain works.

## Using a real certificate later

Since TraceBox is published by an **individual** (not a registered company),
Extended Validation (EV) certificates and Azure Trusted Signing are not
available — both require a registered legal entity. The realistic path is an
**individual-validation OV (Organization/Individual Validation) certificate**,
e.g. from Sectigo (often resold by SSL.com, Certum, etc.).

Notes for that path:

- Since June 2023, CA rules require the private key to live on **hardware** (a
  USB token) or in a **cloud HSM**. You can no longer download a plain `.pfx`
  from the CA.
- **Certum** offers an inexpensive individual "Open Source Code Signing"
  certificate on a USB token that is well suited to solo/open-source projects.
- OV/individual certs build SmartScreen reputation gradually as downloads
  accumulate — early downloaders may still see a warning for a while. (EV certs
  get instant reputation, but require a company.)

### If your cert is a downloadable file (.pfx)

Set the same env vars as above to the real cert and password, then `npm run dist`.

### If your cert is on a hardware token / cloud HSM

`CSC_LINK` won't apply. You'll sign with the token's `signtool` integration via a
custom sign hook in `electron-builder.yml` (`win.signtoolOptions.sign`). Open an
issue / ask when you have the token in hand and we'll wire it up — the exact
steps depend on the CA's signing client (e.g. Certum SimplySign, SSL.com
eSigner cloud signing).

## CI signing (GitHub Actions)

When you set up automated release builds, store the certificate as repository
secrets and expose them to the build step — never commit them:

```yaml
env:
  CSC_LINK: ${{ secrets.CSC_LINK }}            # base64-encoded .pfx
  CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
```

To produce the base64 value for the `CSC_LINK` secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certs/your-cert.pfx")) > cert.b64.txt
```

Cloud-HSM/token certs cannot be used from a standard GitHub-hosted runner; they
require either a self-hosted runner with the token, or a cloud signing service
(Certum SimplySign, SSL.com eSigner, SignPath) invoked from a custom sign hook.
