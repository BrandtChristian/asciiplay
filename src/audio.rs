use anyhow::{anyhow, Context, Result};
use std::io::{BufRead, BufReader};
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

/// How stale an audio anchor may get before we stop trusting the interpolation between
/// updates. ffmpeg reports progress about twice a second, so this is generous.
const ANCHOR_STALE_SECONDS: f64 = 2.0;

#[derive(Debug, Clone, Copy)]
struct Anchor {
    audio_seconds: f64,
    observed_at: Instant,
}

/// The playback position, driven by the audio device when audio is playing.
///
/// The audio device paces itself, so taking the position from ffmpeg's own progress output
/// removes the two problems a wall clock cannot solve: the startup offset between two
/// processes that open at different speeds (100 to 1200 ms, and audible), and the slow
/// divergence between the sound card's clock and the system clock. Frame dropping cannot mask
/// either, since both are offsets rather than lateness.
pub struct PlaybackClock {
    start_seconds: f64,
    offset_seconds: f64,
    wall_origin: Instant,
    anchor: Option<Arc<Mutex<Option<Anchor>>>>,
    paused_at: Option<Instant>,
}

impl PlaybackClock {
    pub fn wall_only(start_seconds: f64) -> Self {
        Self {
            start_seconds,
            offset_seconds: 0.0,
            wall_origin: Instant::now(),
            anchor: None,
            paused_at: None,
        }
    }

    fn following(audio: &Audio, start_seconds: f64, offset_seconds: f64) -> Self {
        Self {
            start_seconds,
            offset_seconds,
            wall_origin: Instant::now(),
            anchor: Some(Arc::clone(&audio.anchor)),
            paused_at: None,
        }
    }

    /// Seconds into the media, counting from the very beginning of the file.
    pub fn position(&self) -> f64 {
        if let Some(paused_at) = self.paused_at {
            return self.position_at(paused_at);
        }
        self.position_at(Instant::now())
    }

    fn position_at(&self, now: Instant) -> f64 {
        if let Some(shared) = &self.anchor {
            let anchor = *shared.lock().expect("audio anchor mutex");
            if let Some(anchor) = anchor {
                let since = now.duration_since(anchor.observed_at).as_secs_f64();
                // A stale anchor means the audio process died or wedged. Interpolating from it
                // forever would run the video away from silence, so fall through to wall time.
                if since <= ANCHOR_STALE_SECONDS {
                    return self.start_seconds + anchor.audio_seconds + since - self.offset_seconds;
                }
            }
        }
        self.start_seconds + now.duration_since(self.wall_origin).as_secs_f64()
            - self.offset_seconds
    }

    pub fn pause(&mut self) {
        if self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
        }
    }

    pub fn resume(&mut self) {
        let Some(paused_at) = self.paused_at.take() else {
            return;
        };
        let paused_for = paused_at.elapsed();
        self.wall_origin += paused_for;
        // The audio process was stopped, so its reported position did not advance while we
        // waited. Re-stamping the anchor keeps interpolation from jumping the pause duration
        // forward before the next progress line arrives.
        if let Some(shared) = &self.anchor {
            let mut anchor = shared.lock().expect("audio anchor mutex");
            if let Some(anchor) = anchor.as_mut() {
                anchor.observed_at += paused_for;
            }
        }
    }

    pub fn is_paused(&self) -> bool {
        self.paused_at.is_some()
    }
}

/// A sibling ffmpeg decoding only audio, straight into PulseAudio (PipeWire serves it here).
pub struct Audio {
    child: Child,
    anchor: Arc<Mutex<Option<Anchor>>>,
}

/// Build the audio ffmpeg argument list. Pure, so the flag order stays testable.
pub fn audio_args(target: &str, seek_seconds: f64, buffer_milliseconds: u32) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
    ];
    if seek_seconds > 0.0 {
        args.push("-ss".into());
        args.push(format!("{seek_seconds}"));
    }
    args.push("-i".into());
    args.push(target.into());
    args.push("-vn".into());
    // Progress goes to stdout because the pulse muxer takes the audio, so stdout is free. This
    // is machine readable and stable, unlike ffplay's human readable status line.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.extend(audio_output_args(buffer_milliseconds));
    args
}

/// Where the decoded audio actually goes, which is the one genuinely platform specific part.
#[cfg(target_os = "linux")]
fn audio_output_args(buffer_milliseconds: u32) -> Vec<String> {
    vec![
        "-f".into(),
        "pulse".into(),
        // Bounds how far ahead of the clock the device buffer can sit, which is the residual
        // offset left once the progress anchor has removed the startup skew.
        "-buffer_duration".into(),
        format!("{buffer_milliseconds}"),
        "asciiplay".into(),
    ]
}

/// UNTESTED: written without a Mac to hand. If the muxer name or sink is wrong the audio
/// process simply fails to start, `Audio::start(..).ok()` yields None, and the video plays
/// silently rather than the player failing.
#[cfg(target_os = "macos")]
fn audio_output_args(_buffer_milliseconds: u32) -> Vec<String> {
    // -buffer_duration is a pulse option and audiotoolbox rejects it. The sink is a device index.
    vec!["-f".into(), "audiotoolbox".into(), "0".into()]
}

/// Pull the microsecond position out of one ffmpeg progress line.
pub fn parse_progress_line(line: &str) -> Option<f64> {
    let value = line.strip_prefix("out_time_us=")?.trim();
    // ffmpeg writes N/A before the first sample actually reaches the device.
    value
        .parse::<i64>()
        .ok()
        .filter(|v| *v >= 0)
        .map(|v| v as f64 / 1_000_000.0)
}

impl Audio {
    pub fn start(target: &str, seek_seconds: f64, buffer_milliseconds: u32) -> Result<Self> {
        let args = audio_args(target, seek_seconds, buffer_milliseconds);
        let mut command = Command::new("ffmpeg");
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        // The only mechanism that survives the player being SIGKILLed, which is what stops a
        // crash leaving audio playing into a dead terminal. It fires on the death of the
        // parent THREAD, so this must be spawned from the thread that owns playback.
        //
        // Linux only. Elsewhere the fallback is that our death closes this progress pipe and
        // ffmpeg exits on EPIPE at its next write, which is within about half a second.
        #[cfg(target_os = "linux")]
        unsafe {
            command.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }

        let mut child = command
            .spawn()
            .context("could not start ffmpeg for audio")?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("audio ffmpeg produced no progress stream"))?;

        let anchor = Arc::new(Mutex::new(None));
        let anchor_for_thread = Arc::clone(&anchor);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(audio_seconds) = parse_progress_line(&line) {
                    *anchor_for_thread.lock().expect("audio anchor mutex") = Some(Anchor {
                        audio_seconds,
                        observed_at: Instant::now(),
                    });
                }
            }
        });

        Ok(Self { child, anchor })
    }

    pub fn clock(&self, start_seconds: f64, offset_seconds: f64) -> PlaybackClock {
        PlaybackClock::following(self, start_seconds, offset_seconds)
    }

    fn signal(&self, signal: libc::c_int) {
        // Safe in the sense that matters: the pid is ours and reaping happens only in Drop.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, signal);
        }
    }

    pub fn pause(&self) {
        self.signal(libc::SIGSTOP);
    }

    pub fn resume(&self) {
        self.signal(libc::SIGCONT);
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        // A stopped process ignores SIGTERM until it continues, so undo any pause first.
        self.resume();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_yield_seconds() {
        assert_eq!(parse_progress_line("out_time_us=1500000"), Some(1.5));
        assert_eq!(parse_progress_line("out_time_us=0"), Some(0.0));
    }

    #[test]
    fn other_progress_fields_and_placeholders_are_ignored() {
        assert_eq!(parse_progress_line("bitrate=  128.0kbits/s"), None);
        assert_eq!(parse_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_progress_line("progress=continue"), None);
        assert_eq!(parse_progress_line(""), None);
        // out_time_ms is microseconds in ffmpeg despite the name, so never read it by accident.
        assert_eq!(parse_progress_line("out_time_ms=1500000"), None);
    }

    #[test]
    fn audio_seek_precedes_the_input() {
        let args = audio_args("clip.mp4", 30.0, 100);
        let seek = args.iter().position(|a| a == "-ss").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert!(seek < input);
        assert!(args.contains(&"-vn".to_string()));
        #[cfg(target_os = "linux")]
        assert!(args.contains(&"pulse".to_string()));
    }

    #[test]
    fn no_seek_flag_from_the_start() {
        let args = audio_args("clip.mp4", 0.0, 100);
        assert!(!args.contains(&"-ss".to_string()));
    }

    #[test]
    fn a_wall_clock_advances_from_its_start_position() {
        let clock = PlaybackClock::wall_only(12.0);
        assert!(clock.position() >= 12.0);
        assert!(clock.position() < 12.5);
    }

    #[test]
    fn pausing_freezes_the_position_and_resuming_does_not_skip() {
        let mut clock = PlaybackClock::wall_only(0.0);
        clock.pause();
        let frozen = clock.position();
        thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(clock.position(), frozen, "a paused clock must not advance");
        clock.resume();
        assert!(
            clock.position() - frozen < 0.02,
            "resuming skipped the paused span forward"
        );
    }
}
