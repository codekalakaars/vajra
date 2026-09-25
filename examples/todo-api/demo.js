#!/usr/bin/env node

/**
 * Example: How the Vajra multi-agent system processes a task
 * 
 * This script demonstrates the flow:
 * 1. User sends a message
 * 2. Manager discusses and proposes a plan
 * 3. User confirms
 * 4. Master orchestrates workers
 * 5. Workers execute tasks
 * 6. Results are reported
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Load the example plan
const plan = JSON.parse(readFileSync(join(import.meta.dirname, 'example-plan.json'), 'utf-8'));

console.log('=== Vajra Multi-Agent Workflow Example ===\n');

console.log('1. USER REQUEST:');
console.log('   "Fix the issues in my Todo API. It needs input validation,');
console.log('    better error handling, and some missing features."\n');

console.log('2. MANAGER PROPOSES PLAN:');
console.log(`   Summary: ${plan.summary}`);
console.log(`   Tasks: ${plan.tasks.length}`);
plan.tasks.forEach((task, i) => {
  console.log(`   ${i + 1}. ${task.title}`);
  console.log(`      Type: ${task.type}`);
  console.log(`      Reads: ${task.readFile.join(', ')}`);
  console.log(`      Writes: ${task.writeFile.join(', ')}`);
  console.log(`      Validates: ${task.validation.join(', ')}`);
  console.log(`      Instructions: ${task.instructions.length} steps`);
});
console.log();

console.log('3. USER CONFIRMS PLAN');
console.log();

console.log('4. MASTER ORCHESTRATES WORKERS:');
console.log('   - All 5 tasks have no dependencies');
console.log('   - Launching 5 workers in parallel');
console.log();

console.log('5. WORKERS EXECUTE:');
plan.tasks.forEach((task, i) => {
  console.log(`   Worker ${i + 1}: ${task.title}`);
  console.log(`   - Reads: ${task.readFile.join(', ')}`);
  console.log(`   - Writes: ${task.writeFile.join(', ')}`);
  console.log(`   - Follows ${task.instructions.length} step-by-step instructions`);
  console.log(`   - Validates with: ${task.validation.join(' && ')}`);
});
console.log();

console.log('6. VALIDATION:');
console.log('   Each worker runs its validation commands after completing the task.');
console.log('   If validation fails, the worker retries up to 2 times.');
console.log();

console.log('7. RESULTS:');
console.log('   - 4 tasks completed successfully');
console.log('   - 1 task failed (rate limiter tests need fixing)');
console.log('   - Total tool calls: 47');
console.log('   - Summary: Added input validation, JSON error handling, file locking,');
console.log('     and filtering/pagination. Rate limiter needs test fixes.');
console.log();

console.log('=== Key Benefits ===');
console.log('- Deterministic: Workers follow exact instructions');
console.log('- Secure: Each worker only has access to files it needs');
console.log('- Parallel: Independent tasks run simultaneously');
console.log('- Validated: Every change is verified by tests');
console.log('- Traceable: Full audit trail of what each worker did');
