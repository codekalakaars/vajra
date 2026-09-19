import { useState } from 'react'

function TodoForm({ onAdd }) {
  const [text, setText] = useState('')

  // BUG 1: Not preventing default form submission
  const handleSubmit = (e) => {
        e.preventDefault(); // Prevent the default form submission to avoid page reload during adding todos
    // This causes page reload on form submit
    
    // BUG 2: Not validating empty input
    onAdd(text)
    setText('')
  }

  return (
    <form onSubmit={handleSubmit} className="todo-form">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What needs to be done?"
        className="todo-input"
      />
      <button type="submit" className="add-button">Add</button>
    </form>
  )
}

export default TodoForm
