import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import App from '../App.jsx'

describe('Todo App', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('should render the app', () => {
    render(<App />)
    expect(screen.getByText('Todo App')).toBeInTheDocument()
  })

  it('should add a todo', () => {
    render(<App />)
    const input = screen.getByPlaceholderText('What needs to be done?')
    const button = screen.getByText('Add')
    
    fireEvent.change(input, { target: { value: 'Test todo' } })
    fireEvent.click(button)
    
    expect(screen.getByText('Test todo')).toBeInTheDocument()
  })

  it('should not add empty todo', () => {
    render(<App />)
    const button = screen.getByText('Add')
    
    fireEvent.click(button)
    
    // BUG: This should fail because empty todos are added
    expect(screen.queryByText('')).not.toBeInTheDocument()
  })

  it('should toggle todo completion', () => {
    render(<App />)
    const input = screen.getByPlaceholderText('What needs to be done?')
    const button = screen.getByText('Add')
    
    fireEvent.change(input, { target: { value: 'Test todo' } })
    fireEvent.click(button)
    
    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    
    expect(checkbox).toBeChecked()
  })

  it('should delete a todo', () => {
    render(<App />)
    const input = screen.getByPlaceholderText('What needs to be done?')
    const addButton = screen.getByText('Add')
    
    fireEvent.change(input, { target: { value: 'Test todo' } })
    fireEvent.click(addButton)
    
    const deleteButton = screen.getByText('Delete')
    fireEvent.click(deleteButton)
    
    expect(screen.queryByText('Test todo')).not.toBeInTheDocument()
  })

  it('should filter active todos', () => {
    render(<App />)
    const input = screen.getByPlaceholderText('What needs to be done?')
    const addButton = screen.getByText('Add')
    
    // Add two todos
    fireEvent.change(input, { target: { value: 'Active todo' } })
    fireEvent.click(addButton)
    
    fireEvent.change(input, { target: { value: 'Completed todo' } })
    fireEvent.click(addButton)
    
    // Complete one todo
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[1])
    
    // Filter active
    const activeButton = screen.getByText('Active')
    fireEvent.click(activeButton)
    
    // BUG: This should show only active todos, but shows completed
    expect(screen.getByText('Active todo')).toBeInTheDocument()
    expect(screen.queryByText('Completed todo')).not.toBeInTheDocument()
  })

  it('should show correct stats', () => {
    render(<App />)
    const input = screen.getByPlaceholderText('What needs to be done?')
    const addButton = screen.getByText('Add')
    
    fireEvent.change(input, { target: { value: 'Test todo' } })
    fireEvent.click(addButton)
    
    expect(screen.getByText('Total: 1')).toBeInTheDocument()
    expect(screen.getByText('Active: 1')).toBeInTheDocument()
    expect(screen.getByText('Completed: 0')).toBeInTheDocument()
    // BUG: This shows NaN when no completed todos
    expect(screen.getByText('Progress: 0%')).toBeInTheDocument()
  })
})
