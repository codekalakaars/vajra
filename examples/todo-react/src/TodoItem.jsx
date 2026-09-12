function TodoItem({ 
  todo, 
  isEditing, 
  editText, 
  onToggle, 
  onDelete, 
  onEdit, 
  onSave, 
  onCancel,
  onEditTextChange 
}) {
  return (
    <li className={`todo-item ${todo.completed ? 'completed' : ''}`}>
      {isEditing ? (
        <div className="edit-mode">
          <input
            type="text"
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            className="edit-input"
          />
          <button onClick={onSave} className="save-button">Save</button>
          <button onClick={onCancel} className="cancel-button">Cancel</button>
        </div>
      ) : (
        <div className="view-mode">
          {/* BUG 1: Not using label element for accessibility */}
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={onToggle}
            className="todo-checkbox"
          />
          {/* BUG 2: Not handling long text - no word wrap or truncation */}
          <span className="todo-text">{todo.text}</span>
          <button onClick={onEdit} className="edit-button">Edit</button>
          <button onClick={onDelete} className="delete-button">Delete</button>
        </div>
      )}
    </li>
  )
}

export default TodoItem
