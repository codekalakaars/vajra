import { useState, useEffect } from 'react'
import TodoList from './TodoList.jsx'
import TodoForm from './TodoForm.jsx'
import TodoStats from './TodoStats.jsx'

function App() {
  const [todos, setTodos] = useState([])
  const [filter, setFilter] = useState('all')

  // BUG 1: Missing dependency in useEffect - todos not in dependency array
  // This means localStorage won't update when todos change
  useEffect(() => {
    const saved = localStorage.getItem('todos')
    if (saved) {
      setTodos(JSON.parse(saved))
    }
  }, [])

  // BUG 2: Mutation instead of immutable update
  // This directly mutates the state array
  const addTodo = (text) => {
    const newTodo = {
      id: Date.now(),
      text,
      completed: false,
      createdAt: new Date().toISOString()
    }
    todos.push(newTodo)  // BUG: Direct mutation
    setTodos(todos)
    localStorage.setItem('todos', JSON.stringify(todos))
  }

  // BUG 3: Using index as key when items can be deleted
  // This causes incorrect component reuse
  const toggleTodo = (id) => {
    // BUG 4: Not creating new array, mutating existing
    todos.forEach(todo => {
      if (todo.id === id) {
        todo.completed = !todo.completed
      }
    })
    setTodos([...todos])
    localStorage.setItem('todos', JSON.stringify(todos))
  }

  // BUG 5: Not filtering properly - missing return statement in arrow function
  const deleteTodo = (id) => {
    const filtered = todos.filter(todo => todo.id !== id)
    setTodos(filtered)
    localStorage.setItem('todos', JSON.stringify(filtered))
  }

  // BUG 6: Not handling empty input validation
  const editTodo = (id, newText) => {
    const updated = todos.map(todo => {
      if (todo.id === id) {
        return { ...todo, text: newText }  // BUG: No validation on newText
      }
      return todo
    })
    setTodos(updated)
    localStorage.setItem('todos', JSON.stringify(updated))
  }

  // BUG 7: Incorrect filter logic - 'completed' filter shows incomplete
  const filteredTodos = todos.filter(todo => {
    if (filter === 'active') return todo.completed  // BUG: Should be !todo.completed
    if (filter === 'completed') return !todo.completed  // BUG: Should be todo.completed
    return true
  })

  // BUG 8: Not handling clear completed properly
  const clearCompleted = () => {
    // BUG: This removes all todos, not just completed
    setTodos([])
    localStorage.setItem('todos', JSON.stringify([]))
  }

  return (
    <div className="app">
      <h1>Todo App</h1>
      <TodoForm onAdd={addTodo} />
      <TodoList 
        todos={filteredTodos} 
        onToggle={toggleTodo} 
        onDelete={deleteTodo}
        onEdit={editTodo}
      />
      <TodoStats todos={todos} />
      <div className="filters">
        <button onClick={() => setFilter('all')}>All</button>
        <button onClick={() => setFilter('active')}>Active</button>
        <button onClick={() => setFilter('completed')}>Completed</button>
        <button onClick={clearCompleted}>Clear Completed</button>
      </div>
    </div>
  )
}

export default App
