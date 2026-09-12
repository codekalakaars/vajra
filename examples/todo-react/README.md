# Todo React App (With Bugs)

A simple React todo application with intentional bugs for testing the Vajra multi-agent system.

## Known Bugs

### Bug 1: Missing Unique Keys
**File:** `src/TodoList.jsx`
**Line:** 28
**Issue:** Using `index` as key when items can be deleted/reordered
**Impact:** Incorrect component reuse, state bugs when items are deleted
**Fix:** Use `todo.id` as key instead of `index`

### Bug 2: State Mutation
**File:** `src/App.jsx`
**Line:** 24
**Issue:** Directly mutating state array with `todos.push(newTodo)`
**Impact:** React doesn't detect changes, UI doesn't update
**Fix:** Use `setTodos([...todos, newTodo])` instead

### Bug 3: Missing Form Prevention
**File:** `src/TodoForm.jsx`
**Line:** 8
**Issue:** Missing `e.preventDefault()` in form submit handler
**Impact:** Page reloads on form submit, data lost
**Fix:** Add `e.preventDefault()` at start of handler

### Bug 4: Incorrect Filter Logic
**File:** `src/App.jsx`
**Lines:** 48-49
**Issue:** Active/completed filters are swapped
**Impact:** 'Active' shows completed todos, 'completed' shows active
**Fix:** Swap the conditions

### Bug 5: Division by Zero
**File:** `src/TodoStats.jsx`
**Line:** 8
**Issue:** `percentage = (completed / total) * 100` when total is 0
**Impact:** Shows NaN% when no todos exist
**Fix:** Add check: `total === 0 ? 0 : ...`

### Bug 6: Missing Input Validation
**File:** `src/TodoForm.jsx`
**Line:** 9
**Issue:** Not validating empty text before adding
**Impact:** Empty todos can be added
**Fix:** Add `if (!text.trim()) return` before `onAdd(text)`

### Bug 7: Not Preventing Default
**File:** `src/TodoForm.jsx`
**Line:** 8
**Issue:** Form submission reloads page
**Impact:** User loses all data on submit
**Fix:** Add `e.preventDefault()`

### Bug 8: localStorage Not Updating
**File:** `src/App.jsx`
**Line:** 14
**Issue:** `useEffect` missing `todos` in dependency array
**Impact:** localStorage only saves initial state, not updates
**Fix:** Add `[todos]` to dependency array (but be careful of infinite loop)

### Bug 9: Clear Completed Removes All
**File:** `src/App.jsx`
**Line:** 42
**Issue:** `clearCompleted` sets todos to empty array
**Impact:** All todos are deleted, not just completed ones
**Fix:** Filter to keep only non-completed: `setTodos(todos.filter(t => !t.completed))`

### Bug 10: No Empty Text Validation on Edit
**File:** `src/TodoList.jsx`
**Line:** 17
**Issue:** `handleSave` doesn't validate empty text
**Impact:** Todos can be edited to empty strings
**Fix:** Add validation before calling `onEdit`

## Running the App

```bash
npm install
npm run dev
```

## Running Tests

```bash
npm test
```

## API Endpoints

This is a client-side only app. No backend required.

## File Structure

```
src/
  main.jsx          # Entry point
  App.jsx           # Main component (with bugs)
  TodoForm.jsx      # Form component (with bugs)
  TodoList.jsx      # List component (with bugs)
  TodoItem.jsx      # Item component (with bugs)
  TodoStats.jsx     # Stats component (with bugs)
  index.css         # Styles
  test/
    setup.js        # Test setup
    App.test.jsx    # Tests (will fail due to bugs)
```
