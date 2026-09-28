// Platform gate. Import this FIRST in an entry point, before anything that
// transitively loads `@codekalakaars/vajra-core`.
//
// ESM evaluates all imported modules before the importing module's own body, so
// an inline `assertSupportedPlatform()` call in the entry point would run after
// the addon had already loaded — the user would see a bare "Unsupported OS:
// win32" from the napi loader, which says nothing about why. A side-effecting
// import placed first runs before its siblings, so they get the real reason.
//
// Exists as its own module, rather than as a side effect of importing
// vajra-sandbox, because most of that package is pure policy code that a build
// script or a test may legitimately want on any platform.

import { assertSupportedPlatform } from './platform.js'

assertSupportedPlatform()
