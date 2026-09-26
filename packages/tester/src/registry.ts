// Test-to-task binding, established when the Developer builds Phase One.
//
// The registry is the authority on which task owns which test. It is populated
// at submission time rather than discovered from filenames, because "which
// test belongs to which task" is a planning fact — inferring it from a naming
// convention is exactly the runtime derivation ADR-0005 forbids.
//
// A binding is keyed on `ref`: whatever the runner understands as a selector.
// For a file-based runner that is a path; for an API target it is a probe id;
// for a contract-derived target it is an operation name. Keying on a path
// specifically would make every non-file target unaddressable.

import type { PhaseOneKind } from './verdict.js'
import type { TestTarget } from './target.js'

export interface TestBinding {
  /**
   * What to pass to the runner to select this test — a file path for a
   * file-based runner, a probe id for an API target.
   */
  ref: string
  taskId: string
  phase: number
  kind?: PhaseOneKind
  /** Present when the test exercises something other than a file. */
  target?: TestTarget
}

export class TestRegistry {
  private readonly byRef = new Map<string, TestBinding>()
  private readonly byTask = new Map<string, Set<string>>()

  register(binding: TestBinding): void {
    this.byRef.set(binding.ref, binding)
    let refs = this.byTask.get(binding.taskId)
    if (!refs) this.byTask.set(binding.taskId, (refs = new Set()))
    refs.add(binding.ref)
  }

  /** The task that owns a test, if any. */
  ownerOf(ref: string): string | undefined {
    return this.byRef.get(ref)?.taskId
  }

  bindingFor(ref: string): TestBinding | undefined {
    return this.byRef.get(ref)
  }

  /** The refs a task declared, sorted so runs are deterministic. */
  testsFor(taskId: string): string[] {
    return [...(this.byTask.get(taskId) ?? [])].sort()
  }

  /**
   * Resolve a diagnostic to the task that can fix it. Exact ref first, then a
   * target-identity match, because a diagnostic names what it found wrong
   * (`POST /login`) while a binding may key on a selector (`login`).
   */
  resolveOwner(candidates: readonly string[]): string | undefined {
    for (const candidate of candidates) {
      const owner = this.byRef.get(candidate)?.taskId
      if (owner) return owner
    }
    return undefined
  }

  all(): TestBinding[] {
    return [...this.byRef.values()]
  }

  get size(): number {
    return this.byRef.size
  }
}
