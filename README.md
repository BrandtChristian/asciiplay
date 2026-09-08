# asciiplay

Play an ordinary video as coloured ASCII art in the terminal, with synced audio.

```
asciiplay clip.mp4
asciiplay clip.mp4 --mono                 # single colour, glyphs only
asciiplay clip.mp4 --blocks               # half block glyphs, double vertical resolution
asciiplay "https://youtube.com/watch?v=..."
```

`q` or Escape quits, space pauses, the arrow keys seek five seconds.

Quotes around a URL are optional in bash, which passes `?` through untouched. Two exceptions
where the shell mangles the URL before this program ever sees it, so quoting is the fix:

- a URL containing `&`, such as `...?v=abc&t=42s`, because `&` means "run in the background" and
  everything after it is lost
- zsh, which refuses an unmatched `?` glob outright with "no matches found"

## Install

```
curl -fsSL https://raw.githubusercontent.com/BrandtChristian/asciiplay/main/install.sh | sh
```

Fetches a single static binary into `~/.local/bin`, verifies its checksum, then reports on
ffmpeg and yt-dlp and prints the one command each needs. It does not run your package manager
for you: this is a script piped into a shell from the internet, and that is more trust than it
has earned.

Linux x86_64 and macOS on both architectures. Anything else builds from source with
`cargo build --release`.

## Requirements

ffmpeg (with ffprobe) on PATH. That is the only runtime dependency: the binary is statically
linked and needs nothing else. URLs additionally need yt-dlp:

```
uv tool install yt-dlp
```

## Find out what your terminal can take

Throughput is limited by your terminal emulator rather than by this program, so measure it
instead of guessing:

```
asciiplay clip.mp4 --benchmark 240
```

That encodes 240 real frames, then times only the writing, and reports the sustained rate. Watch
it as well as reading the number: a high figure with visibly juddery motion means the terminal is
parsing frames and throwing them away before it paints them, so the real ceiling is its repaint
rate. If the answer disappoints, the levers in order of effect are `--fps`, then `--columns`,
then `--mono`.

## Building

```
cargo build --release
```

On SteamOS this needs no C compiler, which is deliberate. See `.cargo/config.toml`: the build
targets static musl, because rustup ships a self-contained musl libc that `rust-lld` can link
without gcc. Build scripts still compile for the host, so the host linker is `zig cc`. A static
binary is also the right artefact on a machine whose root filesystem is replaced by every OS
update.

## Notes

- **It will refuse to run without a real terminal.** Rendering is hundreds of KB of escape
  sequences per frame, which is meaningless piped into a file and actively destructive inside a
  tool that captures stdout as text. Use `--dump-frames N` to render without a terminal.
- **If the picture looks squashed or stretched, set `--cell-aspect`.** It is the ratio of your
  terminal cell's height to its width, and 2.0 suits most monospace fonts. The quick check is to
  play something round and adjust until it is round.
- **Throughput is limited by your terminal emulator, not by this program.** A frame is a few
  hundred KB of colour escapes, and parsing those is the slow step. `--fps`, `--columns` and
  `--mono` are the levers, in that order. Running inside tmux roughly halves what you get,
  because tmux parses every escape a second time.
