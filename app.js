/* Command Centre dashboard. Plain JS, no build step.
   Reads jobs/ and approvals/ from a GitHub repo through api.github.com with a
   fine-grained token kept in localStorage, and writes answers and archive moves
   back through the Contents API. */
(function () {
  'use strict';

  var API = (typeof window !== 'undefined' && window.CC_API_BASE) || 'https://api.github.com';
  var REFRESH_MS = 30000;
  var LS_KEY = 'command-centre-settings';

  var state = { settings: null, jobs: [], archive: [], approvals: [], view: 'active', expanded: {}, selected: {}, bulking: false, busy: false, timer: null };

  var $ = function (id) { return document.getElementById(id); };

  // ---- settings ------------------------------------------------------------
  function loadSettings() {
    try { var raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { banner('This browser blocks local storage, so the token will be asked for again next time.', false); }
  }
  function forgetSettings() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* nothing to do */ }
    state.settings = null;
    showSettings(true);
  }
  function showSettings(show) {
    $('settings').hidden = !show;
    if (show && state.settings) {
      $('owner').value = state.settings.owner || 'InterrobangBob';
      $('repo').value = state.settings.repo || 'bob-command-centre';
      $('branch').value = state.settings.branch || 'main';
      $('token').value = state.settings.token || '';
    }
  }

  // ---- helpers -------------------------------------------------------------
  function banner(msg, isError) {
    var b = $('banner');
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.hidden = false; b.textContent = msg; b.className = 'banner' + (isError ? ' error' : '');
  }
  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso); if (isNaN(t)) return iso;
    var s = Math.round((Date.now() - t) / 1000);
    var future = s < 0; if (future) s = -s;
    var txt = s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d';
    return future ? 'in ' + txt : txt + ' ago';
  }
  function isUrl(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function headers(extra) {
    var h = { Authorization: 'Bearer ' + state.settings.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
    return h;
  }
  function parseJobs(entries) {
    var out = [];
    (entries || []).forEach(function (e) {
      if (!/\.json$/.test(e.name) || !e.text) return;
      try { var j = JSON.parse(e.text); j._sha = e.oid; j._path = e.path; out.push(j); } catch (err) { /* skip bad file */ }
    });
    return out;
  }

  // ---- reading -------------------------------------------------------------
  // One GraphQL call fetches every file in the three folders. If GraphQL is not
  // available to the token, fall back to the REST Contents API.
  function fetchAll() {
    var s = state.settings;
    var q = 'query($owner:String!,$name:String!,$jobs:String!,$arch:String!,$apps:String!){' +
      'repository(owner:$owner,name:$name){' +
      ' jobs: object(expression:$jobs){ ...T } archive: object(expression:$arch){ ...T } approvals: object(expression:$apps){ ...T } } }' +
      'fragment T on Tree { entries { name oid object { ... on Blob { text } } } }';
    var vars = { owner: s.owner, name: s.repo, jobs: s.branch + ':jobs', arch: s.branch + ':jobs/archive', apps: s.branch + ':approvals' };
    return fetch(API + '/graphql', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ query: q, variables: vars }) })
      .then(function (r) {
        if (r.status === 401) throw new Error('GitHub rejected the token (401). Check it in Settings.');
        if (!r.ok) throw new Error('graphql ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.errors && data.errors.length) {
          var e0 = data.errors[0];
          if (e0.type === 'NOT_FOUND' || /Could not resolve/i.test(e0.message || '')) throw new Error('Repository not found: check the user and repository names in Settings, and that the token can read that repository.');
          throw new Error('graphql: ' + e0.message);
        }
        var repo = data.data && data.data.repository;
        if (!repo) throw new Error('Repository not found or token has no access.');
        var conv = function (tree, folder) {
          return (tree && tree.entries ? tree.entries : []).filter(function (e) { return e.object && typeof e.object.text === 'string'; })
            .map(function (e) { return { name: e.name, oid: e.oid, text: e.object.text, path: folder + '/' + e.name }; });
        };
        return { jobs: conv(repo.jobs, 'jobs'), archive: conv(repo.archive, 'jobs/archive'), approvals: conv(repo.approvals, 'approvals') };
      })
      .catch(function (err) {
        if (/401|not found|no access/i.test(err.message)) throw err;
        return fetchAllRest();
      });
  }
  function restList(folder, required) {
    var s = state.settings;
    return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + folder + '?ref=' + encodeURIComponent(s.branch), { headers: headers() })
      .then(function (r) {
        if (r.status === 404 && required) throw new Error('Repository or jobs folder not found: check the user and repository names in Settings, and that the token can read that repository.');
        if (r.status === 404) return [];
        if (r.status === 401) throw new Error('GitHub rejected the token (401). Check it in Settings.');
        if (!r.ok) throw new Error('GitHub returned ' + r.status + ' for ' + folder);
        return r.json();
      })
      .then(function (list) {
        var files = (Array.isArray(list) ? list : []).filter(function (f) { return f.type === 'file' && /\.json$/.test(f.name); });
        return Promise.all(files.map(function (f) {
          return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + f.path + '?ref=' + encodeURIComponent(s.branch), { headers: headers({ Accept: 'application/vnd.github.raw+json' }) })
            .then(function (r) { return r.ok ? r.text() : ''; })
            .then(function (text) { return { name: f.name, oid: f.sha, text: text, path: f.path }; });
        }));
      });
  }
  function fetchAllRest() {
    return Promise.all([restList('jobs', true), restList('jobs/archive'), restList('approvals')])
      .then(function (r) { return { jobs: r[0], archive: r[1], approvals: r[2] }; });
  }

  function refresh() {
    if (!state.settings || !state.settings.token) { showSettings(true); return Promise.resolve(); }
    if (state.busy) return Promise.resolve();
    state.busy = true;
    $('refreshBtn').disabled = true;
    return fetchAll().then(function (d) {
      state.jobs = parseJobs(d.jobs); state.archive = parseJobs(d.archive); state.approvals = parseJobs(d.approvals);
      banner('');
      $('refreshed').textContent = 'updated ' + new Date().toLocaleTimeString();
      render();
    }).catch(function (err) {
      banner('Could not load: ' + err.message, true);
    }).then(function () { state.busy = false; $('refreshBtn').disabled = false; });
  }

  // ---- writing -------------------------------------------------------------
  function putFile(path, content, sha, message) {
    var s = state.settings;
    var body = { message: message, content: b64(content), branch: s.branch };
    if (sha) body.sha = sha;
    return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + path, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('write failed (' + r.status + ') for ' + path); return r.json(); });
  }
  function deleteFile(path, sha, message) {
    var s = state.settings;
    return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + path, { method: 'DELETE', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ message: message, sha: sha, branch: s.branch }) })
      .then(function (r) { if (!r.ok) throw new Error('delete failed (' + r.status + ') for ' + path); return r.json(); });
  }
  function currentSha(path) {
    var s = state.settings;
    return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + path + '?ref=' + encodeURIComponent(s.branch), { headers: headers() })
      .then(function (r) { return r.ok ? r.json().then(function (j) { return j.sha; }) : null; });
  }
  function serialise(obj) {
    var copy = {}; Object.keys(obj).forEach(function (k) { if (k.charAt(0) !== '_') copy[k] = obj[k]; });
    return JSON.stringify(copy, null, 2) + '\n';
  }
  function withRetry(fn) {
    return fn().catch(function (err) { if (/409|422/.test(err.message)) return fn(); throw err; });
  }

  function currentFile(path) {
    var s = state.settings;
    return fetch(API + '/repos/' + s.owner + '/' + s.repo + '/contents/' + path + '?ref=' + encodeURIComponent(s.branch), { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (!j) return null; try { return { sha: j.sha, data: JSON.parse(decodeURIComponent(escape(atob((j.content || '').replace(/\n/g, ''))))) }; } catch (e) { return { sha: j.sha, data: null }; } });
  }
  function answerApproval(ap, answer, btn) {
    btn.disabled = true;
    withRetry(function () {
      return currentFile(ap._path).then(function (cur) {
        if (!cur) throw new Error('That approval file is gone. Refreshing.');
        var live = cur.data || ap;
        if (live.status !== 'pending') throw new Error('Too late: the hook already recorded this request as ' + live.status + '. The prompt is on the machine now.');
        if (Date.parse(live.expires || '') < Date.now()) throw new Error('Too late: this request expired. The prompt is on the machine now.');
        live.status = answer; live.answered_at = new Date().toISOString(); live.answered_by = 'dashboard';
        return putFile(ap._path, serialise(live), cur.sha, 'dashboard ' + answer + ' ' + ap.id);
      });
    }).then(function () { banner('Sent: ' + answer + '. The machine picks it up within about 15 seconds.', false); return refresh(); })
      .catch(function (err) { banner(err.message, true); btn.disabled = false; refresh(); });
  }

  function movePlain(job, toArchive) {
    var from = job._path;
    var to = toArchive ? 'jobs/archive/' + job.id + '.json' : 'jobs/' + job.id + '.json';
    return withRetry(function () {
      return currentSha(to).then(function (existingSha) { return putFile(to, serialise(job), existingSha, (toArchive ? 'archive ' : 'unarchive ') + job.id); })
        .then(function () { return currentSha(from); })
        .then(function (sha) { return sha ? deleteFile(from, sha, (toArchive ? 'archive ' : 'unarchive ') + job.id) : null; });
    });
  }

  function moveJob(job, toArchive) {
    return movePlain(job, toArchive).then(refresh).catch(function (err) { banner(err.message, true); });
  }

  // ---- bulk archive / restore ---------------------------------------------
  function shownJobs() {
    var active = state.view === 'active';
    var m = $('machineFilter').value, su = $('surfaceFilter').value, st = $('statusFilter').value;
    return (active ? state.jobs : state.archive).filter(function (j) { return (!m || j.machine === m) && (!su || j.surface === su) && (!st || j.status === st); }).sort(sortJobs);
  }
  function selectedJobs() { return shownJobs().filter(function (j) { return state.selected[j.id]; }); }

  function renderBulk() {
    var active = state.view === 'active';
    var shown = shownJobs();
    var picked = shown.filter(function (j) { return state.selected[j.id]; });
    var all = $('selectAll');
    all.checked = shown.length > 0 && picked.length === shown.length;
    all.indeterminate = picked.length > 0 && picked.length < shown.length;
    all.disabled = state.bulking || shown.length === 0;
    $('selectFinished').hidden = !active;
    $('selectFinished').disabled = state.bulking;
    var go = $('bulkGo');
    go.textContent = (active ? 'Archive selected (' : 'Restore selected (') + picked.length + ')';
    go.disabled = state.bulking || picked.length === 0;
  }

  function bulkMove() {
    var active = state.view === 'active';
    var picked = selectedJobs();
    if (!picked.length || state.bulking) return Promise.resolve();
    var waiting = picked.filter(function (j) { return j.status === 'waiting'; }).length;
    if (active && waiting && !window.confirm(waiting + ' of the selected jobs are still waiting on you. Archive them anyway?')) return Promise.resolve();
    state.bulking = true; renderBulk();
    var done = 0, failed = [];
    var note = $('bulkState'); note.hidden = false; note.className = 'muted sync-state';
    // One at a time: two writes to the same branch at once make GitHub answer 409.
    var chain = Promise.resolve();
    picked.forEach(function (j) {
      chain = chain.then(function () {
        note.textContent = (active ? 'Archiving ' : 'Restoring ') + (done + failed.length + 1) + ' of ' + picked.length + '...';
        return movePlain(j, active).then(function () { done++; delete state.selected[j.id]; }, function (err) { failed.push(j.title || j.id); note.dataset.err = err.message; });
      });
    });
    return chain.then(function () {
      state.bulking = false;
      if (failed.length) {
        note.className = 'muted sync-state error-text';
        note.textContent = (active ? 'Archived ' : 'Restored ') + done + ', failed ' + failed.length + ' (' + failed.slice(0, 3).join(', ') + (failed.length > 3 ? ', ...' : '') + '): ' + (note.dataset.err || '');
      } else {
        note.textContent = (active ? 'Archived ' : 'Restored ') + done + (done === 1 ? ' job.' : ' jobs.');
      }
      return refresh();
    });
  }

  // ---- rendering -----------------------------------------------------------
  function render() {
    var active = state.view === 'active';
    $('viewBtn').textContent = active ? 'Archive' : 'Active jobs';
    $('jobsHeading').textContent = active ? 'Jobs' : 'Archived jobs';
    renderMachineFilter();
    renderJobs(active ? state.jobs : state.archive, active);
    renderWaiting();
  }

  function renderMachineFilter() {
    var sel = $('machineFilter'); var cur = sel.value;
    var machines = {};
    state.jobs.concat(state.archive).forEach(function (j) { if (j.machine) machines[j.machine] = true; });
    sel.innerHTML = '<option value="">All machines</option>';
    Object.keys(machines).sort().forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    sel.value = cur;
  }

  function sortJobs(a, b) {
    var rank = { waiting: 0, running: 1, failed: 2, finished: 3 };
    var ra = rank[a.status] === undefined ? 4 : rank[a.status], rb = rank[b.status] === undefined ? 4 : rank[b.status];
    if (ra !== rb) return ra - rb;
    return (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0);
  }

  function renderJobs(jobs, active) {
    var list = $('jobList'); list.innerHTML = '';
    var tpl = $('jobRowTpl');
    var shown = shownJobs();
    var ids = {}; jobs.forEach(function (j) { ids[j.id] = true; });
    Object.keys(state.selected).forEach(function (id) { if (!ids[id]) delete state.selected[id]; });
    $('jobsEmpty').hidden = shown.length > 0;
    shown.forEach(function (j) {
      var li = tpl.content.firstElementChild.cloneNode(true);
      li.querySelector('.dot').dataset.status = j.status || '';
      li.querySelector('.job-title').textContent = j.title || j.id;
      li.querySelector('.badge.machine').textContent = j.machine || '?';
      li.querySelector('.badge.surface').textContent = j.surface || '?';
      li.querySelector('.when').textContent = (j.status || '') + ', ' + relTime(j.updated);
      li.querySelector('.job-line').textContent = j.last_line || '';
      var pick = li.querySelector('.pick');
      pick.checked = !!state.selected[j.id];
      pick.disabled = state.bulking;
      pick.setAttribute('aria-label', 'Select ' + (j.title || j.id));
      pick.addEventListener('change', function () { if (pick.checked) state.selected[j.id] = true; else delete state.selected[j.id]; renderBulk(); });
      var open = li.querySelector('.open');
      if (isUrl(j.owner_session)) { open.hidden = false; open.href = j.owner_session; }
      var arch = li.querySelector('.archive');
      arch.textContent = active ? 'Archive' : 'Restore';
      arch.addEventListener('click', function () { arch.disabled = true; moveJob(j, active); });
      var main = li.querySelector('.job-main'); var detail = li.querySelector('.job-detail');
      var fill = function () {
        detail.innerHTML = '';
        var dl = document.createElement('dl');
        var add = function (k, v) { if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return; var dt = document.createElement('dt'); dt.textContent = k; var dd = document.createElement('dd'); dd.textContent = Array.isArray(v) ? v.join('; ') : String(v); dl.appendChild(dt); dl.appendChild(dd); };
        add('id', j.id); add('owner', j.owner_session); add('started', j.started); add('needs', j.needs_from_bob); add('tried', j.self_serve_attempted);
        add('plan', (j.model_plan || []).map(function (p) { return (p.model || '?') + ': ' + (p.step || ''); }));
        var aps = state.approvals.filter(function (a) { return a.job_id === j.id; });
        add('approvals', aps.map(function (a) { return a.status + ': ' + a.summary; }));
        detail.appendChild(dl);
      };
      if (state.expanded[j.id]) { fill(); detail.hidden = false; main.setAttribute('aria-expanded', 'true'); }
      main.addEventListener('click', function () {
        state.expanded[j.id] = !state.expanded[j.id];
        if (state.expanded[j.id]) fill();
        detail.hidden = !state.expanded[j.id];
        main.setAttribute('aria-expanded', String(state.expanded[j.id]));
      });
      list.appendChild(li);
    });
    renderBulk();
  }

  function renderWaiting() {
    var box = $('waitingList'); box.innerHTML = '';
    var tpl = $('tileTpl');
    var pending = state.approvals.filter(function (a) { return a.status === 'pending' && Date.parse(a.expires || '') > Date.now(); });
    var waitingJobs = state.jobs.filter(function (j) { return j.status === 'waiting'; });
    // Jobs with a pending approval but not marked waiting still deserve a tile.
    pending.forEach(function (a) {
      if (!waitingJobs.some(function (j) { return j.id === a.job_id; })) {
        var j = state.jobs.filter(function (x) { return x.id === a.job_id; })[0];
        waitingJobs.push(j || { id: a.job_id, title: a.summary, machine: a.machine, needs_from_bob: 'Approve or deny: ' + a.summary, self_serve_attempted: [], updated: a.created, owner_session: a.cwd });
      }
    });
    waitingJobs.sort(function (a, b) { return (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0); });
    $('waitingCount').textContent = String(waitingJobs.length);
    $('waitingEmpty').hidden = waitingJobs.length > 0;
    waitingJobs.forEach(function (j) {
      var t = tpl.content.firstElementChild.cloneNode(true);
      t.querySelector('.badge.machine').textContent = (j.machine || '?') + (j.surface ? ' / ' + j.surface : '');
      t.querySelector('.when').textContent = relTime(j.updated);
      t.querySelector('.tile-title').textContent = j.title || j.id;
      t.querySelector('.needs').textContent = j.needs_from_bob || 'Waiting (no reason given)';
      var tried = t.querySelector('.tried');
      var attempts = Array.isArray(j.self_serve_attempted) ? j.self_serve_attempted : [];
      if (!attempts.length) { var li0 = document.createElement('li'); li0.textContent = 'Nothing recorded'; tried.appendChild(li0); }
      attempts.forEach(function (a) { var li = document.createElement('li'); li.textContent = a; tried.appendChild(li); });
      var ap = pending.filter(function (a) { return a.job_id === j.id; })[0];
      if (ap) {
        var box2 = t.querySelector('.approval'); box2.hidden = false;
        t.querySelector('.approval-summary').textContent = ap.summary + '  (expires ' + relTime(ap.expires) + ')';
        var allow = t.querySelector('.allow'), deny = t.querySelector('.deny');
        allow.addEventListener('click', function () { answerApproval(ap, 'allowed', allow); });
        deny.addEventListener('click', function () { answerApproval(ap, 'denied', deny); });
      }
      var open = t.querySelector('.open'); var owner = t.querySelector('.owner');
      if (isUrl(j.owner_session)) { open.hidden = false; open.href = j.owner_session; }
      else if (j.owner_session) { owner.textContent = j.owner_session; }
      box.appendChild(t);
    });
  }

  // ---- sync now ------------------------------------------------------------
  // The cloud sessions can only be read by a Claude session that has the Remote Control tools, so the button leaves a
  // request in the repo (requests/sync-now.json) and waits for that session to answer in requests/sync-done.json.
  var SYNC_POLL_MS = (typeof window !== 'undefined' && window.CC_SYNC_POLL_MS) || 15000;
  var SYNC_GIVE_UP_MS = (typeof window !== 'undefined' && window.CC_SYNC_GIVE_UP_MS) || 12 * 60 * 1000;
  function syncState(msg, isErr) {
    var p = $('syncState');
    p.hidden = !msg; p.textContent = msg || ''; p.className = 'muted sync-state' + (isErr ? ' error-text' : '');
  }
  function syncDone() { state.syncing = false; $('syncBtn').disabled = false; }
  function syncNow() {
    if (!state.settings || !state.settings.token) { showSettings(true); return; }
    if (state.syncing) return;
    state.syncing = true; $('syncBtn').disabled = true;
    var asked = new Date().toISOString();
    syncState('Asking Claude to sync...');
    withRetry(function () {
      return currentSha('requests/sync-now.json').then(function (sha) {
        return putFile('requests/sync-now.json', JSON.stringify({ requested_at: asked, by: 'dashboard' }, null, 2) + '\n', sha, 'sync now ' + asked);
      });
    }).then(function () {
      var start = Date.now();
      syncState('Requested. Nothing answers this automatically. Tell Claude in the Command Centre session that you clicked it.');
      (function poll() {
        if (Date.now() - start > SYNC_GIVE_UP_MS) {
          syncState('No answer after ' + Math.round(SYNC_GIVE_UP_MS / 60000) + ' minutes. The Claude session that does the sync may not be running.', true);
          syncDone(); return;
        }
        currentFile('requests/sync-done.json').then(function (cur) {
          if (cur && cur.data && cur.data.requested_at === asked) {
            syncState('Synced at ' + new Date(cur.data.finished_at).toLocaleTimeString() + '.');
            syncDone(); return refresh();
          }
          setTimeout(poll, SYNC_POLL_MS);
        }).catch(function () { setTimeout(poll, SYNC_POLL_MS); });
      })();
    }).catch(function (err) { syncState('Could not send the request: ' + err.message, true); syncDone(); });
  }

  // ---- wiring --------------------------------------------------------------
  function schedule() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  $('refreshBtn').addEventListener('click', refresh);
  $('syncBtn').addEventListener('click', syncNow);
  $('selectAll').addEventListener('change', function () {
    var on = $('selectAll').checked;
    shownJobs().forEach(function (j) { if (on) state.selected[j.id] = true; else delete state.selected[j.id]; });
    render();
  });
  $('selectFinished').addEventListener('click', function () {
    state.selected = {};
    shownJobs().forEach(function (j) { if (j.status === 'finished') state.selected[j.id] = true; });
    render();
  });
  $('bulkGo').addEventListener('click', bulkMove);
  $('viewBtn').addEventListener('click', function () { state.view = state.view === 'active' ? 'archive' : 'active'; render(); });
  $('settingsBtn').addEventListener('click', function () { showSettings($('settings').hidden); });
  $('forgetBtn').addEventListener('click', forgetSettings);
  ['machineFilter', 'surfaceFilter', 'statusFilter'].forEach(function (id) { $(id).addEventListener('change', render); });
  $('settingsForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    state.settings = { owner: $('owner').value.trim(), repo: $('repo').value.trim(), branch: $('branch').value.trim() || 'main', token: $('token').value.trim() };
    saveSettings(state.settings);
    showSettings(false);
    refresh();
  });

  state.settings = loadSettings();
  if (!state.settings || !state.settings.token) showSettings(true); else refresh();
  schedule();
})();
