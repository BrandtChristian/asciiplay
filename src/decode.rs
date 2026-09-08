use anyhow::{anyhow, Context, Result};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, ErrorKind, Read};
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const STDERR_TAIL_LINES: usize = 20;

/// A running ffmpeg that emits raw RGB frames on its stdout.
pub struct Decoder {
    child: Child,
    stdout: ChildStdout,
    frame_bytes: usize,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    stderr_reader: Option<JoinHandle<()>>,
}

/// Build the ffmpeg argument list for decoding video into raw RGB frames.
///
/// Kept as a pure function so the flag order, which is load bearing in three separate places,
/// can be asserted in a test rather than trusted.
pub fn video_args(
    input_args: &[String],
    pixel_width: u32,
    pixel_height: u32,
    fps: f64,
    seek_seconds: f64,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];

    // ffmpeg reads stdin for its own interactive keyboard commands, and would compete with the
    // player for keystrokes. This is the usual cause of "sometimes my keys do nothing".
    args.push("-nostdin".into());

    // Before -i this is an input seek: it moves the demuxer, then decodes and discards from the
    // preceding keyframe. After -i it would decode the whole file from zero and throw it away,
    // which makes seeking and resize restarts unusably slow.
    if seek_seconds > 0.0 {
        args.push("-ss".into());
        args.push(format!("{seek_seconds}"));
    }

    args.extend(input_args.iter().cloned());

    args.push("-an".into());
    args.push("-sn".into());
    args.push("-dn".into());

    // fps first, so frames are dropped before paying to scale them. flags=area is a box filter,
    // which is proper averaging decimation: at a 10x downscale the default bicubic point samples
    // enough to shimmer. setsar=1 stops anything downstream reapplying the sample aspect.
    args.push("-vf".into());
    args.push(format!(
        "fps={fps},scale={pixel_width}:{pixel_height}:flags=area,setsar=1,format=rgb24"
    ));

    args.push("-f".into());
    args.push("rawvideo".into());
    args.push("-pix_fmt".into());
    args.push("rgb24".into());
    args.push("pipe:1".into());
    args
}

impl Decoder {
    pub fn spawn(args: &[String], frame_bytes: usize) -> Result<Self> {
        let mut command = Command::new("ffmpeg");
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // In practice a killed player closes this pipe and ffmpeg dies of EPIPE on its next
        // write, which for a decoder is within a frame. This makes that guarantee rather than a
        // timing accident, and covers an ffmpeg blocked somewhere other than the pipe. Linux
        // only, so elsewhere the EPIPE path is all there is.
        #[cfg(target_os = "linux")]
        unsafe {
            command.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }

        let mut child = command
            .spawn()
            .context("could not start ffmpeg (is it on PATH?)")?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("ffmpeg produced no stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("ffmpeg produced no stderr"))?;

        // ffmpeg blocks once its stderr pipe buffer fills, which would hang the player with no
        // explanation, so this thread must keep draining whether or not anyone reads the tail.
        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)));
        let tail_for_thread = Arc::clone(&stderr_tail);
        let stderr_reader = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut tail = tail_for_thread.lock().expect("stderr tail mutex");
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });

        Ok(Self {
            child,
            stdout,
            frame_bytes,
            stderr_tail,
            stderr_reader: Some(stderr_reader),
        })
    }

    /// Fill `frame` with the next frame. Returns false at end of stream.
    ///
    /// read_exact is the right primitive rather than a tolerated short read: a frame is exactly
    /// width * height * 3 bytes with no row padding, so partial reads are a pipe artefact to be
    /// looped over, and only a genuine end of stream produces UnexpectedEof.
    pub fn read_frame(&mut self, frame: &mut [u8]) -> Result<bool> {
        debug_assert_eq!(frame.len(), self.frame_bytes);
        match self.stdout.read_exact(frame) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
                let status = self.child.wait().context("waiting for ffmpeg")?;
                if status.success() {
                    return Ok(false);
                }
                Err(anyhow!("ffmpeg failed: {}", self.stderr_tail_text()))
            }
            Err(error) => Err(error).context("reading a frame from ffmpeg"),
        }
    }

    pub fn stderr_tail_text(&self) -> String {
        let tail = self.stderr_tail.lock().expect("stderr tail mutex");
        if tail.is_empty() {
            return "no output on stderr".into();
        }
        tail.iter().cloned().collect::<Vec<_>>().join("; ")
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // Killing closes the stderr pipe, which is what lets the drain thread finish.
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_input() -> Vec<String> {
        vec!["-i".into(), "clip.mp4".into()]
    }

    #[test]
    fn seek_is_an_input_seek_and_precedes_the_input() {
        let args = video_args(&local_input(), 80, 24, 24.0, 12.5);
        let seek = args.iter().position(|a| a == "-ss").expect("no -ss");
        let input = args.iter().position(|a| a == "-i").expect("no -i");
        assert!(seek < input, "-ss must come before -i, got {args:?}");
    }

    #[test]
    fn no_seek_flag_when_starting_from_zero() {
        let args = video_args(&local_input(), 80, 24, 24.0, 0.0);
        assert!(!args.contains(&"-ss".to_string()));
    }

    #[test]
    fn stdin_is_taken_away_from_ffmpeg() {
        let args = video_args(&local_input(), 80, 24, 24.0, 0.0);
        assert!(args.contains(&"-nostdin".to_string()));
    }

    #[test]
    fn the_filter_chain_is_exactly_as_intended() {
        let args = video_args(&local_input(), 174, 49, 24.0, 0.0);
        let filter = args
            .iter()
            .position(|a| a == "-vf")
            .map(|i| args[i + 1].clone())
            .expect("no -vf");
        assert_eq!(
            filter,
            "fps=24,scale=174:49:flags=area,setsar=1,format=rgb24"
        );
    }

    #[test]
    fn every_non_video_stream_is_discarded() {
        let args = video_args(&local_input(), 80, 24, 24.0, 0.0);
        for flag in ["-an", "-sn", "-dn"] {
            assert!(args.contains(&flag.to_string()), "missing {flag}");
        }
    }
}
