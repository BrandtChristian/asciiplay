# Development log

## 2026-09-08: SteamOS can build Rust with no C compiler, via static musl plus zig cc

Getting a toolchain onto this machine was the whole of the first session, and the answer is
worth writing down because none of it is guessable.

rustup installs cleanly into `~/.cargo`, which satisfies the immutable-root rule on its own. It
then warns that no `cc` exists, and that warning is the real problem: SteamOS ships `/usr/bin/ld`
and glibc's `crt1.o` and `libc.so`, but no compiler driver, and `pacman -S` is off limits because
the root filesystem is rebuilt bit-identically by every OS update.

Three routes were measured, in this order:

- **glibc plus `rust-lld` directly.** Fails on `-lgcc`, which is a static archive from the gcc
  package. Adding `-L/usr/lib` fixes `-lc` and `-ldl` but not that.
- **The same, with an empty `libgcc.a` shim.** This is the tempting one and it is a trap. It
  links with only a warning and produces a binary that **segfaults immediately**. Rust does
  supply its own intrinsics, but not everything `-lgcc` is standing in for. Do not revisit this.
- **The `x86_64-unknown-linux-musl` target.** Works first time. rustup ships a self-contained
  musl libc, so `rust-lld` links it with no system C toolchain at all, and the output is a
  `static-pie` binary.

That leaves one gap: build scripts and proc macros compile for the **host**, so they still need a
`cc`. Zig 0.16.0 fills it, unpacked into `~/.local/opt/zig` with a two line `zig-cc` wrapper on
PATH, because zig bundles its own libc and compiler-rt. Both settings live in
`.cargo/config.toml` with the reasoning attached.

**The transferable part:** on an immutable distribution, reach for the target that Rust can link
by itself before trying to reconstruct a system toolchain. Static musl needs nothing from `/usr`,
and a static binary is what you wanted on that kind of machine anyway.

## 2026-09-08: the cell-aspect maths, proved with a circle rather than argued about

A terminal cell is about twice as tall as it is wide, so scaling a frame naively onto
(columns, rows) stretches it vertically by 2x. Both design reviews flagged it independently, and
one noted the correction differs between modes, which is the part that is easy to get wrong:
half-block cells carry two stacked pixels, so each pixel is square again and the factor drops
out. The code therefore keeps **one cell grid for every mode** and changes only the pixel grid
asked of ffmpeg, which turned into the test that pins the whole thing.

The verification worth reusing: render a square source containing a circle. At `--cell-aspect 2.0`
it comes out 46 cells wide by 23 rows, which is 46/(23*2) = 1.00, and it reads as a circle. Forced
to 1.0 it becomes an obvious ellipse. An assertion about aspect error would have passed either
way, because the bug is in the constant and not the arithmetic.

## 2026-09-08: exact-match colour run collapsing is not worth having

Design intent was to skip the colour escape whenever a cell matched its neighbour exactly. An
adversarial review measured it on real photographic content downscaled to the actual cell grid,
and it barely does anything: adjacent cells share an exact RGB triple only about **1 percent** of
the time on detailed content, because each cell is an average of order a hundred source pixels
and averaging produces values that are almost never bit-identical to their neighbour.

Matching within a **tolerance of 8** instead collapses 74 to 99 percent of neighbours, for a mean
channel error of 2.2/255 that is invisible in a rendering which has already thrown away almost
all the detail. That is 4.6x fewer bytes and 5.6x fewer colour runs.

The related finding, kept because it prevented a wasted afternoon: **256-colour indexed escapes
are a dead end.** Shorter escapes, but measured at 152 KB per frame against 104 KB for truecolor
at tolerance 4, and with 25.7/255 of colour error. Worse on both axes. Not implemented.

**The objective function is run count, not byte count.** A terminal's cost is dominated by
distinct-colour text runs, since each one breaks the text run it is painting, and runs and bytes
can move independently.

## 2026-09-08: ffmpeg-sidecar dropped for plain Command

Started with the crate on the reasoning that it handles the stderr drain, which is a genuine
deadlock hazard: ffmpeg blocks once its stderr pipe fills, and the player hangs with no
explanation. The crate does solve that, but it learns the negotiated frame geometry by parsing
that same stderr, which means it cannot be run with `-loglevel error`.

We do not need it to. The frame size is exactly `width * height * 3` with no row padding, measured
directly, so `read_exact` into a reused buffer is complete and correct: short reads are a pipe
artefact it loops over internally, and `UnexpectedEof` means genuine end of stream. That plus a
20-line stderr drain thread is the whole requirement, with full control of the flags and one
fewer dependency.
