// 端到端测试的本地站点。同一个端口按 Host 区分两个站点：127.0.0.1 与 localhost 是不同的来源，
// 浏览器的站点隔离把它们放进不同进程（跨站 iframe 走调试接口的子会话）。
//
// 用法：node server.mjs <端口>，就绪时打印一行 {"ready":true,"port":…}
import http from 'node:http';

const port = Number(process.argv[2] || 18961);
const A = `http://127.0.0.1:${port}`;
const B = `http://localhost:${port}`;

const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

const pages = {
  '/form.html': page('Form', `
    <h1>Sign up</h1>
    <form action="/submitted" method="get">
      <label>Name <input name="name" id="name"></label>
      <label>Password <input type="password" name="pw" id="pw"></label>
      <label>Bio <textarea name="bio" id="bio"></textarea></label>
      <label>Color <select name="color" id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label>
      <label>Fruits <select name="fruits" id="fruits" multiple><option>Apple</option><option>Pear</option><option>Plum</option></select></label>
      <label><input type="checkbox" name="agree" id="agree"> I agree</label>
      <label><input type="radio" name="size" value="s" id="size-s"> Small</label>
      <label><input type="radio" name="size" value="l" id="size-l"> Large</label>
      <label>Level <input type="range" name="level" id="level" min="0" max="10" value="2"></label>
      <label>Day <input type="date" name="day" id="day"></label>
      <div contenteditable="true" id="note" aria-label="Note">old note</div>
      <button type="submit">Submit</button>
    </form>
    <p id="echo"></p>`, `
    for (const id of ['name','pw','bio','color','fruits','agree','size-s','size-l','level','day']) {
      document.getElementById(id).addEventListener('change', () => { document.body.dataset.changed = (document.body.dataset.changed || '') + id + ','; });
    }`),
  '/submitted': null,
  '/upload.html': page('Upload', `
    <h1>Upload</h1>
    <label>Attachment <input type="file" id="visible" multiple></label>
    <input type="file" id="hidden" style="display:none">
    <button id="pick" type="button">Choose a photo</button>
    <pre id="out"></pre>`, `
    document.getElementById('pick').addEventListener('click', () => document.getElementById('hidden').click());
    async function show(e) {
      const parts = [];
      for (const f of e.target.files) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let sum = 0; for (const b of buf) sum = (sum + b) % 65521;
        parts.push(e.target.id + ':' + f.name + ':' + f.size + ':' + f.type + ':' + sum);
      }
      document.getElementById('out').textContent += parts.join('\\n') + '\\n';
    }
    document.getElementById('visible').addEventListener('change', show);
    document.getElementById('hidden').addEventListener('change', show);`),
  '/download.html': page('Downloads', `
    <h1>Downloads</h1>
    <a href="/files/report.txt" id="att">Get the report</a>
    <a href="/files/plain.csv" download="table.csv" id="dl">Get the table</a>
    <a href="${B}/files/report.txt" id="cross">Get the mirrored report</a>
    <form method="post" action="/export"><input name="q" value="2026" aria-label="Year"><button type="submit">Export</button></form>`),
  '/iframe.html': page('Frames', `
    <h1>Frames</h1>
    <iframe src="/frame-child.html?name=same" title="same" width="400" height="120"></iframe>
    <iframe src="${B}/frame-child.html?name=cross" title="cross" width="400" height="120"></iframe>`),
  '/frame-child.html': page('Child', `<p id="label"></p><button id="b" type="button">Count</button><span id="n">0</span>`, `
    const name = new URLSearchParams(location.search).get('name');
    document.getElementById('label').textContent = 'frame ' + name;
    document.getElementById('b').addEventListener('click', () => { const n = document.getElementById('n'); n.textContent = String(Number(n.textContent) + 1); });`),
  '/dialogs.html': page('Dialogs', `
    <button id="al" type="button">Alert</button>
    <button id="co" type="button">Confirm</button>
    <button id="pr" type="button">Prompt</button>
    <p id="res"></p>`, `
    document.getElementById('al').onclick = () => { alert('hello alert'); document.getElementById('res').textContent = 'alert done'; };
    document.getElementById('co').onclick = () => { document.getElementById('res').textContent = 'confirm ' + confirm('sure?'); };
    document.getElementById('pr').onclick = () => { document.getElementById('res').textContent = 'prompt ' + prompt('your name?', 'anon'); };`),
  '/crosssite.html': page('Links', `
    <a href="${B}/landing.html" id="cross">Other site</a>
    <a href="/landing.html" id="same">Same site</a>
    <a href="/redirect" id="redir">Redirect away</a>`),
  '/landing.html': page('Landing', '<h1>Landing</h1>'),
  '/console.html': page('Console', `<button id="go" type="button">Load data</button><p id="st"></p>`, `
    console.log('hello from console', 42);
    console.warn('careful');
    console.error('broken thing');
    document.getElementById('go').onclick = async () => {
      const r = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret-token', 'X-Csrf-Token': 'csrf-1', 'X-Trace': 'keep-me' }, body: JSON.stringify({ q: 'hello' }) });
      document.getElementById('st').textContent = 'status ' + r.status + ' ' + (await r.text());
    };`),
  '/drag.html': page('Drag', `
    <div id="item" draggable="true" style="width:80px;height:40px;background:#9cf">Item</div>
    <div id="zone" style="margin-top:40px;width:200px;height:100px;border:2px dashed #333">Drop here</div>
    <p id="res"></p>`, `
    document.getElementById('item').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'item'));
    const z = document.getElementById('zone');
    z.addEventListener('dragover', (e) => e.preventDefault());
    z.addEventListener('drop', (e) => { e.preventDefault(); document.getElementById('res').textContent = 'dropped ' + e.dataTransfer.getData('text/plain'); });`),
  '/hover.html': page('Hover', `<button id="h" type="button">Hover me</button><p id="tip" hidden>Tooltip text</p>`, `
    document.getElementById('h').addEventListener('mouseenter', () => { document.getElementById('tip').hidden = false; });`),
  '/long.html': page('Long', `<div style="height:3000px;background:linear-gradient(#fff,#ccc)"><p>Top</p></div><p id="bottom">Bottom</p>`),
  '/keys.html': page('Keys', `<input id="k" aria-label="Keys"><p id="log"></p>`, `
    const k = document.getElementById('k');
    k.addEventListener('keydown', (e) => { document.getElementById('log').textContent += e.key + (e.ctrlKey ? '+ctrl' : '') + ' '; });`),
  '/later.html': page('Later', `<p id="msg">waiting</p>`, `setTimeout(() => { document.getElementById('msg').textContent = 'ready now'; }, 1200);`),
};

/** 按「主机 路径」计每个页面被请求了几次（测试据此判断请求有没有发到某个站点）。 */
const hits = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, A);

  if (url.pathname === '/__stats') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(hits));
    return;
  }

  if (url.pathname === '/__reset') {
    for (const k of Object.keys(hits)) {
      delete hits[k];
    }

    res.end('ok');
    return;
  }

  const key = `${req.headers.host} ${url.pathname}`;
  hits[key] = (hits[key] ?? 0) + 1;

  if (url.pathname === '/submitted') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page('Submitted', `<p id="q">${url.search.replace(/[<>&]/g, '')}</p>`));
    return;
  }

  if (url.pathname === '/redirect') {
    res.statusCode = 302;
    res.setHeader('Location', `${B}/landing.html`);
    res.end();
    return;
  }

  if (url.pathname === '/files/report.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="report-2026.txt"');
    res.end('quarterly report\nline two\n');
    return;
  }

  if (url.pathname === '/export' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="export.csv"');
      res.end(`posted,${body}\n`);
    });
    return;
  }

  if (url.pathname === '/files/plain.csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.end('a,b\n1,2\n');
    return;
  }

  if (url.pathname === '/api/data') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'sid=server-secret; Path=/');
      res.setHeader('X-Session-Id', 'sess-123');
      res.setHeader('X-Plain', 'visible');
      res.end(JSON.stringify({ echo: body.length, ok: true }));
    });
    return;
  }

  const html = pages[url.pathname];
  if (typeof html === 'string') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});
