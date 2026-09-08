use std::fmt;

// A terminal cell is roughly twice as tall as it is wide, so a picture scaled naively onto
// (columns, rows) comes out vertically stretched by 2x. Fonts differ, hence the override.
pub const DEFAULT_CELL_HEIGHT_OVER_WIDTH: f64 = 2.0;
pub const STATUS_LINE_ROWS: u16 = 1;
pub const MINIMUM_CELL_COLUMNS: u16 = 20;
pub const MINIMUM_CELL_ROWS: u16 = 10;

// In colour mode the colour carries the picture, so a dense ramp only adds noise: ten levels
// is enough. In mono the glyph is the only channel there is, so the long ramp earns its keep.
pub const COLOUR_GLYPH_RAMP: &[u8] = b" .:-=+*#%@";
pub const MONO_GLYPH_RAMP: &[u8] = b" .`^\":;!~+?][}{)(|\\/tfjrxnuvczYUJCLQ0Zmwqpdbkhao*#MW&8%B@$";

// Adjacent cells almost never share an exact RGB triple once a frame has been downscaled,
// because each cell is an average of order a hundred source pixels. Measured on real footage:
// only about 1 percent of neighbours match exactly on detailed content, so exact-match run
// collapsing saves almost nothing. Matching within a tolerance instead collapses 74 to 99
// percent of neighbours for a mean channel error around 2/255, which is invisible here.
pub const DEFAULT_COLOUR_TOLERANCE: u8 = 8;

// Rec. 709 luma in 8 bit fixed point. These sum to exactly 256, which is what makes pure white
// land on exactly 255 rather than 254 and lets the whole pixel path stay in integers.
const LUMA_WEIGHT_RED: u32 = 54;
const LUMA_WEIGHT_GREEN: u32 = 183;
const LUMA_WEIGHT_BLUE: u32 = 19;
const LUMA_SHIFT: u32 = 8;

const BYTES_PER_PIXEL: usize = 3;

// Only the upper half block is ever needed: foreground paints the top pixel and background
// paints the bottom one, so U+2584 and U+2588 would be redundant with that pairing.
const UPPER_HALF_BLOCK: &[u8] = "\u{2580}".as_bytes();
const SGR_RESET: &[u8] = b"\x1b[0m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderMode {
    Colour,
    Mono,
    Blocks,
}

impl RenderMode {
    fn vertical_pixels_per_cell(self) -> u32 {
        match self {
            RenderMode::Blocks => 2,
            RenderMode::Colour | RenderMode::Mono => 1,
        }
    }

    fn glyph_ramp(self) -> &'static [u8] {
        match self {
            RenderMode::Mono => MONO_GLYPH_RAMP,
            RenderMode::Colour | RenderMode::Blocks => COLOUR_GLYPH_RAMP,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub cell_columns: u16,
    pub cell_rows: u16,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub left_pad_cells: u16,
    pub top_pad_rows: u16,
}

impl Layout {
    pub fn frame_bytes(&self) -> usize {
        self.pixel_width as usize * self.pixel_height as usize * BYTES_PER_PIXEL
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct TerminalTooSmall {
    pub needed_columns: u16,
    pub needed_rows: u16,
    pub actual_columns: u16,
    pub actual_rows: u16,
}

impl fmt::Display for TerminalTooSmall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "terminal is {}x{}, need at least {}x{}",
            self.actual_columns, self.actual_rows, self.needed_columns, self.needed_rows
        )
    }
}

impl std::error::Error for TerminalTooSmall {}

/// Fit a source of the given display dimensions into the terminal, preserving aspect ratio.
///
/// The cell grid is deliberately the same in every mode: terminal geometry constrains cells,
/// and that does not change with how a cell is painted. Only the pixel grid asked of ffmpeg
/// differs, because a block cell carries two vertically stacked pixels.
pub fn fit(
    terminal_columns: u16,
    terminal_rows: u16,
    source_width: u32,
    source_height: u32,
    cell_height_over_width: f64,
    mode: RenderMode,
) -> Result<Layout, TerminalTooSmall> {
    let needed_rows = MINIMUM_CELL_ROWS + STATUS_LINE_ROWS;
    if terminal_columns < MINIMUM_CELL_COLUMNS || terminal_rows < needed_rows {
        return Err(TerminalTooSmall {
            needed_columns: MINIMUM_CELL_COLUMNS,
            needed_rows,
            actual_columns: terminal_columns,
            actual_rows: terminal_rows,
        });
    }

    let available_columns = terminal_columns;
    let available_rows = terminal_rows - STATUS_LINE_ROWS;

    let source_aspect = source_width as f64 / source_height as f64;
    let stretched_aspect = source_aspect * cell_height_over_width;

    let rows_if_full_width = (available_columns as f64 / stretched_aspect).round() as u32;
    let (cell_columns, cell_rows) = if rows_if_full_width <= available_rows as u32 {
        (available_columns, rows_if_full_width.max(1) as u16)
    } else {
        let columns_if_full_height = (available_rows as f64 * stretched_aspect).round() as u32;
        let columns = columns_if_full_height.clamp(1, available_columns as u32) as u16;
        (columns, available_rows)
    };

    Ok(Layout {
        cell_columns,
        cell_rows,
        pixel_width: cell_columns as u32,
        pixel_height: cell_rows as u32 * mode.vertical_pixels_per_cell(),
        left_pad_cells: (available_columns - cell_columns) / 2,
        top_pad_rows: (available_rows - cell_rows) / 2,
    })
}

pub fn luminance(red: u8, green: u8, blue: u8) -> u8 {
    let weighted = LUMA_WEIGHT_RED * red as u32
        + LUMA_WEIGHT_GREEN * green as u32
        + LUMA_WEIGHT_BLUE * blue as u32;
    (weighted >> LUMA_SHIFT) as u8
}

fn glyph_for_luminance(luminance: u8, ramp: &[u8]) -> u8 {
    // luminance maxes at 255, so this can never reach ramp.len() and never needs clamping.
    ramp[(luminance as usize * ramp.len()) >> LUMA_SHIFT]
}

fn beyond_tolerance(a: [u8; 3], b: [u8; 3], tolerance: u8) -> bool {
    a[0].abs_diff(b[0]) > tolerance
        || a[1].abs_diff(b[1]) > tolerance
        || a[2].abs_diff(b[2]) > tolerance
}

fn push_decimal(buffer: &mut Vec<u8>, value: u32) {
    let mut digits = [0u8; 10];
    let mut count = 0;
    let mut remaining = value;
    loop {
        digits[count] = b'0' + (remaining % 10) as u8;
        count += 1;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    while count > 0 {
        count -= 1;
        buffer.push(digits[count]);
    }
}

fn push_cursor_position(buffer: &mut Vec<u8>, row: u32, column: u32) {
    buffer.extend_from_slice(b"\x1b[");
    push_decimal(buffer, row);
    buffer.push(b';');
    push_decimal(buffer, column);
    buffer.push(b'H');
}

fn push_colour(buffer: &mut Vec<u8>, prefix: &[u8], colour: [u8; 3]) {
    buffer.extend_from_slice(prefix);
    push_decimal(buffer, colour[0] as u32);
    buffer.push(b';');
    push_decimal(buffer, colour[1] as u32);
    buffer.push(b';');
    push_decimal(buffer, colour[2] as u32);
    buffer.push(b'm');
}

#[derive(Debug, PartialEq, Eq)]
pub struct FrameSizeMismatch {
    pub expected: usize,
    pub actual: usize,
}

impl fmt::Display for FrameSizeMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "frame is {} bytes, layout expects {}",
            self.actual, self.expected
        )
    }
}

impl std::error::Error for FrameSizeMismatch {}

/// Encode one RGB frame into ANSI bytes, replacing whatever `buffer` held.
///
/// Every row is addressed absolutely rather than separated by newlines. That keeps the
/// letterbox margin unwritten instead of painted with spaces, and it makes it impossible for
/// the bottom right cell to scroll the screen.
pub fn encode_frame(
    buffer: &mut Vec<u8>,
    layout: &Layout,
    pixels: &[u8],
    mode: RenderMode,
    tolerance: u8,
) -> Result<(), FrameSizeMismatch> {
    if pixels.len() != layout.frame_bytes() {
        return Err(FrameSizeMismatch {
            expected: layout.frame_bytes(),
            actual: pixels.len(),
        });
    }

    buffer.clear();
    let ramp = mode.glyph_ramp();
    let row_stride = layout.pixel_width as usize * BYTES_PER_PIXEL;

    for row in 0..layout.cell_rows as u32 {
        push_cursor_position(
            buffer,
            layout.top_pad_rows as u32 + row + 1,
            layout.left_pad_cells as u32 + 1,
        );

        // Run state resets every row so each row is self contained. That costs at most one
        // extra escape per row and means a row can never inherit a colour from the row above.
        let mut last_foreground: Option<[u8; 3]> = None;
        let mut last_background: Option<[u8; 3]> = None;

        for column in 0..layout.cell_columns as usize {
            match mode {
                RenderMode::Mono => {
                    let offset = row as usize * row_stride + column * BYTES_PER_PIXEL;
                    let level = luminance(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                    buffer.push(glyph_for_luminance(level, ramp));
                }
                RenderMode::Colour => {
                    let offset = row as usize * row_stride + column * BYTES_PER_PIXEL;
                    let colour = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
                    if last_foreground.is_none_or(|last| beyond_tolerance(colour, last, tolerance))
                    {
                        push_colour(buffer, b"\x1b[38;2;", colour);
                        last_foreground = Some(colour);
                    }
                    let level = luminance(colour[0], colour[1], colour[2]);
                    buffer.push(glyph_for_luminance(level, ramp));
                }
                RenderMode::Blocks => {
                    let top_offset = row as usize * 2 * row_stride + column * BYTES_PER_PIXEL;
                    let bottom_offset = top_offset + row_stride;
                    let top = [
                        pixels[top_offset],
                        pixels[top_offset + 1],
                        pixels[top_offset + 2],
                    ];
                    let bottom = [
                        pixels[bottom_offset],
                        pixels[bottom_offset + 1],
                        pixels[bottom_offset + 2],
                    ];
                    if last_foreground.is_none_or(|last| beyond_tolerance(top, last, tolerance)) {
                        push_colour(buffer, b"\x1b[38;2;", top);
                        last_foreground = Some(top);
                    }
                    if last_background.is_none_or(|last| beyond_tolerance(bottom, last, tolerance))
                    {
                        push_colour(buffer, b"\x1b[48;2;", bottom);
                        last_background = Some(bottom);
                    }
                    buffer.extend_from_slice(UPPER_HALF_BLOCK);
                }
            }
        }
    }

    // Reset once per frame, never per cell, so the status line does not inherit a pixel colour.
    if mode != RenderMode::Mono {
        buffer.extend_from_slice(SGR_RESET);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, colour: [u8; 3]) -> Vec<u8> {
        colour
            .iter()
            .copied()
            .cycle()
            .take(width as usize * height as usize * BYTES_PER_PIXEL)
            .collect()
    }

    #[test]
    fn luma_endpoints_are_exact() {
        assert_eq!(luminance(0, 0, 0), 0);
        assert_eq!(luminance(255, 255, 255), 255);
        assert_eq!(luminance(255, 0, 0), 53);
        assert_eq!(luminance(0, 255, 0), 182);
        assert_eq!(luminance(0, 0, 255), 18);
    }

    #[test]
    fn luma_weights_sum_to_one_in_fixed_point() {
        assert_eq!(LUMA_WEIGHT_RED + LUMA_WEIGHT_GREEN + LUMA_WEIGHT_BLUE, 256);
    }

    #[test]
    fn glyph_index_never_leaves_the_ramp() {
        for ramp in [COLOUR_GLYPH_RAMP, MONO_GLYPH_RAMP] {
            for level in 0..=255u8 {
                let glyph = glyph_for_luminance(level, ramp);
                assert!(ramp.contains(&glyph), "level {level} escaped ramp");
            }
            assert_eq!(glyph_for_luminance(0, ramp), ramp[0]);
            assert_eq!(glyph_for_luminance(255, ramp), ramp[ramp.len() - 1]);
        }
    }

    #[test]
    fn sixteen_by_nine_in_an_eighty_by_twenty_four_terminal() {
        let layout = fit(80, 24, 1920, 1080, 2.0, RenderMode::Colour).unwrap();
        // 23 usable rows; full width would need 80 / (1.778 * 2) = 22.5 -> 23 rows, which fits.
        assert_eq!((layout.cell_columns, layout.cell_rows), (80, 23));
        assert_eq!(layout.left_pad_cells, 0);
        assert_eq!(layout.pixel_height, 23);
    }

    #[test]
    fn cell_grid_is_identical_across_modes_and_only_pixels_differ() {
        for (columns, rows) in [(80u16, 24u16), (200, 50), (137, 41)] {
            let colour = fit(columns, rows, 1920, 1080, 2.0, RenderMode::Colour).unwrap();
            let blocks = fit(columns, rows, 1920, 1080, 2.0, RenderMode::Blocks).unwrap();
            assert_eq!(
                (colour.cell_columns, colour.cell_rows),
                (blocks.cell_columns, blocks.cell_rows)
            );
            assert_eq!(blocks.pixel_height, colour.pixel_height * 2);
            assert_eq!(blocks.pixel_height % 2, 0, "block rows must pair up");
        }
    }

    #[test]
    fn a_square_source_is_height_bound_and_centred() {
        let layout = fit(100, 60, 512, 512, 2.0, RenderMode::Colour).unwrap();
        // 59 usable rows; full width would need 100 / 2 = 50 rows, which fits, so width bound.
        assert_eq!((layout.cell_columns, layout.cell_rows), (100, 50));
        assert_eq!(layout.top_pad_rows, 4);
        assert_eq!(layout.left_pad_cells, 0);
    }

    #[test]
    fn displayed_aspect_tracks_the_source_across_many_sizes() {
        for (width, height) in [(1920, 1080), (640, 480), (1080, 1920), (2560, 1080)] {
            for columns in [40u16, 80, 137, 240] {
                for rows in [12u16, 24, 51, 70] {
                    let layout = fit(columns, rows, width, height, 2.0, RenderMode::Colour);
                    let Ok(layout) = layout else { continue };
                    let source_aspect = width as f64 / height as f64;
                    let shown = layout.cell_columns as f64 / (layout.cell_rows as f64 * 2.0);
                    // One cell of slack: the grid is integers, so exactness is not available.
                    let slack = 1.0 / layout.cell_rows as f64;
                    assert!(
                        (shown - source_aspect).abs() / source_aspect < 0.05 + slack,
                        "{width}x{height} in {columns}x{rows}: showed {shown}, wanted {source_aspect}"
                    );
                    assert!(layout.cell_columns <= columns);
                    assert!(layout.cell_rows <= rows - STATUS_LINE_ROWS);
                }
            }
        }
    }

    #[test]
    fn a_terminal_below_the_minimum_is_refused() {
        assert!(fit(19, 40, 1920, 1080, 2.0, RenderMode::Colour).is_err());
        assert!(fit(80, 10, 1920, 1080, 2.0, RenderMode::Colour).is_err());
        assert!(fit(20, 11, 1920, 1080, 2.0, RenderMode::Colour).is_ok());
    }

    #[test]
    fn mono_emits_no_colour_escapes() {
        let layout = Layout {
            cell_columns: 4,
            cell_rows: 2,
            pixel_width: 4,
            pixel_height: 2,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        // White, so the glyph is the last in the ramp and the golden string is unambiguous.
        let pixels = solid(4, 2, [255, 255, 255]);
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Mono, 8).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert!(!text.contains("\x1b[38;2;"), "mono painted a colour");
        assert!(!text.contains("\x1b[48;2;"));
        assert_eq!(text, "\x1b[1;1H$$$$\x1b[2;1H$$$$");
    }

    #[test]
    fn a_solid_colour_row_collapses_to_one_escape() {
        let layout = Layout {
            cell_columns: 40,
            cell_rows: 3,
            pixel_width: 40,
            pixel_height: 3,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        let pixels = solid(40, 3, [10, 120, 250]);
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Colour, 8).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert_eq!(
            text.matches("\x1b[38;2;").count(),
            3,
            "one per row, no more"
        );
    }

    #[test]
    fn tolerance_collapses_near_colours_and_keeps_distant_ones() {
        let layout = Layout {
            cell_columns: 3,
            cell_rows: 1,
            pixel_width: 3,
            pixel_height: 1,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        // Two neighbours four apart, then one far away.
        let pixels = vec![100, 100, 100, 104, 104, 104, 250, 250, 250];
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Colour, 8).unwrap();
        let collapsed = String::from_utf8(buffer.clone()).unwrap();
        assert_eq!(collapsed.matches("\x1b[38;2;").count(), 2);

        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Colour, 0).unwrap();
        let exact = String::from_utf8(buffer).unwrap();
        assert_eq!(exact.matches("\x1b[38;2;").count(), 3);
    }

    #[test]
    fn blocks_pair_the_two_rows_into_one_glyph() {
        let layout = Layout {
            cell_columns: 1,
            cell_rows: 1,
            pixel_width: 1,
            pixel_height: 2,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        let pixels = vec![255, 0, 0, 0, 0, 255];
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Blocks, 8).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert_eq!(
            text,
            "\x1b[1;1H\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m\u{2580}\x1b[0m"
        );
    }

    #[test]
    fn padding_positions_rows_and_paints_no_spaces() {
        let layout = Layout {
            cell_columns: 2,
            cell_rows: 1,
            pixel_width: 2,
            pixel_height: 1,
            left_pad_cells: 5,
            top_pad_rows: 3,
        };
        // Not black: the darkest glyph in the ramp is a space, which would make the assertion
        // below pass for the wrong reason.
        let pixels = solid(2, 1, [255, 255, 255]);
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Mono, 8).unwrap();
        let text = String::from_utf8(buffer).unwrap();
        assert!(text.starts_with("\x1b[4;6H"), "got {text:?}");
        assert!(!text.contains("  "), "letterbox was painted with spaces");
    }

    #[test]
    fn a_wrongly_sized_frame_is_an_error_not_a_panic() {
        let layout = Layout {
            cell_columns: 4,
            cell_rows: 4,
            pixel_width: 4,
            pixel_height: 4,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        let mut buffer = Vec::new();
        let result = encode_frame(&mut buffer, &layout, &[0, 0, 0], RenderMode::Colour, 8);
        assert_eq!(
            result.unwrap_err(),
            FrameSizeMismatch {
                expected: 48,
                actual: 3
            }
        );
    }

    #[test]
    fn the_buffer_is_reused_not_appended_to() {
        let layout = Layout {
            cell_columns: 4,
            cell_rows: 1,
            pixel_width: 4,
            pixel_height: 1,
            left_pad_cells: 0,
            top_pad_rows: 0,
        };
        let pixels = solid(4, 1, [30, 30, 30]);
        let mut buffer = Vec::new();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Mono, 8).unwrap();
        let first = buffer.len();
        encode_frame(&mut buffer, &layout, &pixels, RenderMode::Mono, 8).unwrap();
        assert_eq!(buffer.len(), first);
    }
}

fn format_clock(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

/// One status line, already truncated to the terminal width.
pub fn format_status_line(
    position_seconds: f64,
    duration_seconds: Option<f64>,
    measured_fps: f64,
    dropped_frames: u64,
    paused: bool,
    width: u16,
) -> String {
    let total = match duration_seconds {
        Some(total) => format_clock(total),
        None => "--:--".to_string(),
    };
    let mut line = format!(
        "{} / {}  {measured_fps:.1}fps",
        format_clock(position_seconds),
        total
    );
    if dropped_frames > 0 {
        line.push_str(&format!("  {dropped_frames} dropped"));
    }
    if paused {
        line.push_str("  [paused]");
    }
    line.push_str("  q quit  space pause  arrows seek");
    line.chars().take(width as usize).collect()
}

#[cfg(test)]
mod status_tests {
    use super::*;

    #[test]
    fn under_an_hour_omits_the_hour_field() {
        let line = format_status_line(42.0, Some(90.0), 23.7, 0, false, 200);
        assert!(line.starts_with("0:42 / 1:30  23.7fps"), "got {line}");
    }

    #[test]
    fn over_an_hour_shows_it() {
        assert_eq!(format_clock(3723.0), "1:02:03");
    }

    #[test]
    fn an_unknown_duration_shows_dashes() {
        let line = format_status_line(5.0, None, 24.0, 0, false, 200);
        assert!(line.contains("0:05 / --:--"), "got {line}");
    }

    #[test]
    fn drops_and_pause_are_only_shown_when_they_apply() {
        let quiet = format_status_line(1.0, Some(2.0), 24.0, 0, false, 200);
        assert!(!quiet.contains("dropped"));
        assert!(!quiet.contains("paused"));
        let noisy = format_status_line(1.0, Some(2.0), 24.0, 7, true, 200);
        assert!(noisy.contains("7 dropped"));
        assert!(noisy.contains("[paused]"));
    }

    #[test]
    fn the_line_never_outgrows_the_terminal() {
        for width in [20u16, 40, 80, 200] {
            let line = format_status_line(3600.0, Some(7200.0), 23.9, 12, true, width);
            assert!(
                line.chars().count() <= width as usize,
                "width {width} produced {} chars",
                line.chars().count()
            );
        }
    }
}
