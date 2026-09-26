// Generalized test identity.
//
// The first version of this package identified a test by the file that
// contained it. That is a JavaScript-shaped assumption: it excludes a Rust
// `#[test]`, a Go test function, a Python unittest method, a JUnit `classname`,
// and every API exercised over HTTP or gRPC — which is most of what "any API
// in any language" means.
//
// A test case is therefore identified by a target: a kind plus a stable
// reference. File paths are the most common case, not the only case.

export type TargetKind =
  /** A test file in the repository. */
  | 'file'
  /** A suite identified by name, with no file — typical of JUnit classnames. */
  | 'suite'
  /** An HTTP endpoint. */
  | 'http'
  /** A gRPC or other RPC method. */
  | 'grpc'
  /** A spawned process or command. */
  | 'process'
  /** A WebAssembly module invoked over WASI. */
  | 'wasi'
  /** A test derived from an API contract rather than a test file. */
  | 'contract'
  /** A command-line program or script. */
  | 'cli'

export interface TestTarget {
  kind: TargetKind
  /**
   * Stable identity within the kind: a repo-relative path, a URL, a
   * `package.Service/Method`, a module name. Used for attribution and cache
   * keys, so it must not change between runs for the same subject.
   */
  ref: string
}

export function fileTarget(ref: string): TestTarget {
  return { kind: 'file', ref }
}

export function suiteTarget(ref: string): TestTarget {
  return { kind: 'suite', ref }
}

export function httpTarget(ref: string): TestTarget {
  return { kind: 'http', ref }
}

export function contractTarget(ref: string): TestTarget {
  return { kind: 'contract', ref }
}

export function cliTarget(ref: string): TestTarget {
  return { kind: 'cli', ref }
}

export function isFileTarget(target: TestTarget): boolean {
  return target.kind === 'file'
}

/**
 * A stable identity for one test case, used as the result id and the flake
 * history key. It must be unique across the whole submission, because two
 * suites in different languages may both contain a test called `test_login`.
 */
export function testId(target: TestTarget, name: string): string {
  return `${target.kind}:${target.ref}::${name}`
}
