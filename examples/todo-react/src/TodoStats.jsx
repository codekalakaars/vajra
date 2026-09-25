function TodoStats({ todos }) {
  // BUG 1: Not handling empty todos array
  const total = todos.length
  const completed = todos.filter(t => t.completed).length
  const active = total - completed

  // BUG 2: Division by zero when no todos
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

  // BUG 3: Not formatting percentage correctly
  // Shows NaN when no todos
  
  return (
    <div className="todo-stats">
      <p>Total: {total}</p>
      <p>Active: {active}</p>
      <p>Completed: {completed}</p>
      {/* BUG 4: Shows NaN when no todos */}
      <p>Progress: {percentage}%</p>
    </div>
  )
}

export default TodoStats
