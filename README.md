# asciiplay

Play an ordinary video as coloured ASCII art in the terminal, with synced audio.

```
asciiplay clip.mp4
asciiplay clip.mp4 --mono                 # single colour, glyphs only
asciiplay clip.mp4 --blocks               # half block glyphs, double vertical resolution
asciiplay "https://youtube.com/watch?v=..."
```

`q` or Escape quits, space pauses, the arrow keys seek five seconds.

## Charsets

The glyph ramp is yours to choose, darkest first:

```
asciiplay clip.mp4 --charset shades      # ░▒▓█, much more saturated
asciiplay clip.mp4 --charset long        # a 58 level ramp, most detail
asciiplay clip.mp4 --charset " .oO@"     # anything you like
```

`ascii` is the default and nothing changes unless you ask. `shades` uses Unicode Block Elements,
which carry far more ink than ASCII punctuation and so read as a much more solid picture. That is
a different axis from `--blocks`, which buys vertical resolution rather than density, and the two
compose.

Every glyph must occupy exactly one terminal cell. A wide or zero width character is refused
rather than accepted, because it would push the rest of its row out of step with the colour grid
and the damage is invisible in the code that emits it.

Quotes around a URL are optional in bash, which passes `?` through untouched. Two exceptions
where the shell mangles the URL before this program ever sees it, so quoting is the fix:

- a URL containing `&`, such as `...?v=abc&t=42s`, because `&` means "run in the background" and
  everything after it is lost
- zsh, which refuses an unmatched `?` glob outright with "no matches found"

## Try it without installing anything

There is a browser version that renders ASCII from any video you drop on it. The file is read
locally and never uploaded, which is the whole reason it has no server: the page is static.

It has live controls (mode, charset, width, speed, sound), a transport, and exports to WebM, PNG,
plain text and an asciinema `.cast` that replays in a real terminal. The source lives in `web/`.

## Install

```
curl -fsSL https://asciiplay.vercel.app/install.sh | sh
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

Nothing special is required on an ordinary machine with a C toolchain.

**On a distribution with an immutable root** (SteamOS, and the same applies to any system where
you cannot install gcc) you can still build with no C compiler at all, but the settings belong in
`~/.cargo/config.toml` rather than in this repo, because they describe the machine and not the
code:

```toml
[build]
target = "x86_64-unknown-linux-musl"

[target.x86_64-unknown-linux-musl]
linker = "rust-lld"
rustflags = ["-C", "linker-flavor=ld.lld"]

[target.x86_64-unknown-linux-gnu]
linker = "zig-cc"
```

rustup ships a self-contained musl libc that `rust-lld` links with no system C toolchain, which
also yields a static binary, the right artefact on a machine whose libraries are replaced
wholesale by every OS update. Build scripts still compile for the host, so the host linker is a
two line wrapper around `zig cc`, which brings its own libc and compiler-rt.

## Platform support

Linux x86_64 is what this is developed on. **macOS arm64 is verified** on macOS 26.6: install,
playback, the transport controls, seeking and the audio path. ffmpeg's PulseAudio output does not
exist there, so it uses AudioToolbox, which is pointed at no particular device and so follows
whatever output you have selected in the system. macOS x86_64 is built and released but has not
been run on hardware. Reports welcome.

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
