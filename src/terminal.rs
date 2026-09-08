use anyhow::{Context, Result};
use crossterm::{cursor, execute, terminal};
use std::io::{self, Write};
use std::panic;

/// Owning this value means the terminal is in playback state: alternate screen, raw mode,
/// cursor hidden, line wrap off. Dropping it puts everything back.
pub struct TerminalGuard;

/// Idempotent, ignores every error. Safe to call twice, and safe to call from a panic hook.
pub fn restore_best_effort() {
    let mut out = io::stdout();
    let _ = execute!(
        out,
        cursor::Show,
        terminal::EnableLineWrap,
        terminal::LeaveAlternateScreen
    );
    let _ = out.write_all(b"\x1b[0m");
    let _ = out.flush();
    let _ = terminal::disable_raw_mode();
}

impl TerminalGuard {
    pub fn activate() -> Result<Self> {
        // The hook goes in first, and chains, because a panic that unwinds inside the alternate
        // screen would otherwise print its message onto a screen that Drop then discards, so the
        // program appears to die silently. Restoring before printing puts the message where it
        // can be read.
        let previous_hook = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            restore_best_effort();
            previous_hook(info);
        }));

        terminal::enable_raw_mode().context("could not put the terminal into raw mode")?;
        let mut out = io::stdout();
        execute!(
            out,
            terminal::EnterAlternateScreen,
            terminal::DisableLineWrap,
            cursor::Hide,
            terminal::Clear(terminal::ClearType::All)
        )
        .context("could not set up the terminal")?;
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore_best_effort();
    }
}
