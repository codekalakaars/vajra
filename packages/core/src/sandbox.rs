#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

use napi::Error;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub const MAX_DEPTH: u32 = 8;

#[napi(object)]
#[derive(Debug)]
pub struct SandboxCapabilities {
    pub platform: String,
    pub filesystem: String,
    pub mechanism: String,
    pub details: String,
    pub abi: Option<u32>,
}

#[napi(object)]
pub struct SandboxConfig {
    pub project_dir: String,
    pub read_execute_paths: Option<Vec<String>>,
    pub read_write_paths: Option<Vec<String>>,
    pub permissions: Option<crate::permissions::PermissionsConfig>,
    pub allow_unenforced: Option<bool>,
}

#[napi(object)]
#[derive(Debug)]
pub struct SandboxResult {
    pub enforced: bool,
    pub mechanism: String,
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

#[napi]
pub fn sandbox_capabilities() -> SandboxCapabilities {
    capabilities_impl()
}

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
        assert!(!caps.details.is_empty());

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
