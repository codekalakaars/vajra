#!/usr/bin/env node

/**
 * Example: How the Vajra multi-agent system fixes the React Todo App
 * 
 * This script demonstrates the workflow:
 * 1. User sends a message about bugs
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

console.log('=== Vajra Multi-Agent Workflow: React Todo App Fix ===\n');

console.log('1. USER REQUEST:');
console.log('   "Fix the bugs in my React Todo App. It has state mutation,');
console.log('    missing keys, form handling, and filter issues."\n');

console.log('2. MANAGER EXPLORES CODEBASE:');
console.log('   - Reads src/App.jsx, src/TodoForm.jsx, src/TodoList.jsx');
console.log('   - Reads src/TodoItem.jsx, src/TodoStats.jsx');
console.log('   - Identifies 10 bugs across 5 files');
console.log('   - Asks clarifying questions about validation rules');
console.log();

console.log('3. MANAGER PROPOSES PLAN:');
console.log(`   Summary: ${plan.summary}`);
console.log(`   Tasks: ${plan.tasks.length}`);
plan.tasks.forEach((task, i) => {
  console.log(`   ${i + 1}. ${task.title}`);
  console.log(`      Type: ${task.type}`);
  console.log(`      Reads: ${task.readFile.join(', ')}`);
  console.log(`      Writes: ${task.writeFile.join(', ')}`);
  console.log(`      Instructions: ${task.instructions.length} steps`);
});
console.log();

console.log('4. USER CONFIRMS PLAN');
console.log();

console.log('5. MASTER ORCHESTRATES WORKERS:');
console.log('   - All 10 tasks have no dependencies');
console.log('   - Launching 10 workers in parallel');
console.log('   - File conflicts detected:');
console.log('     * src/App.jsx: 6 tasks write to this file');
console.log('     * src/TodoForm.jsx: 2 tasks write to this file');
console.log('     * src/TodoList.jsx: 2 tasks write to this file');
console.log('   - Master sequences conflicting tasks');
console.log();

console.log('6. WORKERS EXECUTE:');
plan.tasks.forEach((task, i) => {
  console.log(`   Worker ${i + 1}: ${task.title}`);
  console.log(`   - Reads: ${task.readFile.join(', ')}`);
  console.log(`   - Writes: ${task.writeFile.join(', ')}`);
  console.log(`   - Follows ${task.instructions.length} step-by-step instructions`);
});
console.log();

console.log('7. VALIDATION:');
console.log('   Each worker runs "npm test" after completing the task.');
console.log('   Tests verify:');
console.log('   - Todos can be added');
console.log('   - Empty todos are rejected');
console.log('   - Todos can be toggled');
console.log('   - Todos can be deleted');
console.log('   - Filters work correctly');
console.log('   - Stats show correct values');
console.log();

console.log('8. RESULTS:');
console.log('   - 10 tasks completed successfully');
console.log('   - Total tool calls: 45');
console.log('   - Summary: Fixed state mutation, unique keys, form handling,');
console.log('     filter logic, division by zero, input validation, and localStorage');
console.log();

console.log('=== Bug Details ===\n');

const bugs = [
  { file: 'src/App.jsx', line: 24, bug: 'State mutation with todos.push()', fix: 'Use setTodos([...todos, newTodo])' },
  { file: 'src/TodoList.jsx', line: 28, bug: 'Using index as key', fix: 'Use todo.id as key' },
  { file: 'src/TodoForm.jsx', line: 8, bug: 'Missing e.preventDefault()', fix: 'Add e.preventDefault() at start of handler' },
  { file: 'src/App.jsx', line: 48, bug: 'Incorrect filter logic (swapped)', fix: 'Swap active/completed conditions' },
  { file: 'src/TodoStats.jsx', line: 8, bug: 'Division by zero', fix: 'Add guard clause for total === 0' },
  { file: 'src/TodoForm.jsx', line: 9, bug: 'No empty input validation', fix: 'Add if (!text.trim()) return' },
  { file: 'src/App.jsx', line: 42, bug: 'clearCompleted removes all', fix: 'Filter to keep non-completed' },
  { file: 'src/TodoList.jsx', line: 17, bug: 'No validation on edit', fix: 'Add if (!editText.trim()) return' },
  { file: 'src/App.jsx', line: 14, bug: 'localStorage not updating', fix: 'Separate useEffect for saving' },
  { file: 'src/App.jsx', line: 32, bug: 'toggleTodo mutates state', fix: 'Use map to create new objects' },
];

bugs.forEach((bug, i) => {
  console.log(`Bug ${i + 1}: ${bug.bug}`);
  console.log(`  File: ${bug.file}:${bug.line}`);
  console.log(`  Fix: ${bug.fix}`);
  console.log();
});

console.log('=== Security Model ===\n');
console.log('Each worker has:');
console.log('- Read-only access to files it needs to read');
console.log('- Read-write access to files it needs to modify');
console.log('- Only the tools it needs (read_file, edit_file, write_file)');
console.log('- No access to other files or system commands');
console.log();
console.log('This ensures:');
console.log('- Workers can only modify their assigned files');
console.log('- No accidental changes to unrelated code');
console.log('- Full audit trail of all changes');
