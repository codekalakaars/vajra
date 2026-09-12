import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const PORT = 3000;
const DATA_FILE = join(process.cwd(), 'data.json');

// Load todos from file
async function loadTodos() {
  try {
    const data = await readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// Save todos to file
async function saveTodos(todos) {
  await writeFile(DATA_FILE, JSON.stringify(todos, null, 2));
}

// Parse JSON body
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(JSON.parse(body)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // GET /todos
    if (req.method === 'GET' && url.pathname === '/todos') {
      const todos = await loadTodos();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(todos));
    }

    // GET /todos/:id
    if (req.method === 'GET' && url.pathname.startsWith('/todos/')) {
      const id = parseInt(url.pathname.split('/')[2]);
      const todos = await loadTodos();
      const todo = todos.find(t => t.id === id);
      if (!todo) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Todo not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(todo));
    }

    // POST /todos
    if (req.method === 'POST' && url.pathname === '/todos') {
      const body = await parseBody(req);
      const todos = await loadTodos();
      const newTodo = {
        id: todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1,
        title: body.title,
        completed: false,
        createdAt: new Date().toISOString()
      };
      todos.push(newTodo);
      await saveTodos(todos);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(newTodo));
    }

    // PUT /todos/:id
    if (req.method === 'PUT' && url.pathname.startsWith('/todos/')) {
      const id = parseInt(url.pathname.split('/')[2]);
      const body = await parseBody(req);
      const todos = await loadTodos();
      const index = todos.findIndex(t => t.id === id);
      if (index === -1) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Todo not found' }));
      }
      todos[index] = { ...todos[index], ...body, id };
      await saveTodos(todos);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(todos[index]));
    }

    // DELETE /todos/:id
    if (req.method === 'DELETE' && url.pathname.startsWith('/todos/')) {
      const id = parseInt(url.pathname.split('/')[2]);
      const todos = await loadTodos();
      const filtered = todos.filter(t => t.id !== id);
      if (filtered.length === todos.length) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Todo not found' }));
      }
      await saveTodos(filtered);
      res.writeHead(204);
      return res.end();
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Todo API running on http://localhost:${PORT}`);
});
