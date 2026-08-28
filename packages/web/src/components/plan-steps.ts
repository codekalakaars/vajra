// Plan steps component.

import { h } from '../router.js'

interface PlanStep {
  index: number
  title: string
  status: 'pending' | 'active' | 'done' | 'skipped'
}

export function planSteps(steps: PlanStep[]): HTMLElement {
  const list = h('ol', { className: 'plan-steps' })

  for (const step of steps) {
    const icon = h('span', { className: `step-icon ${step.status}` }, getStepIcon(step.status))
    const item = h('li', { className: 'plan-step' }, icon, h('span', { className: 'step-title' }, step.title))
    list.appendChild(item)
  }

  return list
}

function getStepIcon(status: string): string {
  switch (status) {
    case 'done': return '\u2713'
    case 'active': return '\u25B6'
    case 'skipped': return '\u2013'
    default: return String((parseInt((status as string) || '0') || 0) + 1)
  }
}
