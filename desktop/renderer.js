(function () {
  const bridgeBadgeEl = document.getElementById('bridge-badge');
  const checkedAtEl = document.getElementById('checked-at');
  const summaryEl = document.getElementById('summary');
  const doctorEl = document.getElementById('doctor');
  const issuesEl = document.getElementById('issues');
  const tokenMetricsEl = document.getElementById('token-metrics');
  const retryBtn = document.getElementById('retry-btn');
  const restartBtn = document.getElementById('restart-btn');
  const loginBtn = document.getElementById('login-btn');
  const docsBtn = document.getElementById('docs-btn');
  const sessionListEl = document.getElementById('session-list');
  const sessionMetaEl = document.getElementById('session-meta');
  const sessionLogEl = document.getElementById('session-log');
  const sessionCancelBtn = document.getElementById('session-cancel-btn');
  const sessionsRefreshBtn = document.getElementById('sessions-refresh-btn');
  const terminalStartBtn = document.getElementById('terminal-start-btn');
  const terminalRestartBtn = document.getElementById('terminal-restart-btn');
  const terminalMetaEl = document.getElementById('terminal-meta');
  const terminalContainerEl = document.getElementById('terminal-container');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    status: document.getElementById('panel-status'),
    terminal: document.getElementById('panel-terminal'),
    sessions: document.getElementById('panel-sessions'),
  };

  const state = {
    diagnostics: null,
    sessions: [],
    selectedSessionId: '',
    terminal: null,
    fitAddon: null,
    terminalSnapshot: null,
    terminalInitialized: false,
    terminalStartRequested: false,
    activeTab: 'status',
    terminalResizeTimer: null,
  };

  function setText(node, value) {
    node.textContent = value || '';
  }

  function formatWholeNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '-';
    }
    return Math.max(0, Math.floor(numeric)).toLocaleString();
  }

  function formatPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '-';
    }
    return `${Math.max(0, numeric).toFixed(1)}%`;
  }

  function formatResetTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return '-';
    }
    return new Date(Math.floor(numeric) * 1000).toLocaleString();
  }

  function describeUsage(label, usage) {
    if (!usage || typeof usage !== 'object') {
      return null;
    }
    return `${label}: in ${formatWholeNumber(usage.input_tokens)} / cached ${formatWholeNumber(usage.cached_input_tokens)} / out ${formatWholeNumber(usage.output_tokens)} / total ${formatWholeNumber(usage.total_tokens)}`;
  }

  function renderIssues(issues) {
    issuesEl.innerHTML = '';
    if (!Array.isArray(issues)) {
      const li = document.createElement('li');
      li.textContent = 'Diagnostics unavailable.';
      li.className = 'warn';
      issuesEl.appendChild(li);
      return;
    }
    if (issues.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No issues reported.';
      li.className = 'ok';
      issuesEl.appendChild(li);
      return;
    }
    for (const issue of issues) {
      const li = document.createElement('li');
      li.textContent = issue;
      li.className = 'err';
      issuesEl.appendChild(li);
    }
  }

  function renderTokenMetrics(health) {
    const metrics =
      health && typeof health === 'object' && health.token_metrics && typeof health.token_metrics === 'object'
        ? health.token_metrics
        : null;
    if (!metrics) {
      setText(tokenMetricsEl, 'No token usage or quota data yet.');
      return;
    }
    const rateLimits =
      metrics.rate_limits && typeof metrics.rate_limits === 'object'
        ? metrics.rate_limits
        : null;
    const primary =
      rateLimits && rateLimits.primary && typeof rateLimits.primary === 'object'
        ? rateLimits.primary
        : null;
    const secondary =
      rateLimits && rateLimits.secondary && typeof rateLimits.secondary === 'object'
        ? rateLimits.secondary
        : null;
    const credits =
      rateLimits && rateLimits.credits && typeof rateLimits.credits === 'object'
        ? rateLimits.credits
        : null;

    const lines = [
      describeUsage('last_run_usage', metrics.usage),
      describeUsage('last_token_usage', metrics.last_usage),
      describeUsage('total_token_usage', metrics.total_usage),
      Number.isFinite(Number(metrics.model_context_window))
        ? `model_context_window: ${formatWholeNumber(metrics.model_context_window)}`
        : null,
      rateLimits ? `quota_bucket: ${rateLimits.limit_name || rateLimits.limit_id || '-'}` : null,
      rateLimits && rateLimits.plan_type ? `plan_type: ${rateLimits.plan_type}` : null,
      primary
        ? `primary_quota: ${formatPercent(primary.used_percent)} in ${formatWholeNumber(primary.window_minutes)}m, resets ${formatResetTimestamp(primary.resets_at)}`
        : null,
      secondary
        ? `secondary_quota: ${formatPercent(secondary.used_percent)} in ${formatWholeNumber(secondary.window_minutes)}m, resets ${formatResetTimestamp(secondary.resets_at)}`
        : null,
      credits
        ? `credits: has=${String(credits.has_credits)} unlimited=${String(credits.unlimited)} balance=${credits.balance === null || credits.balance === undefined ? '-' : String(credits.balance)}`
        : null,
      Number.isFinite(Number(metrics.updated_at)) && Number(metrics.updated_at) > 0
        ? `updated_at: ${new Date(Number(metrics.updated_at)).toLocaleString()}`
        : null,
    ].filter(Boolean);

    setText(tokenMetricsEl, lines.length > 0 ? lines.join('\n') : 'No token usage or quota data yet.');
  }

  function renderDiagnostics(stateValue) {
    state.diagnostics = stateValue || null;
    const doctor = stateValue && stateValue.doctor && typeof stateValue.doctor === 'object'
      ? stateValue.doctor
      : null;
    const boolOrDash = (value) => (typeof value === 'boolean' ? String(value) : '-');

    if (stateValue && stateValue.startup_error) {
      setText(summaryEl, `Bridge startup error: ${stateValue.startup_error.message || 'Unknown error'}`);
      bridgeBadgeEl.textContent = 'Bridge error';
      bridgeBadgeEl.className = 'badge err';
    } else if (stateValue && stateValue.health && stateValue.health.codex_ready) {
      setText(summaryEl, `Bridge OK on localhost:${stateValue.health.port} (codex ready)`);
      bridgeBadgeEl.textContent = 'Bridge ready';
      bridgeBadgeEl.className = 'badge ok';
    } else if (stateValue && stateValue.health) {
      setText(summaryEl, `Bridge running on localhost:${stateValue.health.port}, but Codex is not ready`);
      bridgeBadgeEl.textContent = 'Codex not ready';
      bridgeBadgeEl.className = 'badge warn';
    } else {
      setText(summaryEl, 'Bridge status unavailable');
      bridgeBadgeEl.textContent = 'Bridge unavailable';
      bridgeBadgeEl.className = 'badge err';
    }

    setText(
      doctorEl,
      [
        `codex_installed: ${boolOrDash(doctor ? doctor.codex_installed : undefined)}`,
        `codex_logged_in: ${boolOrDash(doctor ? doctor.codex_logged_in : undefined)}`,
        `network_ok: ${boolOrDash(doctor ? doctor.network_ok : undefined)}`,
        `codex_bin: ${doctor && doctor.codex_bin ? doctor.codex_bin : '-'}`,
        `auth_artifact_found: ${boolOrDash(doctor ? doctor.codex_auth_artifact_found : undefined)}`,
        `auth_artifact_path: ${doctor && doctor.codex_auth_artifact_path ? doctor.codex_auth_artifact_path : '-'}`,
        doctor && doctor.probe_detail ? `probe_detail: ${doctor.probe_detail}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    renderIssues(doctor ? doctor.issues : undefined);
    renderTokenMetrics(stateValue ? stateValue.health : null);

    const checked = stateValue && stateValue.checked_at ? new Date(stateValue.checked_at).toLocaleString() : '-';
    checkedAtEl.textContent = `Last checked: ${checked}`;
  }

  function sortSessions(list) {
    return [...list].sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  }

  function findSession(sessionId) {
    return state.sessions.find((session) => session && session.session_id === sessionId) || null;
  }

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No project sessions yet.';
      sessionListEl.appendChild(empty);
      renderSessionDetail(null);
      return;
    }
    if (!state.selectedSessionId || !findSession(state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0].session_id;
    }

    for (const session of state.sessions) {
      const button = document.createElement('button');
      button.className = `session-item${session.session_id === state.selectedSessionId ? ' is-active' : ''}`;
      button.type = 'button';
      button.innerHTML = `
        <strong>${session.project_id}</strong>
        <div class="meta">${session.status} | updated ${session.updated_at ? new Date(session.updated_at).toLocaleTimeString() : '-'}</div>
      `;
      button.addEventListener('click', () => {
        state.selectedSessionId = session.session_id;
        renderSessionList();
      });
      sessionListEl.appendChild(button);
    }

    renderSessionDetail(findSession(state.selectedSessionId));
  }

  function renderSessionDetail(session) {
    if (!session) {
      setText(sessionMetaEl, 'Select a session to inspect its shared transcript and latest result.');
      sessionLogEl.innerHTML = '<div class="empty">No session selected.</div>';
      sessionCancelBtn.disabled = true;
      return;
    }

    setText(
      sessionMetaEl,
      [
        `project_id: ${session.project_id || '-'}`,
        `session_id: ${session.session_id || '-'}`,
        `status: ${session.status || '-'}`,
        `status_message: ${session.status_message || '-'}`,
        `active_run_id: ${session.active_run_id || '-'}`,
        `last_seq: ${session.last_seq || 0}`,
        `estimated_usage: in ${formatWholeNumber(session.session_usage && session.session_usage.estimated_input_tokens)} / out ${formatWholeNumber(session.session_usage && session.session_usage.estimated_output_tokens)} / total ${formatWholeNumber(session.session_usage && session.session_usage.estimated_total_tokens)}`,
      ].join('\n')
    );

    sessionCancelBtn.disabled = session.status !== 'running';
    sessionLogEl.innerHTML = '';
    const turns = Array.isArray(session.chat_turns) ? session.chat_turns : [];
    if (turns.length === 0) {
      sessionLogEl.innerHTML = '<div class="empty">No transcript stored yet.</div>';
      return;
    }
    for (const turn of turns) {
      const line = document.createElement('div');
      line.className = `session-line ${turn.role || 'system'}`;
      const ts = turn.ts ? new Date(turn.ts).toLocaleTimeString() : '-';
      line.innerHTML = `<small>${turn.role || 'system'} | ${ts}</small>`;
      const body = document.createElement('div');
      body.className = 'mono';
      body.textContent = turn.text || '';
      line.appendChild(body);
      sessionLogEl.appendChild(line);
    }
    sessionLogEl.scrollTop = sessionLogEl.scrollHeight;
  }

  function upsertSession(session) {
    if (!session || typeof session !== 'object' || !session.session_id) {
      return;
    }
    const nextSessions = state.sessions.filter((item) => item.session_id !== session.session_id);
    nextSessions.push(session);
    state.sessions = sortSessions(nextSessions);
    renderSessionList();
  }

  async function refreshSessions() {
    try {
      const sessions = await window.assistDesktop.listSessions();
      state.sessions = Array.isArray(sessions) ? sortSessions(sessions) : [];
      renderSessionList();
    } catch (err) {
      sessionListEl.innerHTML = `<div class="empty">Failed to load sessions: ${err.message || 'Unknown error'}</div>`;
    }
  }

  function ensureTerminal() {
    if (state.terminalInitialized) {
      return true;
    }
    const TerminalCtor = window.Terminal;
    const FitAddonCtor =
      window.FitAddon && typeof window.FitAddon.FitAddon === 'function'
        ? window.FitAddon.FitAddon
        : null;
    if (typeof TerminalCtor !== 'function' || typeof FitAddonCtor !== 'function') {
      terminalContainerEl.textContent = 'xterm.js assets failed to load.';
      return false;
    }
    const term = new TerminalCtor({
      cursorBlink: true,
      fontFamily: '"Consolas", "Menlo", monospace',
      fontSize: 13,
      theme: {
        background: '#03080d',
        foreground: '#d8e7f8',
        cursor: '#5ec2ff',
        selectionBackground: 'rgba(94, 194, 255, 0.28)',
      },
    });
    const fitAddon = new FitAddonCtor();
    term.loadAddon(fitAddon);
    term.open(terminalContainerEl);
    term.onData((data) => {
      window.assistDesktop.writeTerminal(data);
    });
    state.terminal = term;
    state.fitAddon = fitAddon;
    state.terminalInitialized = true;
    applyTerminalSnapshot(state.terminalSnapshot, true);
    scheduleTerminalResize();
    return true;
  }

  function renderTerminalMeta(snapshot) {
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    terminalMetaEl.innerHTML = [
      `available: ${String(Boolean(value.available))}`,
      `running: ${String(Boolean(value.running))}`,
      `pid: ${value.pid === null || value.pid === undefined ? '-' : String(value.pid)}`,
      `started_at: ${value.started_at ? new Date(value.started_at).toLocaleString() : '-'}`,
      `exit_code: ${value.exit_code === null || value.exit_code === undefined ? '-' : String(value.exit_code)}`,
      value.error ? `error: ${value.error}` : '',
    ]
      .filter(Boolean)
      .map((line) => `<span>${line}</span>`)
      .join('');
    terminalStartBtn.disabled = Boolean(value.running);
    terminalRestartBtn.disabled = !Boolean(value.available);
  }

  function applyTerminalSnapshot(snapshot, resetBuffer) {
    state.terminalSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
    renderTerminalMeta(state.terminalSnapshot);
    if (!ensureTerminal()) {
      return;
    }
    if (resetBuffer) {
      state.terminal.reset();
      const buffer =
        state.terminalSnapshot && typeof state.terminalSnapshot.buffer === 'string'
          ? state.terminalSnapshot.buffer
          : '';
      if (buffer) {
        state.terminal.write(buffer);
      }
    }
  }

  function scheduleTerminalResize() {
    if (!state.terminalInitialized || state.activeTab !== 'terminal') {
      return;
    }
    if (state.terminalResizeTimer) {
      clearTimeout(state.terminalResizeTimer);
    }
    state.terminalResizeTimer = setTimeout(() => {
      if (!state.fitAddon || !state.terminal) {
        return;
      }
      try {
        state.fitAddon.fit();
        window.assistDesktop.resizeTerminal(state.terminal.cols, state.terminal.rows);
      } catch (err) {
        // ignore xterm fit failures during layout changes
      }
    }, 30);
  }

  async function ensureTerminalStarted() {
    if (state.terminalStartRequested) {
      return;
    }
    state.terminalStartRequested = true;
    try {
      const snapshot = await window.assistDesktop.startTerminal();
      applyTerminalSnapshot(snapshot, true);
    } catch (err) {
      renderTerminalMeta({
        available: false,
        running: false,
        error: err.message || 'Failed to start terminal',
      });
    }
  }

  function activateTab(tabName) {
    state.activeTab = tabName;
    for (const button of tabButtons) {
      button.classList.toggle('is-active', button.dataset.tab === tabName);
    }
    for (const [key, panel] of Object.entries(tabPanels)) {
      panel.classList.toggle('is-active', key === tabName);
    }
    if (tabName === 'terminal') {
      ensureTerminalStarted();
      scheduleTerminalResize();
    }
  }

  async function refreshDiagnostics() {
    const diagnostics = await window.assistDesktop.getDiagnostics();
    renderDiagnostics(diagnostics);
  }

  retryBtn.addEventListener('click', async () => {
    const diagnostics = await window.assistDesktop.retryDiagnostics();
    renderDiagnostics(diagnostics);
  });

  restartBtn.addEventListener('click', async () => {
    const diagnostics = await window.assistDesktop.restartBridge();
    renderDiagnostics(diagnostics);
    await refreshSessions();
  });

  loginBtn.addEventListener('click', async () => {
    await window.assistDesktop.runCodexLogin();
  });

  docsBtn.addEventListener('click', async () => {
    await window.assistDesktop.openInstallDocs();
  });

  sessionsRefreshBtn.addEventListener('click', () => {
    refreshSessions();
  });

  sessionCancelBtn.addEventListener('click', async () => {
    if (!state.selectedSessionId) {
      return;
    }
    try {
      const snapshot = await window.assistDesktop.cancelSession(state.selectedSessionId);
      upsertSession(snapshot);
    } catch (err) {
      setText(sessionMetaEl, `Failed to cancel session: ${err.message || 'Unknown error'}`);
    }
  });

  terminalStartBtn.addEventListener('click', async () => {
    try {
      const snapshot = await window.assistDesktop.startTerminal();
      state.terminalStartRequested = true;
      applyTerminalSnapshot(snapshot, true);
      activateTab('terminal');
    } catch (err) {
      renderTerminalMeta({
        available: false,
        running: false,
        error: err.message || 'Failed to start terminal',
      });
    }
  });

  terminalRestartBtn.addEventListener('click', async () => {
    try {
      const snapshot = await window.assistDesktop.restartTerminal();
      state.terminalStartRequested = true;
      applyTerminalSnapshot(snapshot, true);
      activateTab('terminal');
    } catch (err) {
      renderTerminalMeta({
        available: false,
        running: false,
        error: err.message || 'Failed to restart terminal',
      });
    }
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tab || 'status');
    });
  }

  window.addEventListener('resize', () => {
    scheduleTerminalResize();
  });

  window.assistDesktop.onDiagnostics((payload) => {
    renderDiagnostics(payload);
  });

  window.assistDesktop.onSessionUpdate((payload) => {
    if (payload && payload.session) {
      upsertSession(payload.session);
      return;
    }
    refreshSessions();
  });

  window.assistDesktop.onTerminalEvent((message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'data') {
      if (ensureTerminal()) {
        state.terminal.write(typeof message.payload === 'string' ? message.payload : '');
      }
      return;
    }
    if (message.type === 'reset') {
      applyTerminalSnapshot(message.payload, true);
      return;
    }
    if (message.type === 'state' || message.type === 'exit') {
      applyTerminalSnapshot(message.payload, false);
      return;
    }
  });

  (async () => {
    try {
      const [diagnostics, sessions, terminalSnapshot] = await Promise.all([
        window.assistDesktop.getDiagnostics(),
        window.assistDesktop.listSessions(),
        window.assistDesktop.getTerminalState(),
      ]);
      renderDiagnostics(diagnostics);
      state.sessions = Array.isArray(sessions) ? sortSessions(sessions) : [];
      renderSessionList();
      applyTerminalSnapshot(terminalSnapshot, true);
    } catch (err) {
      renderDiagnostics(null);
      sessionListEl.innerHTML = `<div class="empty">Failed to initialize desktop UI: ${err.message || 'Unknown error'}</div>`;
    }
  })();
})();
