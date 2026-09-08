mod decode;
mod render;
mod source;

use anyhow::{bail, Context, Result};
use clap::Parser;
use render::RenderMode;
use std::io::{IsTerminal, Write};

const DEFAULT_FPS: f64 = 24.0;
const DUMP_FALLBACK_COLUMNS: u16 = 80;
const DUMP_FALLBACK_ROWS: u16 = 24;

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

    /// Start position in seconds
    #[arg(long, default_value_t = 0.0)]
    start: f64,

    /// Override the detected terminal width
    #[arg(long)]
    columns: Option<u16>,

    /// Override the detected terminal height
    #[arg(long)]
    rows: Option<u16>,

    /// Render N frames to stdout and exit, taking over nothing. Works without a terminal
    #[arg(long, value_name = "N")]
    dump_frames: Option<u32>,
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

    let Some(frame_count) = cli.dump_frames else {
        // Live playback arrives in the next step. Refusing here rather than half playing keeps
        // the failure obvious, and the guard below is the one that matters either way.
        if !std::io::stdout().is_terminal() {
            bail!("stdout is not a terminal; use --dump-frames N to render without one");
        }
        bail!("live playback is not wired up yet; use --dump-frames N for now");
    };

    let (terminal_columns, terminal_rows) = dump_dimensions(&cli);
    let layout = render::fit(
        terminal_columns,
        terminal_rows,
        source.display_width,
        source.display_height,
        cli.cell_aspect,
        mode,
    )?;

    let args = decode::video_args(
        &source.video_input_args,
        layout.pixel_width,
        layout.pixel_height,
        cli.fps,
        cli.start,
    );
    let mut decoder = decode::Decoder::spawn(&args, layout.frame_bytes())?;

    let mut frame = vec![0u8; layout.frame_bytes()];
    let mut encoded = Vec::with_capacity(layout.frame_bytes() * 4);
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());

    for _ in 0..frame_count {
        if !decoder.read_frame(&mut frame)? {
            break;
        }
        render::encode_frame(&mut encoded, &layout, &frame, mode, cli.tolerance)?;
        out.write_all(&encoded).context("writing a frame")?;
        out.write_all(b"\n").context("writing a frame")?;
    }
    out.flush().context("flushing stdout")?;
    Ok(())
}

/// Pick a grid for dump mode, where there may well be no terminal to ask.
fn dump_dimensions(cli: &Cli) -> (u16, u16) {
    let detected = crossterm::terminal::size().ok();
    let columns = cli
        .columns
        .or(detected.map(|(columns, _)| columns))
        .unwrap_or(DUMP_FALLBACK_COLUMNS);
    let rows = cli
        .rows
        .or(detected.map(|(_, rows)| rows))
        .unwrap_or(DUMP_FALLBACK_ROWS);
    (columns, rows)
}
