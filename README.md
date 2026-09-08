# asciiplay

Play an ordinary video as coloured ASCII art in the terminal, with synced audio.

```
asciiplay clip.mp4
asciiplay clip.mp4 --mono          # single colour, glyphs only
asciiplay clip.mp4 --blocks        # half block glyphs, double vertical resolution
```

## Requirements

ffmpeg (with ffprobe) on PATH. That is the only runtime dependency: the binary is statically
linked and needs nothing else.

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
