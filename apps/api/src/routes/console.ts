/**
 * Development API console — served at `/`.
 *
 * This is a DIAGNOSTIC TOOL, not the Phase 3 admin website. It exists so the team
 * can exercise the real API end-to-end from a browser during the hackathon without
 * waiting for the UI phases, and so judges can see the workflow live.
 *
 * Deliberately self-contained: inline CSS and JavaScript only, no CDN, no external
 * fonts or images. That keeps it working inside a sandboxed preview iframe and
 * offline on a demo laptop.
 *
 * Registered ONLY when NODE_ENV !== 'production'.
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@campus/db';

export function registerConsoleRoute(app: FastifyInstance, deps: { config: AppConfig }): void {
  if (deps.config.nodeEnv === 'production') return;

  app.get('/', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return CONSOLE_HTML;
  });
}

const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Sustainable Campus — Phase 1 API Console</title>
<style>
  :root { --bg:#0f1419; --panel:#171d26; --line:#28323f; --text:#e6edf3; --muted:#8b98a5;
          --ok:#3fb950; --err:#f85149; --warn:#d29922; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:18px 22px; border-bottom:1px solid var(--line); background:var(--panel); }
  h1 { margin:0; font-size:17px; font-weight:600; }
  h1 span { color:var(--muted); font-weight:400; font-size:13px; margin-left:8px; }
  .wrap { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:14px; padding:16px 22px 40px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
  button { font:inherit; padding:7px 12px; margin:0 6px 6px 0; border-radius:7px; cursor:pointer;
           background:#21262d; color:var(--text); border:1px solid var(--line); }
  button:hover { border-color:var(--accent); }
  button.primary { background:#1f6feb; border-color:#1f6feb; color:#fff; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  input,select,textarea { font:inherit; width:100%; padding:7px 9px; margin:0 0 7px; border-radius:7px;
           background:#0d1117; color:var(--text); border:1px solid var(--line); }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:3px; }
  pre { background:#0d1117; border:1px solid var(--line); border-radius:7px; padding:10px;
        overflow:auto; max-height:290px; font-size:12px; margin:0; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .badge { display:inline-block; padding:2px 8px; border-radius:20px; font-size:12px; border:1px solid var(--line); }
  .b-ok { color:var(--ok); border-color:var(--ok); }
  .b-err { color:var(--err); border-color:var(--err); }
  .b-warn { color:var(--warn); border-color:var(--warn); }
  .muted { color:var(--muted); font-size:12px; }
  .full { grid-column:1/-1; }
  .pass { color:var(--ok); } .fail { color:var(--err); }
</style>
</head>
<body>
<header>
  <h1>AI Sustainable Campus <span>Phase 1 API console — development tool</span></h1>
  <div class="row" style="margin-top:10px">
    <span id="health" class="badge">checking…</span>
    <span class="muted" id="who">not signed in</span>
  </div>
</header>

<div class="wrap">
  <div class="card">
    <h2>1 · Sign in</h2>
    <div class="row">
      <button onclick="login('student@demo.dsu.edu.in')">Student</button>
      <button onclick="login('student2@demo.dsu.edu.in')">Student 2</button>
      <button onclick="login('hod@demo.dsu.edu.in')">HOD</button>
      <button onclick="login('admin@demo.dsu.edu.in')">Admin (demo)</button>
      <button onclick="login('admin@dsu.edu.in')">Admin (real)</button>
    </div>
    <label style="margin-top:10px">Password (from .env DEMO_SEED_PASSWORD)</label>
    <input id="pw" type="password" value="CampusDemo#2026" />
    <div class="row">
      <button class="primary" onclick="login(document.getElementById('loginEmail').value)">Sign in</button>
      <button onclick="logout()">Sign out</button>
    </div>
    <input id="loginEmail" placeholder="university email" />
  </div>

  <div class="card">
    <h2>2 · Session &amp; tokens</h2>
    <div class="row">
      <button onclick="get('/v1/auth/me')">Who am I</button>
      <button onclick="get('/v1/tokens/balance')">Token balance</button>
      <button onclick="get('/v1/tokens/transactions')">Ledger</button>
    </div>
    <pre id="out-session">—</pre>
  </div>

  <div class="card">
    <h2>3 · Campus reference data</h2>
    <div class="row">
      <button onclick="loadBlocks()">Blocks</button>
      <button onclick="get('/v1/campus/categories')">Categories</button>
    </div>
    <label>Block</label><select id="blockSel" onchange="loadSpots()"></select>
    <label>Spot</label><select id="spotSel"></select>
    <label>Category</label><select id="catSel"></select>
    <pre id="out-campus">—</pre>
  </div>

  <div class="card">
    <h2>4 · Report an issue (photo required)</h2>
    <label>Title</label><input id="rTitle" value="Water leaking from ceiling" />
    <label>Photo</label><input id="rPhoto" type="file" accept="image/*" />
    <div class="row">
      <button class="primary" onclick="submitReport()">Submit report</button>
      <button onclick="get('/v1/reports/mine')">My reports</button>
    </div>
    <p class="muted">A real JPEG/PNG is required — the server verifies the file's magic bytes,
    not its name or declared type.</p>
    <pre id="out-report">—</pre>
  </div>

  <div class="card">
    <h2>5 · HOD workflow</h2>
    <div class="row">
      <button onclick="get('/v1/issues?limit=10')">Issue queue</button>
      <button onclick="get('/v1/admin/dashboard/summary')">Dashboard counts</button>
    </div>
    <label>Issue ID</label><input id="issueId" placeholder="paste an issue id from the queue" />
    <div class="row">
      <button onclick="act('claim')">Claim</button>
      <button onclick="act('approve')">Approve</button>
      <button onclick="act('start')">Start work</button>
      <button onclick="act('resolve')">Resolve</button>
    </div>
    <label>Completion note (required to resolve)</label>
    <textarea id="note" rows="2">Replaced the corroded pipe joint and sealed the ceiling.</textarea>
    <pre id="out-hod">—</pre>
  </div>

  <div class="card">
    <h2>6 · Integration status (honest reporting)</h2>
    <div class="row">
      <button onclick="get('/v1/events/types')">Event contract</button>
      <button onclick="get('/v1/events/stream')">Live stream</button>
      <button onclick="get('/v1/admin/outbox')">Outbox</button>
      <button onclick="get('/v1/admin/audit')">Audit log</button>
    </div>
    <p class="muted">The AI pipeline and the live event stream are <strong>not implemented</strong>
    in Phase 1 and return 501. Nothing here fabricates a prediction or an event.</p>
    <pre id="out-integration">—</pre>
  </div>

  <div class="card full">
    <h2>Last response</h2>
    <pre id="out">Click any button above to call the live API.</pre>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let token = null;

async function call(method, url, body, isForm) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body && !isForm) headers['content-type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined) });
  let data; try { data = await res.json(); } catch { data = await res.text(); }
  $('out').textContent = method + ' ' + url + '  ->  HTTP ' + res.status + '\n\n' + JSON.stringify(data, null, 2);
  return { status: res.status, data };
}

const get = (url) => call('GET', url);

async function login(email) {
  const r = await call('POST', '/v1/auth/login', { email, password: $('pw').value });
  if (r.status === 200) {
    token = r.data.accessToken;
    $('who').innerHTML = '<span class="pass">signed in as ' + r.data.user.email +
      ' · ' + r.data.user.role + ' · ' + r.data.user.workspace + ' workspace</span>';
    loadBlocks();
  }
}
async function logout() {
  if (token) await call('POST', '/v1/auth/logout');
  token = null; $('who').textContent = 'not signed in';
}

async function loadBlocks() {
  const r = await get('/v1/campus/blocks');
  if (r.status !== 200) return;
  $('out-campus').textContent = JSON.stringify(r.data, null, 2);
  $('blockSel').innerHTML = r.data.items.map(b => '<option value="' + b.id + '">' + b.officialName + '</option>').join('');
  loadSpots();
  const c = await get('/v1/campus/categories');
  if (c.status === 200) $('catSel').innerHTML = c.data.items.map(x => '<option value="' + x.id + '">' + x.name + '</option>').join('');
}
async function loadSpots() {
  const bid = $('blockSel').value; if (!bid) return;
  const r = await get('/v1/campus/blocks/' + bid + '/spots');
  if (r.status === 200) $('spotSel').innerHTML = r.data.items.map(s => '<option value="' + s.id + '">' + s.officialName + '</option>').join('');
}

async function submitReport() {
  const f = $('rPhoto').files[0];
  if (!f) { $('out-report').textContent = 'Choose a photo first — the server requires real evidence.'; return; }
  const form = new FormData();
  form.set('blockId', $('blockSel').value);
  form.set('spotId', $('spotSel').value);
  form.set('selectedCategoryId', $('catSel').value);
  form.set('title', $('rTitle').value);
  form.set('photo', f, f.name);
  const r = await call('POST', '/v1/reports', form, true);
  $('out-report').textContent = JSON.stringify(r.data, null, 2);
  if (r.data && r.data.issueId) $('issueId').value = r.data.issueId;
}

async function act(action) {
  const id = $('issueId').value.trim();
  if (!id) { $('out-hod').textContent = 'Paste an issue id first.'; return; }
  const body = action === 'resolve' ? { resolutionNote: $('note').value }
             : action === 'approve' ? { reason: 'Verified on site (console)' } : {};
  const r = await call('POST', '/v1/issues/' + id + '/' + action, body);
  $('out-hod').textContent = JSON.stringify(r.data, null, 2);
}

fetch('/healthz').then(r => r.json()).then(h => {
  $('health').textContent = 'API ' + h.status + ' · db ' + (h.database.ok ? 'ok' : 'down') + ' · ' + h.engine;
  $('health').className = 'badge ' + (h.status === 'ok' ? 'b-ok' : 'b-err');
}).catch(() => { $('health').textContent = 'unreachable'; $('health').className = 'badge b-err'; });
</script>
</body>
</html>`;
