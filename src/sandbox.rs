//! Filesystem confinement, with one API across platforms and an honest report
//! of what each can actually enforce.
//!
//! Enforcement differs by platform and there is no pretending otherwise:
//! Landlock on Linux, Seatbelt on macOS, and nothing at all on Windows. The
//! capability report exists so a caller can decide what to do about that
//! *before* it starts an agent, rather than discovering it afterwards.

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

use napi::Error;

/// Walk depth for building rules. Matches `file::list_files` and
/// `permissions::scan_project` so the config, the scan and the enforced rules
/// all describe the same tree.
///
/// Only the platforms that build rules consume this; on Windows there is no
/// backend to read it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const MAX_DEPTH: u32 = 8;

/// How well this platform can confine the filesystem.
///
/// `enforced` — the kernel denies access outside the policy.
/// `partial`  — enforced, but an older kernel cannot honour every restriction.
/// `unsupported` — nothing is enforced. Not a degraded mode: no confinement.
#[napi(object)]
#[derive(Debug)]
pub struct SandboxCapabilities {
    pub platform: String,
    pub filesystem: String,
    /// `landlock`, `seatbelt`, or `none`.
    pub mechanism: String,
    pub details: String,
    /// Landlock ABI version, when the mechanism is Landlock.
    pub abi: Option<u32>,
}

#[napi(object)]
pub struct SandboxConfig {
    pub project_dir: String,
    /// Extra paths granted read+execute — toolchains, interpreters.
    pub read_execute_paths: Option<Vec<String>>,
    /// Extra paths granted read+write without execute — agent state, logs,
    /// tokens. These hold data, not binaries.
    pub read_write_paths: Option<Vec<String>>,
    /// Per-file permissions. When absent the whole project is read-write.
    pub permissions: Option<crate::permissions::PermissionsConfig>,
    /// Proceed on a platform that cannot enforce anything.
    ///
    /// Without this, `applySandbox` fails on such a platform rather than
    /// returning a success that implies confinement it did not apply.
    pub allow_unenforced: Option<bool>,
}

#[napi(object)]
#[derive(Debug)]
pub struct SandboxResult {
    /// Whether the kernel is now actually enforcing a policy. False only when
    /// the caller opted in via `allowUnenforced`.
    pub enforced: bool,
    pub mechanism: String,
    /// Anything the caller should surface: an unenforceable restriction on an
    /// old kernel, a system path that could not be added, or the fact that
    /// nothing was enforced at all.
    pub warnings: Vec<String>,
}

#[cfg(target_os = "linux")]
fn capabilities_impl() -> SandboxCapabilities {
    match linux::detect_abi() {
        Ok(abi) => {
            let degraded = linux::degraded_note(abi);
            SandboxCapabilities {
                platform: "linux".into(),
                filesystem: if degraded.is_some() {
                    "partial".into()
                } else {
                    "enforced".into()
                },
                mechanism: "landlock".into(),
                details: degraded.unwrap_or_else(|| {
                    format!("Landlock ABI {}: all filesystem restrictions enforced", abi)
                }),
                abi: Some(abi as u32),
            }
        }
        Err(e) => SandboxCapabilities {
            platform: "linux".into(),
            filesystem: "unsupported".into(),
            mechanism: "none".into(),
            details: e,
            abi: None,
        },
    }
}

#[cfg(target_os = "macos")]
fn capabilities_impl() -> SandboxCapabilities {
    SandboxCapabilities {
        platform: "macos".into(),
        filesystem: "enforced".into(),
        mechanism: "seatbelt".into(),
        details: "Seatbelt (sandbox_init): filesystem access confined to the policy. \
                  The SPI is deprecated by Apple but functional."
            .into(),
        abi: None,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn capabilities_impl() -> SandboxCapabilities {
    SandboxCapabilities {
        platform: std::env::consts::OS.to_string(),
        filesystem: "unsupported".into(),
        mechanism: "none".into(),
        details: "No filesystem confinement is available on this platform. An agent \
                  run here can read and write anything the user can."
            .into(),
        abi: None,
    }
}

/// What this platform can enforce. Safe to call at any time; changes nothing.
#[napi]
pub fn sandbox_capabilities() -> SandboxCapabilities {
    capabilities_impl()
}

/// Confine the **current process** to the given policy.
///
/// This is irreversible and process-wide: it applies to this Node process and
/// every child it spawns afterwards, and cannot be lifted. Call it immediately
/// before handing control to the agent, never speculatively — once applied, the
/// harness itself is subject to it too.
///
/// Fails on a platform with no enforcement unless `allowUnenforced` is set, so
/// the unconfined case has to be chosen rather than stumbled into.
#[napi]
pub fn apply_sandbox(config: SandboxConfig) -> Result<SandboxResult, Error> {
    let capabilities = capabilities_impl();

    if capabilities.filesystem == "unsupported" {
        if config.allow_unenforced.unwrap_or(false) {
            return Ok(SandboxResult {
                enforced: false,
                mechanism: "none".into(),
                warnings: vec![format!(
                    "NOT SANDBOXED: {} Proceeding because allowUnenforced was set.",
                    capabilities.details
                )],
            });
        }

        return Err(Error::from_reason(format!(
            "Refusing to continue unconfined: {} Pass allowUnenforced to proceed anyway.",
            capabilities.details
        )));
    }

    apply_impl(&config).map_err(Error::from_reason)
}

#[cfg(target_os = "linux")]
fn apply_impl(config: &SandboxConfig) -> Result<SandboxResult, String> {
    let (mut warnings, degraded) = linux::apply(config)?;
    warnings.extend(degraded);

    Ok(SandboxResult {
        enforced: true,
        mechanism: "landlock".into(),
        warnings,
    })
}

#[cfg(target_os = "macos")]
fn apply_impl(config: &SandboxConfig) -> Result<SandboxResult, String> {
    let (mut warnings, note) = macos::apply(config)?;
    warnings.extend(note);

    Ok(SandboxResult {
        enforced: true,
        mechanism: "seatbelt".into(),
        warnings,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn apply_impl(_config: &SandboxConfig) -> Result<SandboxResult, String> {
    // Unreachable: apply_sandbox returns before here when nothing is enforceable.
    Err("No sandbox mechanism on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_self_consistent() {
        let caps = capabilities_impl();

        assert!(matches!(
            caps.filesystem.as_str(),
            "enforced" | "partial" | "unsupported"
        ));
        assert!(!caps.details.is_empty(), "a report must explain itself");

        // "unsupported" and a named mechanism are contradictory, and so are
        // "enforced" and no mechanism. Either would mislead a caller about
        // whether confinement is real.
        if caps.filesystem == "unsupported" {
            assert_eq!(caps.mechanism, "none");
        } else {
            assert_ne!(caps.mechanism, "none");
        }
    }

    #[test]
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn unsupported_platforms_refuse_by_default() {
        let config = SandboxConfig {
            project_dir: ".".into(),
            read_execute_paths: None,
            read_write_paths: None,
            permissions: None,
            allow_unenforced: None,
        };

        let err = apply_sandbox(config).unwrap_err();
        assert!(err.reason.contains("Refusing to continue unconfined"));
    }

    #[test]
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn opting_in_reports_that_nothing_was_enforced() {
        let config = SandboxConfig {
            project_dir: ".".into(),
            read_execute_paths: None,
            read_write_paths: None,
            permissions: None,
            allow_unenforced: Some(true),
        };

        let result = apply_sandbox(config).unwrap();
        assert!(!result.enforced);
        assert!(result.warnings.iter().any(|w| w.contains("NOT SANDBOXED")));
    }
}
