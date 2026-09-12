# Todo API

A simple REST API for managing todos.

## Current Issues

### 1. No Input Validation
- Empty titles are accepted
- Titles over 500 characters are accepted
- No validation on PUT requests

### 2. No Error Handling
- JSON parse errors return 500 instead of 400
- Missing error messages in responses

### 3. No Data Validation
- Concurrent writes can corrupt data.json
- No file locking mechanism

### 4. Missing Features
- No pagination for GET /todos
- No filtering by completed status
- No sorting options

### 5. Security Issues
- No authentication
- No rate limiting
- CORS is wide open

## API Endpoints

- `GET /todos` - List all todos
- `GET /todos/:id` - Get a specific todo
- `POST /todos` - Create a new todo
- `PUT /todos/:id` - Update a todo
- `DELETE /todos/:id` - Delete a todo

## Running

```bash
npm run dev
```

## Testing

```bash
npm test
```
