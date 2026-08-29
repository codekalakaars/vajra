//! Scrubbing secret values out of text before it is shown to an agent.
//!
//! Extracted from the legacy supervisor (`legacy/src/supervisor.rs`), which
//! interleaved this with unix-socket plumbing. The scrubbing itself is pure
//! string work and portable; the socket machinery stayed behind.
//!
//! This is a best-effort filter with the same limits as CI log masking: it
//! catches a secret appearing verbatim in output, not one that has been
//! encoded, split, or otherwise transformed first.

use crate::env::EnvVar;

/// Values shorter than this are not redacted. They are too common in ordinary
/// output to match reliably — redacting a PORT of "80" would mangle every line
/// containing that number — and too weak to be worth protecting.
const MIN_SECRET_LEN: usize = 4;

pub fn redact_str(text: &str, secrets: &[(String, String)]) -> String {
    let mut out = text.to_string();

    for (key, value) in secrets {
        if value.len() >= MIN_SECRET_LEN && out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("[REDACTED:{}]", key));
        }
    }

    out
}

/// Replace every occurrence of each secret value with `[REDACTED:<KEY>]`.
///
/// When streaming process output, redact whole lines rather than raw read
/// chunks: a secret split across two chunk boundaries would otherwise slip
/// through unmatched.
#[napi]
pub fn redact(text: String, secrets: Vec<EnvVar>) -> String {
    let pairs: Vec<(String, String)> = secrets
        .into_iter()
        .map(|v| (v.key, v.value))
        .collect();

    redact_str(&text, &pairs)
}

/// The shortest secret value that `redact` will act on. Exposed so a caller can
/// warn that a given variable will not be scrubbed, rather than assuming it was.
#[napi]
pub fn min_redactable_length() -> u32 {
    MIN_SECRET_LEN as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> Vec<(String, String)> {
        vec![
            ("SECRET".into(), "hunter2".into()),
            ("API_KEY".into(), "sk-abc123def".into()),
            ("PORT".into(), "80".into()),
        ]
    }

    #[test]
    fn redacts_secret_values() {
        let line = "connecting with token sk-abc123def and password hunter2\n";
        assert_eq!(
            redact_str(line, &secrets()),
            "connecting with token [REDACTED:API_KEY] and password [REDACTED:SECRET]\n"
        );
    }

    #[test]
    fn skips_short_values() {
        // "80" is too short to redact; matching it would mangle ordinary output.
        assert_eq!(
            redact_str("listening on port 80\n", &secrets()),
            "listening on port 80\n"
        );
    }

    #[test]
    fn redacts_repeated_occurrences() {
        assert_eq!(
            redact_str("hunter2 hunter2", &secrets()),
            "[REDACTED:SECRET] [REDACTED:SECRET]"
        );
    }

    #[test]
    fn leaves_clean_lines_untouched() {
        let line = "server started on :3000\n";
        assert_eq!(redact_str(line, &secrets()), line);
    }

    #[test]
    fn redacts_across_multiple_lines() {
        let text = "line one hunter2\nline two sk-abc123def\n";
        assert_eq!(
            redact_str(text, &secrets()),
            "line one [REDACTED:SECRET]\nline two [REDACTED:API_KEY]\n"
        );
    }

    #[test]
    fn redacts_a_secret_embedded_in_a_larger_token() {
        // A secret inside a URL or JSON blob still has to go.
        assert_eq!(
            redact_str("url=https://u:hunter2@host/db", &secrets()),
            "url=https://u:[REDACTED:SECRET]@host/db"
        );
    }

    #[test]
    fn empty_secret_list_is_a_no_op() {
        assert_eq!(redact_str("anything at all", &[]), "anything at all");
    }
}
