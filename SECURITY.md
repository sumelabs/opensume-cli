# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

- **Preferred:** [open a private advisory](https://github.com/sumelabs/opensume-cli/security/advisories/new) on this repository.
- **Or email** support@sume.com with "security" in the subject.

Tell us what you found, how to reproduce it, and what it affects. We aim to answer within three business days. We will keep you updated until it is fixed, and credit you in the release notes if you want.

This policy covers the CLI in this repository: the code, the install scripts and the release binaries. If the problem is in the Sume Open API or open.sume.com, report it the same way and we will route it.

## Supported versions

Fixes land in the latest release. Run `opensume update` (standalone installs) or reinstall to get them.

## How the CLI handles your key

- It sends the key only to the API host you configure (`https://api.dev.sume.com` by default), in an `Authorization` header.
- It never sends the key to storage upload URLs or media URLs.
- `opensume auth login` stores the key in a config file that only your user can read (mode `0600`). It does not encrypt the key, so treat that file like an SSH key. `SUME_API_KEY` in the environment avoids storing it at all.
- It never prints the full key. `opensume auth status` shows the same prefix and last four characters as the API keys page.
- It collects no telemetry and checks for updates only when you run `opensume update`.

## Release integrity

Every release asset is listed in `checksums.txt` (SHA-256) and carries a GitHub build provenance attestation. The install scripts refuse a binary whose checksum does not match. To check a download by hand:

```sh
gh attestation verify opensume-darwin-arm64 --repo sumelabs/opensume-cli
```
