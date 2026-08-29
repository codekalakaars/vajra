#![deny(clippy::all)]
// The #[napi] exports are reachable only through the generated Node bindings,
// which are not built for `cargo test`, so the test profile sees them as dead.
#![cfg_attr(test, allow(dead_code))]

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
