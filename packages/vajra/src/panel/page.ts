/**
 * The control page. File names come from inside the shell, so they are untrusted: everything
 * is put on the page with textContent and never as HTML, and the page's policy allows only its
 * own inline script (by nonce) and requests back to this server.
 */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vajra</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --muted: #888; --accent: #2b6cb0; --bad: #c53030; --ok: #2f855a; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: baseline; }
  h1 { font-size: 18px; margin: 0; }
  #project { color: var(--muted); font-family: ui-monospace, monospace; }
  #banner { margin: 14px 20px; padding: 12px 14px; border: 1px solid var(--accent); border-radius: 8px; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  #banner.error { border-color: var(--bad); }
  #banner[hidden] { display: none; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  main { padding: 6px 20px 40px; }
  .head, .row { display: grid; grid-template-columns: 1fr 64px 64px 64px 110px; align-items: center; gap: 6px; padding: 3px 0; }
  .head { color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .head span:not(:first-child), .row .cell { text-align: center; }
  .name { font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .caret { display: inline-block; width: 18px; cursor: pointer; user-select: none; color: var(--muted); }
  .kids { margin-left: 18px; border-left: 1px solid var(--line); padding-left: 8px; }
  .tag { font-size: 11px; color: var(--muted); text-align: center; }
  .hidden-tag { color: var(--bad); font-weight: 600; }
  .locked { opacity: .55; }
  input[type=checkbox] { width: 16px; height: 16px; }
</style></head>
<body>
<header><h1>Vajra</h1><span id="project"></span></header>
<div id="banner" hidden><span id="message"></span><button id="apply" hidden>Apply and restart shell</button></div>
<main>
  <div class="head"><span>Path</span><span>Read</span><span>Write</span><span>Delete</span><span>Source</span></div>
  <div id="tree"></div>
</main>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  var expanded = { '': true };
  var banner = document.getElementById('banner');
  var message = document.getElementById('message');
  var apply = document.getElementById('apply');

  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || res.statusText); return data; });
    });
  }
  function show(text, isError) { banner.hidden = false; banner.className = isError ? 'error' : ''; message.textContent = text; apply.hidden = true; }

  function checkbox(entry, right) {
    var cell = document.createElement('span'); cell.className = 'cell';
    var box = document.createElement('input'); box.type = 'checkbox'; box.checked = entry.rights[right];
    box.disabled = !!entry.locked || (right === 'delete' && !entry.isDir);
    box.title = entry.locked || '';
    cell.appendChild(box);
    return { cell: cell, box: box };
  }

  function row(entry, kids) {
    var wrap = document.createElement('div');
    var line = document.createElement('div'); line.className = 'row' + (entry.locked ? ' locked' : '');
    var name = document.createElement('span'); name.className = 'name'; name.title = entry.locked || entry.path;
    var caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = entry.isDir ? (expanded[entry.path] ? '\\u25be' : '\\u25b8') : '';
    name.appendChild(caret); name.appendChild(document.createTextNode(entry.name + (entry.isDir ? '/' : '')));
    if (entry.isDir) caret.onclick = name.onclick = function () { expanded[entry.path] = !expanded[entry.path]; refresh(); };
    var r = checkbox(entry, 'read'), w = checkbox(entry, 'write'), d = checkbox(entry, 'delete');
    var tag = document.createElement('span'); tag.className = 'tag';
    tag.textContent = entry.rights.read ? entry.source : 'hidden';
    if (!entry.rights.read) tag.className += ' hidden-tag';
    [r, w, d].forEach(function (c) {
      c.box.onchange = function () {
        // Rights depend on each other: a hidden path cannot be written, and a delete or a write needs the one before it.
        if (!r.box.checked) { w.box.checked = false; d.box.checked = false; }
        if (d.box.checked) { w.box.checked = true; r.box.checked = true; }
        if (w.box.checked) r.box.checked = true;
        api('/api/rights', { path: entry.path, isDir: entry.isDir, read: r.box.checked, write: w.box.checked, delete: d.box.checked })
          .then(poll, function (error) { show(error.message, true); })
          .then(refresh);
      };
    });
    [name, r.cell, w.cell, d.cell, tag].forEach(function (node) { line.appendChild(node); });
    wrap.appendChild(line);
    if (kids) wrap.appendChild(kids);
    return wrap;
  }

  function folder(path, into) {
    return api('/api/list?path=' + encodeURIComponent(path)).then(function (data) {
      var pending = data.entries.map(function (entry) {
        if (!entry.isDir || !expanded[entry.path] || entry.locked) return Promise.resolve(row(entry, null));
        var kids = document.createElement('div'); kids.className = 'kids';
        return folder(entry.path, kids).then(function () { return row(entry, kids); });
      });
      return Promise.all(pending).then(function (rows) { rows.forEach(function (node) { into.appendChild(node); }); });
    });
  }

  function refresh() {
    var next = document.createElement('div');
    return folder('', next).then(function () { document.getElementById('tree').replaceChildren.apply(document.getElementById('tree'), [next]); }, function (error) { show(error.message, true); });
  }

  function poll() {
    return api('/api/status').then(function (status) {
      document.getElementById('project').textContent = status.project;
      if (status.problem) { show('The rules cannot be used: ' + status.problem, true); return; }
      if (!status.pending) { banner.hidden = true; return; }
      banner.hidden = false; banner.className = '';
      message.textContent = 'Rules changed. The shell is still using the old ones.' + (status.agent ? ' ' + status.agent + ' will be resumed.' : '');
      apply.hidden = false; apply.disabled = false;
    }, function () { show('Vajra has ended, or this page lost its session. Close it and use the new address vajra prints.', true); });
  }

  apply.onclick = function () {
    apply.disabled = true; message.textContent = 'Restarting the shell...';
    api('/api/apply', {}).then(function () { setTimeout(poll, 1500); }, function (error) { show(error.message, true); });
  };

  refresh(); poll(); setInterval(poll, 2000);
})();
</script></body></html>`
}
