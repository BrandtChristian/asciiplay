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

## 2026-09-08: the web version, and why dropping YouTube made it better

The browser player was going to resolve YouTube URLs server side and proxy the video bytes. Two
measurements killed that before any of it was written, and the feature was dropped on Christian's
call once they were in.

**googlevideo sends no `Access-Control-Allow-Origin` header at all.** Verified with a resolved
URL and an `Origin` header: 200, correct content type, `Accept-Ranges: bytes`, and no CORS header
of any kind. A browser can therefore *play* such a URL but cannot read pixels from it, because
the canvas is tainted and `getImageData` throws. So the design needed every video byte proxied
through the server purely to add a header.

**The second cost was YouTube's own posture toward datacenters**, which throttles and 403s them
and increasingly wants a PO token, so the feature would have been the flakiest part of the site
while also being the only part that cost money and touched other people's copyright.

Dropping it deleted the resolver function, the byte proxy, the Python runtime, the bandwidth
bill and the rate limiting in one move, and **the app became fully static**. The CLI keeps its
YouTube support, which is a different proposition: the user's own machine, their own IP, their
own yt-dlp.

**The drawing trick worth remembering.** Painting coloured ASCII the obvious way is one
`fillText` per cell, which is about 4000 canvas calls a frame. Instead: draw the glyphs as white
text on one canvas, **one `fillText` per row** (monospace guarantees the columns line up), draw
the cell grid on another with `imageSmoothingEnabled = false`, then composite the two with
`globalCompositeOperation = "multiply"`. White times colour is colour, black times anything is
black, so you get glyph shaped colour from about 40 draw calls. Measured 60fps at 110x31 cells,
which is the browser's own frame cap rather than ours. Half-block mode then falls out for free:
it is the colour field alone at double vertical resolution, with no glyphs at all.

**What only a real browser could catch.** Two defects survived a green unit suite and a clean
typecheck. The render loop wrote a ref during render, which the React lint caught but which was
also genuinely wrong. And a `button:hover:not(:disabled)` rule outranks `button[aria-pressed]`
on specificity, so hovering the active control painted amber text on an amber ground and the
label vanished. Both are now guarded by end to end tests, and the second one is the reason there
is an assertion that no pressed button's text colour equals its background.

**The demo clip was measured, not chosen.** The first cut averaged luma 59 out of 255 and looked
like a dim smudge, because ASCII of a shaded forest is mostly the dark end of the ramp working
correctly. Sampling nine timestamps for mean luminance and saturation found a passage at 152 and
58, and the same code suddenly looked good. Worth generalising: when a renderer looks bad, check
the input's statistics before changing the renderer.

## 2026-09-09: the macOS audio path, verified at last, and index 0 is not the default device

A Mac was finally available, so the path that shipped marked UNTESTED got tested. It was broken,
and the way it was broken is the interesting part.

**A CoreAudio device index is not a preference order.** The sink was hardcoded to `0`, written as
if it meant "the default output". It does not. It is the first device CoreAudio happens to
enumerate, and on this machine that is the DELL monitor, where `AudioQueueStart` fails after a
ten second stall and ffmpeg exits 234 having emitted a single `out_time_us=N/A`. Measured
against the enumeration: index `2` (the built-in speakers) plays, index `1` (a microphone) fails
in 0.1s, index `0` stalls then fails. So the mechanism was right, the URL genuinely is a device
index, and only the value was wrong.

The fix is to pass `-`, which leaves `audio_device_index` at its default of -1 so the muxer
follows the system default output. That is also the form ffmpeg's own documentation uses, and it
is better than any index we could pick, because it follows the output the user has chosen.

**The earlier entry described the wrong failure mechanism, and it matters.** It said a wrong sink
means the audio process fails to start, `Audio::start(..).ok()` yields None, and the video plays
silently. The spawn actually succeeds: ffmpeg starts fine and fails later, when the muxer opens
the device. The graceful degradation is real but arrives by another route, namely that no
progress line ever parses, the anchor stays empty, and `PlaybackClock` falls through to wall
time. Same visible outcome, completely different place to put a breakpoint.

**How to test an audio path in an open office.** Build the fixture's audio track from
`anullsrc`, so it is digital silence. That exercises the whole path, device open, sample pacing,
progress output, anchor, and makes no sound. The proof the device is really consuming is the wall
clock: an 8 second clip takes 8.1 seconds, where decoding alone would finish instantly. Only the
final question, whether sound is audible, needs a human and a single deliberate run.

**A flag both branches honour cannot tell you which branch ran.** The plan was to prove the audio
clock was driving the video by passing `--av-offset -2` and watching playback finish early. It
does finish early, and it proves nothing: `position_at` subtracts `offset_seconds` in the anchor
branch *and* in the wall-time fallback, so the broken binary shortens by exactly the same amount.
The honest answer was a throwaway instrumented build printing each parsed anchor, which showed 15
anchors climbing 0.619 to 7.659 across the clip with the fix, and none without audio.

**A tag is not a release.** `v0.1.0` pointed six commits behind main, so `install.sh` was serving
a binary that rejected the README's own `--charset` examples with "unexpected argument". The
README and the shipped artefact drifted apart silently, because nothing checks one against the
other. Worth a glance at `git log <tag>..main` before pointing anyone at an install line.

**Driving a TUI from a harness on macOS.** `script` cannot help: it calls `tcgetattr` on its own
stdin, which is a socket under a tool runner, and dies. `pty.openpty` plus a `TIOCSWINSZ` ioctl
for the window size works, and being able to write into the master fd is what let the transport
controls be tested at all. Verified this way: quit, Esc, pause and resume, seek in both
directions, seeking past the end ending playback, alternate screen entered and left exactly once,
cursor restored, and no ffmpeg left behind.

## 2026-09-09: the GIF byte estimate, calibrated twice, because the first pass fixed the constant and left the model wrong

`GIF_BYTES_PER_CELL` shipped in Task 4 as an admitted guess of 0.5, with a comment asking for a
real measurement before anyone trusted it. Task 5 added the GIF encoder itself (gifenc, quantised
to 256 colours per frame), so there was finally something real to measure it against.

**First pass, and why it looked right.** The model was `frameCount * cellColumns * cellRows *
BYTES_PER_CELL`, bytes per grid cell. Measured against one export, big-buck-bunny.mp4 from 8s to
13s at the default 110 columns (60 frames at 110x31 cells): the file was 8,050,633 bytes, which
is 39.35 bytes per cell rather than 0.5. The constant was corrected to 40 and every gate,
including a ceiling test, passed. It looked calibrated because it was measured against a real
export, but it was calibrated at exactly one column count, and a per-cell model has no way to be
wrong at the one point it was fit to.

**Second pass, at a second column count, is where it fell apart.** Measuring 60 columns instead of
110 gave 1,140x646 pixels at 12 frames, actual size 1,310,981 bytes. The per-cell model, corrected
constant and all, predicted a small fraction of that and rounded to "~0MB" in the readout, an
estimate telling the user an export is free when it is 1.25MB. The reason: `cellWidth =
floor(shellWidth / columns)`, so the exported width is `cellColumns * cellWidth`, which lands back
near the player's own width whatever `columns` is. Fewer columns does not shrink the output, it
makes each cell chunkier (1,140x646 at 60 columns is actually slightly *larger* than 1,100x620 at
110). GIF bytes are driven by pixel area, which barely moves with `columns`, not by cell count,
which moves a lot. Calibrating one point of a model that is wrong along an axis you never varied
makes that model look right exactly where you measured it, and nowhere else. That is the sharper
version of this entry's title, and the actual lesson.

**The fix:** `estimatedBytes`'s GIF branch is now `frameCount * width * height *
GIF_BYTES_PER_PIXEL`, taking the export's pixel width and height (which the callers already
compute) rather than the cell grid. Three real exports of big-buck-bunny.mp4, all a 1 second range
except where noted:

- 1,100x620 (110 columns), 12 frames, 1,752,921 bytes: 0.2142 bytes/pixel
- 1,140x646 (60 columns), 12 frames, 1,310,981 bytes: 0.1483 bytes/pixel
- 1,100x620 (110 columns), 60 frames (8s to 13s range), 8,050,633 bytes: 0.1967 bytes/pixel

**Chosen constant: 0.21 bytes per pixel**, the top of that range rather than the mean, for the
same reason as the first pass's rounding: this number feeds `exceedsCeiling`'s refusal, and
overestimating means an occasional borderline GIF gets refused when it would have fit, while
underestimating means a GIF that will not fit sails past the refusal and a tab is left building
one that wedges it. Checked back against reality by exporting a 1 second range at both column
counts and reading the live estimate before each export: 110 columns showed "~2MB" against an
actual 1,752,921 bytes (about 20% over), 60 columns showed "~2MB" against an actual 1,310,981
bytes (about 42% over). Both real files, neither rounded away to "~0MB".

**The estimate display also stopped lying about small files.** Rounding a sub-1MB estimate to
whole megabytes is how a 1.25MB file became "~0MB" above; the readout now shows kilobytes below
the 1MB threshold instead of rounding a real file down to nothing.

**Guarded against regressing silently.** `timeline.test.ts` now pins `estimatedBytes` against all
three measured points above, asserting each prediction lands within 45% of the real size (the
60-column point runs 42% over by design, since the constant is calibrated to the top of the
range rather than the mean, so a strict 40% band would fail on that one point specifically). This
is the test that would have caught the per-cell model in the first place, since 0.5 bytes per
cell missed these same three points by 13x to 79x, nowhere near even a loose band. The existing
ceiling test needed its inputs changed for the new pixel-based signature, not its assertions
weakened: it now checks 12 frames versus 200 frames at the real 1,100x620 resolution rather than
arbitrary cell counts.
