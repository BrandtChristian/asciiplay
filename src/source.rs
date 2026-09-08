use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    LocalPath,
    Url,
    Missing,
}

/// Decide what an input string refers to.
///
/// `path_exists` is passed in rather than checked here so this stays pure and testable. An
/// existing file wins over a URL-shaped name, so a file literally called "https:..." still plays.
pub fn classify_input(input: &str, path_exists: bool) -> InputKind {
    if path_exists {
        return InputKind::LocalPath;
    }
    if input.starts_with("http://") || input.starts_with("https://") {
        return InputKind::Url;
    }
    InputKind::Missing
}

#[derive(Debug, Clone)]
pub struct MediaSource {
    /// ffmpeg input arguments for the video stream, ending in `-i <target>`.
    pub video_input_args: Vec<String>,
    /// Where the audio lives. On DASH this is a different URL from the video.
    pub audio_target: String,
    pub display_width: u32,
    pub display_height: u32,
    pub duration_seconds: Option<f64>,
    /// What to call it on screen: a filename, or a video title.
    pub label: String,
    /// A live stream cannot be seeked, so resize must not restart with -ss.
    pub seekable: bool,
}

#[derive(Debug, Default, PartialEq)]
pub struct ProbeResult {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_aspect_ratio: Option<(u32, u32)>,
    pub duration_seconds: Option<f64>,
    /// What to call it on screen: a filename, or a video title.
    pub label: String,
    /// A live stream cannot be seeked, so resize must not restart with -ss.
    pub seekable: bool,
}

/// Parse ffprobe's `key=value` output.
///
/// Deliberately not JSON: the flat form needs no deserialisation dependency and the whole
/// reply is four fields.
pub fn parse_probe_output(text: &str) -> ProbeResult {
    let mut result = ProbeResult::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "width" => result.width = value.parse().ok(),
            "height" => result.height = value.parse().ok(),
            "duration" => result.duration_seconds = value.parse().ok(),
            "sample_aspect_ratio" => {
                if let Some((numerator, denominator)) = value.split_once(':') {
                    match (numerator.parse::<u32>(), denominator.parse::<u32>()) {
                        // ffprobe writes 0:1 when the ratio is simply unknown.
                        (Ok(n), Ok(d)) if n > 0 && d > 0 => {
                            result.sample_aspect_ratio = Some((n, d))
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    result
}

/// Apply a non-square pixel aspect so an anamorphic source is not shown squashed.
pub fn display_dimensions(probe: &ProbeResult) -> Option<(u32, u32)> {
    let width = probe.width?;
    let height = probe.height?;
    match probe.sample_aspect_ratio {
        Some((numerator, denominator)) if numerator != denominator => {
            let corrected = (width as f64 * numerator as f64 / denominator as f64).round() as u32;
            Some((corrected.max(1), height))
        }
        _ => Some((width, height)),
    }
}

pub fn probe(target: &str) -> Result<ProbeResult> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1",
            target,
        ])
        .output()
        .context("could not run ffprobe (is it on PATH?)")?;

    if !output.status.success() {
        return Err(anyhow!(
            "ffprobe could not read {target}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_probe_output(&String::from_utf8_lossy(&output.stdout)))
}

pub fn resolve(input: &str) -> Result<MediaSource> {
    let kind = classify_input(input, Path::new(input).exists());
    match kind {
        InputKind::Missing => Err(anyhow!("no such file: {input}")),
        InputKind::Url => resolve_url(input),
        InputKind::LocalPath => {
            let probe = probe(input)?;
            let (display_width, display_height) = display_dimensions(&probe)
                .ok_or_else(|| anyhow!("{input} has no video stream this can play"))?;
            Ok(MediaSource {
                video_input_args: vec!["-i".into(), input.into()],
                audio_target: input.into(),
                display_width,
                display_height,
                duration_seconds: probe.duration_seconds,
                label: Path::new(input)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| input.into()),
                seekable: true,
            })
        }
    }
}

// Prefer H.264 at 720p or below. Height is capped because the picture is being thrown away down
// to a couple of hundred cells, so pulling 4K wastes bandwidth and decode for nothing, and the
// biggest formats are also the ones most likely to need a token yt-dlp cannot supply. The codec
// preference matters because YouTube's default at 720p is often AV1, which has no hardware
// decoder on this APU and costs far more CPU than the whole renderer.
const YTDLP_FORMAT: &str = "bv*[height<=720][vcodec^=avc1]+ba/bv*[height<=720]+ba/b[height<=720]/b";

const PRINT_SENTINELS: [&str; 5] = [
    "asciiplay-duration:%(duration)s",
    "asciiplay-title:%(title)s",
    "asciiplay-live:%(is_live)s",
    "asciiplay-width:%(width)s",
    "asciiplay-height:%(height)s",
];

#[derive(Debug, Default, PartialEq)]
pub struct ResolvedStream {
    pub video_url: String,
    pub audio_url: String,
    pub duration_seconds: Option<f64>,
    pub title: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub is_live: bool,
}

fn sentinel_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    // yt-dlp writes NA for any field the extractor did not fill in.
    line.strip_prefix(key)
        .map(str::trim)
        .filter(|value| *value != "NA")
}

/// Parse yt-dlp's sentinel-prefixed output.
///
/// Sentinels rather than positional lines, so the parser cannot be broken by adding a field or
/// by yt-dlp reordering its output.
pub fn parse_ytdlp_output(text: &str) -> Result<ResolvedStream> {
    let mut stream = ResolvedStream::default();
    let mut urls: Vec<String> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(value) = sentinel_value(line, "asciiplay-duration:") {
            stream.duration_seconds = value.parse().ok();
        } else if let Some(value) = sentinel_value(line, "asciiplay-title:") {
            stream.title = Some(value.to_string());
        } else if let Some(value) = sentinel_value(line, "asciiplay-live:") {
            stream.is_live = value.eq_ignore_ascii_case("true");
        } else if let Some(value) = sentinel_value(line, "asciiplay-width:") {
            stream.width = value.parse().ok();
        } else if let Some(value) = sentinel_value(line, "asciiplay-height:") {
            stream.height = value.parse().ok();
        } else if line.starts_with("http://") || line.starts_with("https://") {
            urls.push(line.to_string());
        }
    }

    match urls.len() {
        0 => Err(anyhow!("yt-dlp returned no stream URL")),
        // One URL means a progressive format carrying both tracks, so both consumers read it.
        // Two means DASH, and that is the better case: each process fetches only its own track
        // rather than downloading and discarding the other.
        1 => {
            stream.video_url = urls[0].clone();
            stream.audio_url = urls[0].clone();
            Ok(stream)
        }
        _ => {
            stream.video_url = urls[0].clone();
            stream.audio_url = urls[1].clone();
            Ok(stream)
        }
    }
}

/// ffmpeg input arguments for a network stream, with reconnection so a CDN hiccup does not end
/// playback.
fn network_input_args(url: &str) -> Vec<String> {
    vec![
        "-reconnect".into(),
        "1".into(),
        "-reconnect_streamed".into(),
        "1".into(),
        "-reconnect_delay_max".into(),
        "5".into(),
        "-i".into(),
        url.into(),
    ]
}

fn resolve_url(input: &str) -> Result<MediaSource> {
    // Said before the terminal is taken over, because a cold resolve can take several seconds
    // and a blank screen looks like a hang.
    eprintln!("resolving stream...");

    let mut command = Command::new("yt-dlp");
    command.args(["--no-playlist", "--quiet", "--no-warnings"]);
    command.args(["--socket-timeout", "15"]);
    command.args(["-f", YTDLP_FORMAT]);
    for sentinel in PRINT_SENTINELS {
        command.args(["--print", sentinel]);
    }
    command.args(["--print", "urls"]);
    command.arg(input);

    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            anyhow!("yt-dlp is needed for URLs. Install it with: uv tool install yt-dlp")
        } else {
            anyhow!("could not run yt-dlp: {error}")
        }
    })?;

    if !output.status.success() {
        // yt-dlp's own messages name the actual problem (private, geo-blocked, age-gated,
        // needs updating) far better than anything this could say instead.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(anyhow!(
            "yt-dlp could not resolve that URL: {}",
            if message.is_empty() {
                "no reason given"
            } else {
                message
            }
        ));
    }

    let stream = parse_ytdlp_output(&String::from_utf8_lossy(&output.stdout))?;

    // yt-dlp usually reports the dimensions, which saves a second network round trip. When it
    // does not, ask ffprobe about the stream we are actually going to decode.
    let (display_width, display_height) = match (stream.width, stream.height) {
        (Some(width), Some(height)) => (width, height),
        _ => {
            let probe = probe(&stream.video_url)?;
            display_dimensions(&probe)
                .ok_or_else(|| anyhow!("could not determine the video size of that stream"))?
        }
    };

    if let Some(title) = &stream.title {
        eprintln!("playing: {title}");
    }

    Ok(MediaSource {
        video_input_args: network_input_args(&stream.video_url),
        audio_target: stream.audio_url,
        display_width,
        display_height,
        duration_seconds: stream.duration_seconds,
        label: stream.title.unwrap_or_else(|| input.to_string()),
        seekable: !stream.is_live,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_output(urls: &str) -> String {
        format!(
            "asciiplay-duration:635\nasciiplay-title:Big Buck Bunny\nasciiplay-live:False\n\
             asciiplay-width:1280\nasciiplay-height:720\n{urls}"
        )
    }

    #[test]
    fn two_urls_are_split_into_video_then_audio() {
        let text = sample_output("https://example.com/video\nhttps://example.com/audio\n");
        let stream = parse_ytdlp_output(&text).unwrap();
        assert_eq!(stream.video_url, "https://example.com/video");
        assert_eq!(stream.audio_url, "https://example.com/audio");
        assert_eq!(stream.duration_seconds, Some(635.0));
        assert_eq!(stream.title.as_deref(), Some("Big Buck Bunny"));
        assert_eq!((stream.width, stream.height), (Some(1280), Some(720)));
        assert!(!stream.is_live);
    }

    #[test]
    fn one_url_feeds_both_consumers() {
        let text = sample_output("https://example.com/both\n");
        let stream = parse_ytdlp_output(&text).unwrap();
        assert_eq!(stream.video_url, stream.audio_url);
    }

    #[test]
    fn no_url_is_an_error_rather_than_an_empty_stream() {
        assert!(parse_ytdlp_output("asciiplay-title:nothing here\n").is_err());
        assert!(parse_ytdlp_output("").is_err());
    }

    #[test]
    fn unfilled_fields_come_back_as_none_not_as_the_string_na() {
        let text = "asciiplay-duration:NA\nasciiplay-title:NA\nasciiplay-width:NA\n\
                    https://example.com/live\n";
        let stream = parse_ytdlp_output(text).unwrap();
        assert_eq!(stream.duration_seconds, None);
        assert_eq!(stream.title, None);
        assert_eq!(stream.width, None);
    }

    #[test]
    fn a_live_stream_is_recognised_whatever_the_casing() {
        for value in ["True", "true", "TRUE"] {
            let text = format!("asciiplay-live:{value}\nhttps://example.com/x\n");
            assert!(parse_ytdlp_output(&text).unwrap().is_live);
        }
        let text = "asciiplay-live:False\nhttps://example.com/x\n";
        assert!(!parse_ytdlp_output(text).unwrap().is_live);
    }

    #[test]
    fn field_order_does_not_matter() {
        let text = "https://example.com/video\nasciiplay-title:Late Title\n\
                    https://example.com/audio\nasciiplay-duration:12\n";
        let stream = parse_ytdlp_output(text).unwrap();
        assert_eq!(stream.title.as_deref(), Some("Late Title"));
        assert_eq!(stream.duration_seconds, Some(12.0));
        assert_eq!(stream.video_url, "https://example.com/video");
    }

    #[test]
    fn network_inputs_ask_ffmpeg_to_reconnect() {
        let args = network_input_args("https://example.com/v");
        assert!(args.contains(&"-reconnect".to_string()));
        assert_eq!(args.last().unwrap(), "https://example.com/v");
    }

    #[test]
    fn an_existing_file_beats_a_url_shaped_name() {
        assert_eq!(
            classify_input("https://example.com/v.mp4", true),
            InputKind::LocalPath
        );
        assert_eq!(
            classify_input("https://example.com/v.mp4", false),
            InputKind::Url
        );
    }

    #[test]
    fn a_filename_mentioning_https_is_still_a_file() {
        assert_eq!(
            classify_input("my https video.mp4", true),
            InputKind::LocalPath
        );
        assert_eq!(classify_input("clip.mp4", false), InputKind::Missing);
    }

    #[test]
    fn probe_output_parses_into_fields() {
        let text = "width=1920\nheight=1080\nsample_aspect_ratio=1:1\nduration=596.458000\n";
        let probe = parse_probe_output(text);
        assert_eq!(probe.width, Some(1920));
        assert_eq!(probe.height, Some(1080));
        assert_eq!(probe.duration_seconds, Some(596.458));
        assert_eq!(probe.sample_aspect_ratio, Some((1, 1)));
    }

    #[test]
    fn an_unknown_duration_is_none_rather_than_zero() {
        let probe = parse_probe_output("width=640\nheight=480\nduration=N/A\n");
        assert_eq!(probe.duration_seconds, None);
        assert_eq!(probe.width, Some(640));
    }

    #[test]
    fn an_unknown_sample_aspect_is_ignored() {
        let probe = parse_probe_output("width=640\nheight=480\nsample_aspect_ratio=0:1\n");
        assert_eq!(probe.sample_aspect_ratio, None);
        assert_eq!(display_dimensions(&probe), Some((640, 480)));
    }

    #[test]
    fn an_anamorphic_source_is_widened_to_its_display_size() {
        let probe = parse_probe_output("width=720\nheight=576\nsample_aspect_ratio=16:15\n");
        assert_eq!(display_dimensions(&probe), Some((768, 576)));
    }

    #[test]
    fn a_stream_with_no_dimensions_has_no_display_size() {
        assert_eq!(
            display_dimensions(&parse_probe_output("duration=5.0")),
            None
        );
    }
}
