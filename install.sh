#!/bin/sh
# Install opensume, the Sume Open API CLI, on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/sumelabs/opensume-cli/main/install.sh | sh
#
# Settings (environment variables):
#   OPENSUME_VERSION         a release like 0.1.0 (default: the latest)
#   OPENSUME_INSTALL_DIR     where the binary goes (default: ~/.opensume/bin)
#   OPENSUME_NO_MODIFY_PATH  set to 1 to leave your shell profile alone
#
# The download is checked against the release's checksums.txt (SHA-256)
# before anything is installed.
set -eu

REPO="sumelabs/opensume-cli"
INSTALL_DIR="${OPENSUME_INSTALL_DIR:-$HOME/.opensume/bin}"

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')" DIM="$(printf '\033[2m')" RED="$(printf '\033[31m')" GREEN="$(printf '\033[32m')" RESET="$(printf '\033[0m')"
else
  BOLD="" DIM="" RED="" GREEN="" RESET=""
fi

say() { printf '%s\n' "$*"; }
fail() {
  printf '%serror%s: %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need curl
need uname
need mktemp

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
  *) fail "no prebuilt binary for $(uname -s); see https://github.com/$REPO#install for other ways" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) fail "no prebuilt binary for $(uname -m)" ;;
esac

# An Intel shell on Apple silicon (Rosetta) still gets the native binary.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  arch="arm64"
fi

if [ -n "${OPENSUME_VERSION:-}" ]; then
  version="${OPENSUME_VERSION#v}"
else
  # The /releases/latest page redirects to the newest tag; no API token needed.
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    fail "could not reach GitHub"
  version="${latest_url##*/tag/v}"
fi
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "no published release found at https://github.com/$REPO/releases" ;;
esac

# Alpine and other musl-based systems need the musl build.
libc=""
if [ "$os" = "linux" ]; then
  for loader in /lib/ld-musl-*; do
    [ -e "$loader" ] && libc="-musl"
    break
  done
fi

asset="opensume-$os-$arch$libc"
base="https://github.com/$REPO/releases/download/v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "${DIM}Downloading opensume $version ($os $arch${libc:+ musl})…${RESET}"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL --retry 3 -o "$tmp/checksums.txt" "$base/checksums.txt" || fail "download failed: $base/checksums.txt"

expected="$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/checksums.txt")"
[ -n "$expected" ] || fail "checksums.txt has no entry for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
else
  fail "need sha256sum or shasum to check the download"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset; nothing was installed"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/opensume"
say "${GREEN}✓${RESET} Installed ${BOLD}opensume $version${RESET} to $INSTALL_DIR/opensume"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

if [ "$on_path" = 0 ]; then
  line="export PATH=\"$INSTALL_DIR:\$PATH\""
  profile=""
  case "${SHELL:-}" in
    */zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ "$os" = "darwin" ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi ;;
    */fish)
      profile="$HOME/.config/fish/conf.d/opensume.fish"
      line="fish_add_path \"$INSTALL_DIR\""
      ;;
  esac
  if [ "${OPENSUME_NO_MODIFY_PATH:-0}" != "1" ] && [ -n "$profile" ]; then
    mkdir -p "$(dirname "$profile")"
    if ! grep -qsF "$INSTALL_DIR" "$profile"; then
      printf '\n# opensume\n%s\n' "$line" >>"$profile"
      say "${DIM}Added $INSTALL_DIR to PATH in $profile${RESET}"
    fi
    say ""
    say "Open a new terminal, or run:  $line"
  else
    say ""
    say "Add opensume to your PATH:  $line"
  fi
fi

say ""
say "Next: create a key at https://open.sume.com/api-keys, then"
say "  opensume auth login"
say "  opensume run gpt-image-2 \"a ceramic cup on a wooden table\" -q low"
