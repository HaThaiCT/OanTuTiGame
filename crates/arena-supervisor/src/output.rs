//! Bounded byte collection only. JSON/request identity/game legality validation
//! and nonblocking FD draining belong to the execution lifecycle.
const STDOUT_MAX: usize = 1024 * 1024;
const COMBINED_MAX: usize = 2 * 1024 * 1024;
const STDERR_RETAIN_MAX: usize = 64 * 1024;
const LINE_MAX: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputError { OutputLimit, InvalidUtf8, IncompleteLine, StdoutClosed }

pub struct BotOutput {
    stdout_bytes: usize,
    combined_bytes: usize,
    line: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
    failure: Option<OutputError>,
    stdout_closed: bool,
}

impl Default for BotOutput {
    fn default() -> Self { Self::new() }
}

impl BotOutput {
    pub fn new() -> Self {
        Self { stdout_bytes: 0, combined_bytes: 0, line: Vec::new(), stderr: Vec::new(), truncated: false, failure: None, stdout_closed: false }
    }

    fn fail(&mut self, reason: OutputError) -> Result<(), OutputError> {
        self.failure = Some(reason);
        Err(reason)
    }

    fn count(&mut self, bytes: usize, stdout: bool) -> Result<(), OutputError> {
        if let Some(reason) = self.failure { return Err(reason); }
        if bytes > COMBINED_MAX - self.combined_bytes || (stdout && bytes > STDOUT_MAX - self.stdout_bytes) {
            return self.fail(OutputError::OutputLimit);
        }
        self.combined_bytes += bytes;
        if stdout { self.stdout_bytes += bytes; }
        Ok(())
    }

    /// The callback must not block: the eventual event loop must drain both FDs
    /// while the independent watchdog remains authoritative.
    pub fn stdout(&mut self, bytes: &[u8], mut on_line: impl FnMut(&str)) -> Result<(), OutputError> {
        if let Some(reason) = self.failure { return Err(reason); }
        if self.stdout_closed { return self.fail(OutputError::StdoutClosed); }
        self.count(bytes.len(), true)?;
        for byte in bytes {
            if *byte == b'\n' {
                let text = match std::str::from_utf8(&self.line) {
                    Ok(text) => text,
                    Err(_) => return self.fail(OutputError::InvalidUtf8),
                };
                on_line(text);
                self.line.clear();
            } else {
                // Reserve one byte of the wire-line cap for the LF delimiter.
                if self.line.len() == LINE_MAX - 1 { return self.fail(OutputError::OutputLimit); }
                self.line.push(*byte);
            }
        }
        Ok(())
    }

    pub fn stderr(&mut self, bytes: &[u8]) -> Result<(), OutputError> {
        self.count(bytes.len(), false)?;
        let retained = bytes.len().min(STDERR_RETAIN_MAX - self.stderr.len());
        self.stderr.extend_from_slice(&bytes[..retained]);
        self.truncated |= retained != bytes.len();
        Ok(())
    }

    pub fn finish_stdout(&mut self) -> Result<(), OutputError> {
        if let Some(reason) = self.failure { return Err(reason); }
        if !self.line.is_empty() { return self.fail(OutputError::IncompleteLine); }
        self.stdout_closed = true;
        Ok(())
    }

    pub fn retained_stderr(&self) -> &[u8] { &self.stderr }
    pub fn stderr_truncated(&self) -> bool { self.truncated }
}
