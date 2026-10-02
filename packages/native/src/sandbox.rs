mod linux;

use napi::Error;

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

fn apply_impl(config: &SandboxConfig) -> Result<SandboxResult, String> {
    let (mut warnings, degraded) = linux::apply(config)?;
    warnings.extend(degraded);

    Ok(SandboxResult {
        enforced: true,
        mechanism: "landlock".into(),
        warnings,
    })
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

    /// `allowUnenforced` is the escape hatch for a host with no Landlock — a
    /// kernel older than 5.13. Both refusal paths must hold there, and neither
    /// may be reached by actually confining this test process, so each test
    /// skips when a mechanism *is* available.
    fn unenforceable_host() -> bool {
        capabilities_impl().filesystem == "unsupported"
    }

    #[test]
    fn unenforceable_hosts_refuse_by_default() {
        if !unenforceable_host() {
            return;
        }

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
    fn opting_in_reports_that_nothing_was_enforced() {
        if !unenforceable_host() {
            return;
        }

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
