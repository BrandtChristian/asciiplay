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
}

#[derive(Debug, Default, PartialEq)]
pub struct ProbeResult {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_aspect_ratio: Option<(u32, u32)>,
    pub duration_seconds: Option<f64>,
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
        InputKind::Url => Err(anyhow!(
            "URL inputs are not wired up yet; pass a local file for now"
        )),
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
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
