import { useState } from 'react'
import TodoItem from './TodoItem.jsx'

function TodoList({ todos, onToggle, onDelete, onEdit }) {
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')

  const handleEdit = (id, text) => {
    setEditingId(id)
    setEditText(text)
  }

  const handleSave = (id) => {
    // BUG 1: Not validating empty text
    onEdit(id, editText)
    setEditingId(null)
    setEditText('')
  }

  const handleCancel = () => {
    setEditingId(null)
    setEditText('')
  }

  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        // BUG 2: Using index as key when items can be deleted/reordered
        // This causes incorrect component reuse and state bugs
        <TodoItem
          key={todo.id}
          todo={todo}
          isEditing={editingId === todo.id}
          editText={editText}
          onToggle={() => onToggle(todo.id)}
          onDelete={() => onDelete(todo.id)}
          onEdit={() => handleEdit(todo.id, todo.text)}
          onSave={() => handleSave(todo.id)}
          onCancel={handleCancel}
          onEditTextChange={setEditText}
        />
      ))}
    </ul>
  )
}

export default TodoList
