#![deny(clippy::all)]
// The #[napi] exports are reachable only through the generated Node bindings,
// which are not built for `cargo test`, so the test profile sees them as dead.
#![cfg_attr(test, allow(dead_code))]

mod env;
mod file;
mod path;
mod process;

#[macro_use]
extern crate napi_derive;

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
