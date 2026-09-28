#![deny(clippy::all)]
// The #[napi] exports are reachable only through the generated Node bindings,
// which are not built for `cargo test`, so the test profile sees them as dead.
#![cfg_attr(test, allow(dead_code))]

// Vajra is Linux-only. Confinement is Landlock, a Linux LSM, and nothing
// equivalent exists elsewhere, so a non-Linux build would ship a binary that
// cannot do the one thing it exists to do. The JS entry points already refuse
// unsupported platforms (see packages/sandbox/src/platform.ts); this makes the
// refusal a build failure instead of a runtime surprise, so a stray
// `cargo build` on a Mac cannot quietly produce a macOS artifact.
#[cfg(not(target_os = "linux"))]
compile_error!("vajra-core targets Linux only; see packages/sandbox/src/platform.ts");

mod env;
mod envfile;
mod file;
mod path;
mod permissions;
mod process;
mod sandbox;
mod secret;

#[macro_use]
extern crate napi_derive;

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
