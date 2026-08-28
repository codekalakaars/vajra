// Status badge component.

import { h } from '../router.js'

export function statusBadge(status: string): HTMLElement {
  return h('span', { className: `badge badge-${status}` }, status)
}
