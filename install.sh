#!/bin/sh
# Install asciiplay: play video as coloured ASCII art in the terminal.
#
#   curl -fsSL https://raw.githubusercontent.com/BrandtChristian/asciiplay/main/install.sh | sh
#
# Installs a single static binary into ~/.local/bin. Nothing is installed system wide, and
# nothing else is installed without asking.

set -eu

REPO="BrandtChristian/asciiplay"
INSTALL_DIR="${ASCIIPLAY_INSTALL_DIR:-$HOME/.local/bin}"

# Colours only when stdout is a terminal, so a piped or logged run stays clean.
if [ -t 1 ]; then
    BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
    RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m')
    YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
    BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '  %s\n' "$*"; }
step() { printf '  %s%-9s%s %s\n' "$DIM" "$1" "$RESET" "$2"; }
fail() { printf '  %s%s%s %s\n' "$RED" "error" "$RESET" "$*" >&2; exit 1; }

printf '\n%sasciiplay%s\n\n' "$BOLD" "$RESET"

# ---- what are we running on ----------------------------------------------------------------

kernel=$(uname -s)
machine=$(uname -m)
case "$kernel/$machine" in
    Linux/x86_64|Linux/amd64)      asset="asciiplay-linux-x86_64" ;;
    Darwin/arm64|Darwin/aarch64)   asset="asciiplay-macos-arm64" ;;
    Darwin/x86_64)                 asset="asciiplay-macos-x86_64" ;;
    Linux/aarch64|Linux/arm64)
        fail "no prebuilt binary for Linux arm64 yet. Build it with: cargo install --git https://github.com/$REPO" ;;
    *)
        fail "unsupported platform: $kernel $machine" ;;
esac
step "detected" "$(printf '%s %s' "$kernel" "$machine" | tr '[:upper:]' '[:lower:]')"

# ---- fetch ---------------------------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
    download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    download() { wget -qO "$2" "$1"; }
else
    fail "need curl or wget"
fi

base="https://github.com/$REPO/releases/latest/download"
tmp=$(mktemp -d)
# Any exit path removes the scratch directory, including a failed download.
trap 'rm -rf "$tmp"' EXIT INT TERM

step "fetching" "$asset"
download "$base/$asset" "$tmp/$asset" \
    || fail "could not download $base/$asset (is there a published release yet?)"

# ---- verify --------------------------------------------------------------------------------

if download "$base/$asset.sha256" "$tmp/$asset.sha256" 2>/dev/null; then
    expected=$(awk '{print $1}' "$tmp/$asset.sha256")
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
    else
        actual=''
    fi
    if [ -z "$actual" ]; then
        step "checksum" "${YELLOW}skipped${RESET} (no sha256 tool found)"
    elif [ "$actual" = "$expected" ]; then
        step "checksum" "${GREEN}ok${RESET}"
    else
        fail "checksum mismatch: expected $expected, got $actual"
    fi
else
    step "checksum" "${YELLOW}unavailable${RESET}"
fi

# ---- install -------------------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/asciiplay"
step "installed" "$INSTALL_DIR/asciiplay"

case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
        printf '\n  %s%s is not on your PATH.%s Add this to your shell profile:\n\n' \
            "$YELLOW" "$INSTALL_DIR" "$RESET"
        # The literal $PATH is intended: this line is printed for the reader to paste.
        # shellcheck disable=SC2016
        printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
        ;;
esac

# ---- dependencies --------------------------------------------------------------------------

printf '\n'
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    step "ffmpeg" "${GREEN}found${RESET} ($(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}'))"
    ffmpeg_missing=0
else
    step "ffmpeg" "${RED}missing${RESET} (required)"
    ffmpeg_missing=1
fi

if command -v yt-dlp >/dev/null 2>&1; then
    step "yt-dlp" "${GREEN}found${RESET}"
    ytdlp_missing=0
else
    step "yt-dlp" "${DIM}missing${RESET} (optional, for URLs)"
    ytdlp_missing=1
fi

# The right command differs per platform, and guessing wrong is worse than saying nothing.
ffmpeg_hint=''
if command -v brew    >/dev/null 2>&1; then ffmpeg_hint="brew install ffmpeg"
elif command -v apt-get >/dev/null 2>&1; then ffmpeg_hint="sudo apt-get install ffmpeg"
elif command -v dnf     >/dev/null 2>&1; then ffmpeg_hint="sudo dnf install ffmpeg"
elif command -v pacman  >/dev/null 2>&1; then ffmpeg_hint="sudo pacman -S ffmpeg"
fi

ytdlp_hint="uv tool install yt-dlp"
command -v uv >/dev/null 2>&1 || ytdlp_hint="pipx install yt-dlp"

if [ "$ffmpeg_missing" = 1 ] || [ "$ytdlp_missing" = 1 ]; then
    printf '\n  %sto finish:%s\n' "$BOLD" "$RESET"
    if [ "$ffmpeg_missing" = 1 ]; then
        if [ -n "$ffmpeg_hint" ]; then
            printf '    %s\n' "$ffmpeg_hint"
        else
            printf '    install ffmpeg (no package manager detected)\n'
        fi
    fi
    [ "$ytdlp_missing" = 1 ] && printf '    %s%s%s\n' "$DIM" "$ytdlp_hint" "$RESET"
fi

# Deliberately not run for you: this script is piped into a shell from the internet, and
# invoking a package manager from inside that is more trust than it has earned.

printf '\n  %sready%s\n' "$GREEN" "$RESET"
say "asciiplay video.mp4"
say "${DIM}asciiplay video.mp4 --blocks     sharper${RESET}"
say "${DIM}asciiplay video.mp4 --benchmark 240     what your terminal can take${RESET}"
printf '\n'
