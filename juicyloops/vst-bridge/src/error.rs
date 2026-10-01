use std::fmt;

/// An error as the studio sees it: a stable code for the program and a sentence for the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BridgeError {
    pub code: &'static str,
    pub message: String,
}

impl BridgeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("bad-request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not-found", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new("unauthorized", message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new("unsupported", message)
    }

    pub fn plugin(message: impl Into<String>) -> Self {
        Self::new("plugin-error", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for BridgeError {}
