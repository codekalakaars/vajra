// Platform gate. Import this first in an entry point, before anything that
// transitively loads `@codekalakaars/vajra-core`.
//
// ESM evaluates all imported modules before the importing module's own body, so
// an `assertSupportedPlatform()` call written inline in index.ts would run after
// the addon had already loaded — on Windows that surfaces as a bare
// "Unsupported OS: win32" from the napi loader, which says nothing about why.
// A side-effecting import placed first runs before its siblings, so the user
// gets the real reason instead.

import { assertSupportedPlatform } from '@codekalakaars/vajra-sandbox'

assertSupportedPlatform()
