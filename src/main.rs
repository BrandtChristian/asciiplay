mod audio;
mod decode;
mod render;
mod source;
mod terminal;

use anyhow::{bail, Context, Result};
use audio::{Audio, PlaybackClock};
use clap::Parser;
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use decode::Decoder;
use render::{Layout, RenderMode};
use source::MediaSource;
use std::io::{BufWriter, IsTerminal, StdoutLock, Write};
use std::time::{Duration, Instant};

const DEFAULT_FPS: f64 = 24.0;
const DEFAULT_AUDIO_BUFFER_MILLISECONDS: u32 = 100;
const DUMP_FALLBACK_COLUMNS: u16 = 80;
const DUMP_FALLBACK_ROWS: u16 = 24;

/// How late a frame may be and still be worth drawing. Below this, drawing late looks better
/// than the stutter a drop produces.
const FRAME_DROP_LATENESS: f64 = 1.5;
/// Dragging a window edge emits resize events dozens of times a second, and each restart costs
/// an ffmpeg spawn, so wait for the drag to settle.
const RESIZE_DEBOUNCE: Duration = Duration::from_millis(180);
const STATUS_REFRESH: Duration = Duration::from_millis(250);
const PAUSE_POLL: Duration = Duration::from_millis(80);
const SEEK_STEP_SECONDS: f64 = 5.0;

#[derive(Parser, Debug)]
#[command(
    name = "asciiplay",
    about = "Play video as coloured ASCII art in the terminal"
)]
struct Cli {
    /// Local file path (URL support lands with the yt-dlp step)
    input: String,

    /// Single colour luminance ramp, no colour escapes at all
    #[arg(long, conflicts_with = "blocks")]
    mono: bool,

    /// Half block glyphs, doubling vertical resolution
    #[arg(long)]
    blocks: bool,

    /// Target frame rate, pinned in the ffmpeg filter graph
    #[arg(long, default_value_t = DEFAULT_FPS)]
    fps: f64,

    /// Terminal cell height divided by width. Raise it if the picture looks squashed
    #[arg(long, default_value_t = render::DEFAULT_CELL_HEIGHT_OVER_WIDTH)]
    cell_aspect: f64,

    /// How far two colours may differ before a new escape is emitted
    #[arg(long, default_value_t = render::DEFAULT_COLOUR_TOLERANCE)]
    tolerance: u8,

    /// Glyph ramp, darkest first. A preset (ascii, long, shades) or a literal string such as
    /// " .oO@". Ignored by --blocks, which paints half blocks rather than glyphs
    #[arg(long, default_value = "default", value_name = "SET")]
    charset: String,

    /// Start position in seconds
    #[arg(long, default_value_t = 0.0)]
    start: f64,

    /// Play without sound
    #[arg(long)]
    no_audio: bool,

    /// Shift audio against video. Positive means the picture arrives earlier
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    av_offset: f64,

    /// Override the detected terminal width. The strongest performance lever
    #[arg(long)]
    columns: Option<u16>,

    /// Override the detected terminal height
    #[arg(long)]
    rows: Option<u16>,

    /// Render N frames to stdout and exit, taking over nothing. Works without a terminal
    #[arg(long, value_name = "N")]
    dump_frames: Option<u32>,

    /// Measure how fast this terminal can absorb N frames, then report and exit
    #[arg(long, value_name = "N")]
    benchmark: Option<u32>,
}

impl Cli {
    fn mode(&self) -> RenderMode {
        if self.blocks {
            RenderMode::Blocks
        } else if self.mono {
            RenderMode::Mono
        } else {
            RenderMode::Colour
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if cli.fps <= 0.0 {
        bail!("--fps must be greater than zero");
    }
    if cli.cell_aspect <= 0.0 {
        bail!("--cell-aspect must be greater than zero");
    }

    let source = source::resolve(&cli.input)?;
    let mode = cli.mode();
    let ramp = render::resolve_charset(&cli.charset, mode)?;

    if let Some(frame_count) = cli.dump_frames {
        return dump(&cli, &source, mode, &ramp, frame_count);
    }

    // Rendering is hundreds of KB of escape sequences per frame. Piped into a file that is
    // gibberish, and inside a harness that captures stdout as text it would bury the session.
    if !std::io::stdout().is_terminal() {
        bail!("stdout is not a terminal; use --dump-frames N to render without one");
    }
    if std::env::var_os("CLAUDECODE").is_some() {
        bail!(
            "refusing to run inside Claude Code: this writes megabytes of escape sequences a \
             second. Run it in a real terminal, or use --dump-frames N here"
        );
    }

    let (terminal_columns, terminal_rows) =
        crossterm::terminal::size().context("could not read the terminal size")?;
    let layout = layout_for(&cli, &source, mode, terminal_columns, terminal_rows)?;

    if let Some(frame_count) = cli.benchmark {
        return benchmark(&cli, &source, mode, &layout, &ramp, frame_count);
    }
    eprintln!(
        "playing {} at {}x{} cells",
        source.label, layout.cell_columns, layout.cell_rows
    );
    play(
        &cli,
        &source,
        mode,
        &ramp,
        layout,
        terminal_columns,
        terminal_rows,
    )
}

fn layout_for(
    cli: &Cli,
    source: &MediaSource,
    mode: RenderMode,
    terminal_columns: u16,
    terminal_rows: u16,
) -> Result<Layout> {
    let columns = cli
        .columns
        .unwrap_or(terminal_columns)
        .min(terminal_columns);
    let rows = cli.rows.unwrap_or(terminal_rows).min(terminal_rows);
    Ok(render::fit(
        columns,
        rows,
        source.display_width,
        source.display_height,
        cli.cell_aspect,
        mode,
    )?)
}

fn spawn_decoder(
    cli: &Cli,
    source: &MediaSource,
    layout: &Layout,
    position_seconds: f64,
) -> Result<Decoder> {
    let args = decode::video_args(
        &source.video_input_args,
        layout.pixel_width,
        layout.pixel_height,
        cli.fps,
        position_seconds,
    );
    Decoder::spawn(&args, layout.frame_bytes())
}

fn dump(
    cli: &Cli,
    source: &MediaSource,
    mode: RenderMode,
    ramp: &[char],
    frame_count: u32,
) -> Result<()> {
    let detected = crossterm::terminal::size().ok();
    let columns = cli
        .columns
        .or(detected.map(|(columns, _)| columns))
        .unwrap_or(DUMP_FALLBACK_COLUMNS);
    let rows = cli
        .rows
        .or(detected.map(|(_, rows)| rows))
        .unwrap_or(DUMP_FALLBACK_ROWS);
    let layout = render::fit(
        columns,
        rows,
        source.display_width,
        source.display_height,
        cli.cell_aspect,
        mode,
    )?;

    let mut decoder = spawn_decoder(cli, source, &layout, cli.start)?;
    let mut frame = vec![0u8; layout.frame_bytes()];
    let mut encoded = Vec::new();
    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    for _ in 0..frame_count {
        if !decoder.read_frame(&mut frame)? {
            break;
        }
        render::encode_frame(&mut encoded, &layout, &frame, mode, ramp, cli.tolerance)?;
        out.write_all(&encoded)?;
        out.write_all(b"\n")?;
    }
    out.flush().context("flushing stdout")
}

/// Encode frames up front, then time only the writing, so the number measures the terminal
/// rather than us. Both design reviews called this the one measurement that decides the
/// defaults, because a truecolor frame is a few hundred KB of escapes and parsing them is the
/// slow step.
fn benchmark(
    cli: &Cli,
    source: &MediaSource,
    mode: RenderMode,
    layout: &Layout,
    ramp: &[char],
    frame_count: u32,
) -> Result<()> {
    println!(
        "encoding {frame_count} frames at {}x{} cells in {mode:?} mode...",
        layout.cell_columns, layout.cell_rows
    );
    let mut decoder = spawn_decoder(cli, source, layout, cli.start)?;
    let mut frame = vec![0u8; layout.frame_bytes()];
    let mut frames: Vec<Vec<u8>> = Vec::with_capacity(frame_count as usize);
    let mut colour_runs = 0usize;

    while frames.len() < frame_count as usize {
        if !decoder.read_frame(&mut frame)? {
            break;
        }
        let mut encoded = Vec::new();
        render::encode_frame(&mut encoded, layout, &frame, mode, ramp, cli.tolerance)?;
        colour_runs += count_occurrences(&encoded, b"\x1b[38;2;");
        frames.push(encoded);
    }
    if frames.is_empty() {
        bail!("decoded no frames to measure");
    }

    let total_bytes: usize = frames.iter().map(Vec::len).sum();
    let guard = terminal::TerminalGuard::activate()?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    let started = Instant::now();
    for encoded in &frames {
        out.write_all(encoded)?;
        out.flush()?;
    }
    let elapsed = started.elapsed().as_secs_f64();
    drop(out);
    drop(guard);

    let count = frames.len() as f64;
    println!("{} frames in {elapsed:.2}s", frames.len());
    println!("  {:.1} fps sustained", count / elapsed);
    println!(
        "  {:.1} MB/s, {:.0} KB per frame",
        total_bytes as f64 / elapsed / 1e6,
        total_bytes as f64 / count / 1024.0
    );
    println!("  {:.0} colour runs per frame", colour_runs as f64 / count);
    println!(
        "\nIf the sustained figure is well above your target fps, colour at this size is fine.\n\
         If it is below about 15, the levers are --fps, then --columns, then --mono.\n\
         Watch it as well as reading the number: a high figure with visibly juddery motion\n\
         means the terminal is parsing frames and discarding them before painting."
    );
    Ok(())
}

fn count_occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    haystack
        .windows(needle.len())
        .filter(|w| *w == needle)
        .count()
}

/// Everything that has to be torn down and rebuilt together when the position or the grid
/// changes. Seeking and resizing are the same operation applied for different reasons.
struct Playback {
    decoder: Decoder,
    audio: Option<Audio>,
    clock: PlaybackClock,
    origin_seconds: f64,
    frame_index: u64,
    fps: f64,
}

impl Playback {
    fn start(cli: &Cli, source: &MediaSource, layout: &Layout, position: f64) -> Result<Self> {
        // Audio first: it is the slower of the two to reach its device, so overlapping the two
        // warm-ups shortens the wait before the first frame.
        let audio = if cli.no_audio {
            None
        } else {
            // A busy or absent sound device is no reason to refuse to show the picture.
            Audio::start(
                &source.audio_target,
                position,
                DEFAULT_AUDIO_BUFFER_MILLISECONDS,
            )
            .ok()
        };
        let decoder = spawn_decoder(cli, source, layout, position)?;
        let clock = match &audio {
            Some(audio) => audio.clock(position, cli.av_offset),
            None => PlaybackClock::wall_only(position),
        };
        Ok(Self {
            decoder,
            audio,
            clock,
            origin_seconds: position,
            frame_index: 0,
            fps: cli.fps,
        })
    }

    /// The moment frame `frame_index` is due, counted from the start of the media.
    ///
    /// Timestamps restart at zero after an input seek, so this has to be measured from the
    /// position the decoder was started at. Using the raw frame count instead would inject a
    /// permanent offset on every seek and resize.
    fn next_frame_target(&self) -> f64 {
        self.origin_seconds + self.frame_index as f64 / self.fps
    }
}

fn play(
    cli: &Cli,
    source: &MediaSource,
    mode: RenderMode,
    ramp: &[char],
    mut layout: Layout,
    mut terminal_columns: u16,
    mut terminal_rows: u16,
) -> Result<()> {
    let guard = terminal::TerminalGuard::activate()?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());

    let mut playback = Playback::start(cli, source, &layout, cli.start)?;
    let mut frame = vec![0u8; layout.frame_bytes()];
    let mut encoded = Vec::new();

    let mut have_frame = false;
    let mut frame_target = 0.0;
    let mut dropped_frames = 0u64;
    let mut presented_since_status = 0u32;
    let mut measured_fps = 0.0;
    let mut last_status = Instant::now();
    let mut resize_due: Option<Instant> = None;

    'outer: loop {
        while event::poll(Duration::ZERO)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    // Raw mode suppresses SIGINT, so Ctrl-C arrives here or not at all.
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        break 'outer;
                    }
                    KeyCode::Char('q') | KeyCode::Esc => break 'outer,
                    KeyCode::Char(' ') => {
                        if playback.clock.is_paused() {
                            playback.clock.resume();
                            if let Some(audio) = &playback.audio {
                                audio.resume();
                            }
                        } else {
                            playback.clock.pause();
                            if let Some(audio) = &playback.audio {
                                audio.pause();
                            }
                        }
                    }
                    KeyCode::Left | KeyCode::Right if source.seekable => {
                        let step = if key.code == KeyCode::Right {
                            SEEK_STEP_SECONDS
                        } else {
                            -SEEK_STEP_SECONDS
                        };
                        let mut target = (playback.clock.position() + step).max(0.0);
                        if let Some(duration) = source.duration_seconds {
                            target = target.min((duration - 0.5).max(0.0));
                        }
                        playback = Playback::start(cli, source, &layout, target)?;
                        have_frame = false;
                        clear_screen(&mut out)?;
                    }
                    _ => {}
                },
                Event::Resize(columns, rows) => {
                    terminal_columns = columns;
                    terminal_rows = rows;
                    resize_due = Some(Instant::now() + RESIZE_DEBOUNCE);
                }
                _ => {}
            }
        }

        if resize_due.is_some_and(|due| Instant::now() >= due) {
            resize_due = None;
            match layout_for(cli, source, mode, terminal_columns, terminal_rows) {
                Ok(new_layout) => {
                    let position = playback.clock.position();
                    layout = new_layout;
                    frame = vec![0u8; layout.frame_bytes()];
                    // Only the video decoder restarts. Audio is never touched, so its clock
                    // carries straight through and a resize costs no sync at all.
                    let restart_at = if source.seekable { position } else { 0.0 };
                    playback.decoder = spawn_decoder(cli, source, &layout, restart_at)?;
                    playback.origin_seconds = position;
                    playback.frame_index = 0;
                    have_frame = false;
                    clear_screen(&mut out)?;
                }
                Err(error) => {
                    // Too small to draw in, but the audio is still playing, so say so and wait
                    // for the window to grow rather than dying.
                    clear_screen(&mut out)?;
                    write!(out, "\x1b[1;1H{error}")?;
                    out.flush()?;
                    resize_due = Some(Instant::now() + RESIZE_DEBOUNCE);
                    event::poll(PAUSE_POLL)?;
                    continue;
                }
            }
        }

        if playback.clock.is_paused() {
            render_status(
                &mut out,
                &playback,
                source,
                measured_fps,
                dropped_frames,
                terminal_rows,
                terminal_columns,
            )?;
            event::poll(PAUSE_POLL)?;
            continue;
        }

        if !have_frame {
            if !playback.decoder.read_frame(&mut frame)? {
                break 'outer;
            }
            frame_target = playback.next_frame_target();
            playback.frame_index += 1;
            have_frame = true;
        }

        let position = playback.clock.position();
        if position < frame_target {
            // poll doubles as the sleep, so a keypress during the wait is acted on at once
            // instead of up to a frame later.
            event::poll(Duration::from_secs_f64(frame_target - position))?;
            continue;
        }

        if position > frame_target + FRAME_DROP_LATENESS / cli.fps {
            dropped_frames += 1;
        } else {
            render::encode_frame(&mut encoded, &layout, &frame, mode, ramp, cli.tolerance)?;
            out.write_all(&encoded)?;
            presented_since_status += 1;
        }
        have_frame = false;

        if last_status.elapsed() >= STATUS_REFRESH {
            measured_fps = presented_since_status as f64 / last_status.elapsed().as_secs_f64();
            presented_since_status = 0;
            last_status = Instant::now();
            render_status(
                &mut out,
                &playback,
                source,
                measured_fps,
                dropped_frames,
                terminal_rows,
                terminal_columns,
            )?;
        }
        out.flush()?;
    }

    // Order matters: the writer flushes, then the guard puts the terminal back, and Playback's
    // own Drop kills the audio child last.
    drop(out);
    drop(guard);
    Ok(())
}

fn clear_screen(out: &mut BufWriter<StdoutLock<'_>>) -> Result<()> {
    out.write_all(b"\x1b[2J")?;
    Ok(())
}

fn render_status(
    out: &mut BufWriter<StdoutLock<'_>>,
    playback: &Playback,
    source: &MediaSource,
    measured_fps: f64,
    dropped_frames: u64,
    terminal_rows: u16,
    terminal_columns: u16,
) -> Result<()> {
    let line = render::format_status_line(
        playback.clock.position(),
        source.duration_seconds,
        measured_fps,
        dropped_frames,
        playback.clock.is_paused(),
        terminal_columns,
    );
    write!(out, "\x1b[{};1H\x1b[0m{line}\x1b[K", terminal_rows)?;
    out.flush()?;
    Ok(())
}
