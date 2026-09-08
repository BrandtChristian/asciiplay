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

## 2026-09-08: a committed .cargo/config.toml follows you onto CI

Nearly shipped a workflow that could never have passed. The reasoning went: `.cargo/config.toml`
holds this machine's musl and `zig cc` settings, CI is a normal glibc runner, therefore CI is
unaffected. Wrong. Cargo reads that file from the package directory wherever the repo is checked
out, so the runner would have tried to build for a musl target it does not have, with a linker
that is not installed.

The fix is that **environment variables take precedence over the config file**, so the workflow
sets `CARGO_BUILD_TARGET` and `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER` back to the
defaults. Verified locally rather than assumed: with those two variables set, the same tree
builds a dynamically linked glibc binary, and without them it still builds static musl.

**The general shape worth remembering:** a config file that encodes something about *this
machine* becomes a portability bug the moment it is committed, and the compiler cannot warn you
because on the machine that wrote it everything is correct. The environment-variable escape hatch
is the thing to look for, and the honest test is to reproduce the other machine's settings
locally before pushing.

## 2026-09-08: YouTube returns two URLs, needs no headers today, and hands you AV1 unless you ask

Wiring up URL input turned up three things, two of which contradicted the plan.

**Two URLs is the good case, not an edge case.** `yt-dlp` with a merge format selection prints
the video-only URL then the audio-only URL, and since this design already runs a separate ffmpeg
per track, each process fetches exactly the bytes it needs. A single progressive URL still works
and simply goes to both. The parser therefore branches on the count rather than assuming either.

**Headers turned out not to be needed.** Both reviews warned that googlevideo URLs are signed
against the requesting client and that ffmpeg's `Lavf/` user agent can draw a 403, so the plan
carried machinery to extract `http_headers` and translate them into `-user_agent` and `-headers`.
Measured instead of assumed: `ffprobe` opens the resolved URL bare, exit 0, correct stream info.
So none of that was written. `%(http_headers.User-Agent)s` also resolves to `NA` at the top level,
because the headers live per-format, which is a second reason the shortcut would not have worked.
If a 403 does start appearing, `yt-dlp -J` plus the per-format headers is the fix.

**The format selection needs a codec preference, not just a height cap.** Capping at 720p still
gets AV1, because that is YouTube's default at that height now, and this APU has no AV1 hardware
decoder, so software decode would cost more CPU than the entire renderer. Asking for
`bv*[height<=720][vcodec^=avc1]` first drops to H.264 and falls back gracefully. Verified: the
selection goes from `av01.0.08M` to `avc1.4d4020`.

**On sentinel prefixes:** every field is printed as `asciiplay-<name>:<value>` rather than relying
on line order, so adding a field later cannot silently shift the parse. yt-dlp writes the literal
string `NA` for anything the extractor did not fill in, which has to be filtered or a duration of
`NA` becomes a title.

## 2026-09-08: the same portability bug twice, and the second time the fix was to stop patching it

The first release build failed on all three targets, for two unrelated reasons.

**macOS: `prctl` and `PR_SET_PDEATHSIG` are Linux only.** So is ffmpeg's `pulse` muxer, and its
`-buffer_duration` option, which AudioToolbox rejects. Both are now behind
`#[cfg(target_os = ...)]`, with the audio sink chosen per platform. Worth stating plainly: the
macOS audio path is written but **unverified**, since no Mac was available. It degrades to silent
video rather than to a crash, because `Audio::start(..).ok()` already treats an audio failure as
"play the picture anyway". The compile itself is verified without a Mac, via
`rustup target add aarch64-apple-darwin` and `cargo check --target`, which does not link and so
catches exactly this class of mistake for the price of a download.

**Linux: the committed `.cargo/config.toml` struck a second time, and the earlier fix was the
problem.** That fix set `CARGO_TARGET_..._LINKER` to override the config file, and it worked, so
the entry above declared victory. But the file also sets `rustflags`, and the environment
variable overrode only the linker. So rustc happily passed `--as-needed` and `--eh-frame-hdr`,
which are ld flags, to `musl-gcc`, which is a gcc driver and wants them `-Wl,` prefixed.

The real fix is the one the earlier entry described and did not take: **machine settings do not
belong in a repository.** They moved to `~/.cargo/config.toml`, the repo file is gone, and both
workflows lost their override blocks entirely. The release job is now one line, `cargo build
--release --target ${{ matrix.target }}`, with nothing to remember.

**The lesson, sharpened:** when a config leaks somewhere it should not, overriding it at the
destination is a patch and the leak will find another route. There were two settings in that file
and the patch covered one. Ask instead where the setting belongs, and put it there.
