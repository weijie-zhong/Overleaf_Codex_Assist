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
  const sessionRawLogEl = document.getElementById('session-raw-log');
  const sessionCancelBtn = document.getElementById('session-cancel-btn');
  const sessionDeleteBtn = document.getElementById('session-delete-btn');
  const sessionsRefreshBtn = document.getElementById('sessions-refresh-btn');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    status: document.getElementById('panel-status'),
    sessions: document.getElementById('panel-sessions'),
  };

  const state = {
    diagnostics: null,
    sessions: [],
    selectedSessionId: '',
    selectedSessionDetail: null,
    activeTab: 'status',
    detailRefreshTimer: null,
    detailRefreshInFlight: false,
    sessionDeletePending: false,
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

  function renderDiagnostics(value) {
    state.diagnostics = value || null;
    const doctor = value && value.doctor && typeof value.doctor === 'object'
      ? value.doctor
      : null;
    const boolOrDash = (boolValue) => (typeof boolValue === 'boolean' ? String(boolValue) : '-');

    if (value && value.startup_error) {
      setText(summaryEl, `Bridge startup error: ${value.startup_error.message || 'Unknown error'}`);
      bridgeBadgeEl.textContent = 'Bridge error';
      bridgeBadgeEl.className = 'badge err';
    } else if (value && value.health && value.health.codex_ready) {
      setText(summaryEl, `Bridge OK on localhost:${value.health.port} (codex ready)`);
      bridgeBadgeEl.textContent = 'Bridge ready';
      bridgeBadgeEl.className = 'badge ok';
    } else if (value && value.health) {
      setText(summaryEl, `Bridge running on localhost:${value.health.port}, but Codex is not ready`);
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
    renderTokenMetrics(value ? value.health : null);

    const checked = value && value.checked_at ? new Date(value.checked_at).toLocaleString() : '-';
    checkedAtEl.textContent = `Last checked: ${checked}`;
  }

  function sortSessions(list) {
    return [...list].sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  }

  function findSession(sessionId) {
    return state.sessions.find((session) => session && session.session_id === sessionId) || null;
  }

  function mergeSessionSummaryIntoDetail(summary) {
    if (
      !summary ||
      typeof summary !== 'object' ||
      !state.selectedSessionDetail ||
      state.selectedSessionDetail.session_id !== summary.session_id
    ) {
      return;
    }
    state.selectedSessionDetail = {
      ...state.selectedSessionDetail,
      status: summary.status,
      status_message: summary.status_message,
      updated_at: summary.updated_at,
      active_run_id: summary.active_run_id,
      session_usage: summary.session_usage,
      last_seq: summary.last_seq,
    };
  }

  function renderRawCliLog(rawCliLog) {
    sessionRawLogEl.innerHTML = '';
    const entries = Array.isArray(rawCliLog) ? rawCliLog : [];
    if (entries.length === 0) {
      sessionRawLogEl.innerHTML = '<div class="empty">No raw CLI output stored yet.</div>';
      return;
    }
    for (const entry of entries) {
      const line = document.createElement('div');
      line.className = `session-raw-entry ${entry.stream === 'stderr' ? 'stderr' : 'stdout'}`;
      const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '-';
      line.innerHTML = `<small>${entry.stream || 'stdout'} | ${ts}</small>`;
      const body = document.createElement('div');
      body.className = 'mono';
      body.textContent = entry.text || '';
      line.appendChild(body);
      sessionRawLogEl.appendChild(line);
    }
    sessionRawLogEl.scrollTop = sessionRawLogEl.scrollHeight;
  }

  function renderSessionDetail(detail) {
    state.selectedSessionDetail = detail || null;
    if (!detail) {
      setText(sessionMetaEl, 'Select a session to inspect its shared transcript and raw CLI output.');
      sessionLogEl.innerHTML = '<div class="empty">No session selected.</div>';
      sessionRawLogEl.innerHTML = '<div class="empty">No session selected.</div>';
      sessionCancelBtn.disabled = true;
      sessionDeleteBtn.disabled = true;
      return;
    }

    setText(
      sessionMetaEl,
      [
        `project_id: ${detail.project_id || '-'}`,
        `session_id: ${detail.session_id || '-'}`,
        `status: ${detail.status || '-'}`,
        `status_message: ${detail.status_message || '-'}`,
        `active_run_id: ${detail.active_run_id || '-'}`,
        `last_seq: ${detail.last_seq || 0}`,
        `estimated_usage: in ${formatWholeNumber(detail.session_usage && detail.session_usage.estimated_input_tokens)} / out ${formatWholeNumber(detail.session_usage && detail.session_usage.estimated_output_tokens)} / total ${formatWholeNumber(detail.session_usage && detail.session_usage.estimated_total_tokens)}`,
      ].join('\n')
    );

    sessionCancelBtn.disabled = detail.status !== 'running' || state.sessionDeletePending;
    sessionDeleteBtn.disabled = state.sessionDeletePending;

    sessionLogEl.innerHTML = '';
    const turns = Array.isArray(detail.chat_turns) ? detail.chat_turns : [];
    if (turns.length === 0) {
      sessionLogEl.innerHTML = '<div class="empty">No transcript stored yet.</div>';
    } else {
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

    renderRawCliLog(detail.raw_cli_log);
  }

  function ensureSelectedSessionId() {
    if (state.sessions.length === 0) {
      state.selectedSessionId = '';
      return;
    }
    if (!state.selectedSessionId || !findSession(state.selectedSessionId)) {
      state.selectedSessionId = state.sessions[0].session_id;
    }
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

    ensureSelectedSessionId();

    for (const session of state.sessions) {
      const button = document.createElement('button');
      button.className = `session-item${session.session_id === state.selectedSessionId ? ' is-active' : ''}`;
      button.type = 'button';
      button.innerHTML = `
        <strong>${session.project_id}</strong>
        <div class="meta">${session.status} | updated ${session.updated_at ? new Date(session.updated_at).toLocaleTimeString() : '-'}</div>
      `;
      button.addEventListener('click', () => {
        if (state.selectedSessionId === session.session_id) {
          return;
        }
        state.selectedSessionId = session.session_id;
        renderSessionList();
        loadSessionDetail(state.selectedSessionId);
      });
      sessionListEl.appendChild(button);
    }
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

  function removeSession(sessionId) {
    if (!sessionId) {
      return;
    }
    state.sessions = state.sessions.filter((item) => item.session_id !== sessionId);
    if (state.selectedSessionId === sessionId) {
      state.selectedSessionId = '';
      state.selectedSessionDetail = null;
    }
    renderSessionList();
    if (state.sessions.length > 0 && !state.selectedSessionDetail) {
      ensureSelectedSessionId();
      renderSessionList();
      loadSessionDetail(state.selectedSessionId);
    }
  }

  async function loadSessionDetail(sessionId) {
    if (!sessionId) {
      renderSessionDetail(null);
      return;
    }
    try {
      const detail = await window.assistDesktop.getSession(sessionId);
      if (!detail) {
        removeSession(sessionId);
        return;
      }
      if (state.selectedSessionId !== sessionId) {
        return;
      }
      renderSessionDetail(detail);
    } catch (err) {
      if (state.selectedSessionId === sessionId) {
        setText(sessionMetaEl, `Failed to load session detail: ${err.message || 'Unknown error'}`);
      }
    }
  }

  function scheduleSelectedSessionDetailRefresh() {
    if (!state.selectedSessionId || state.detailRefreshInFlight) {
      return;
    }
    if (state.detailRefreshTimer) {
      clearTimeout(state.detailRefreshTimer);
    }
    state.detailRefreshTimer = setTimeout(async () => {
      if (!state.selectedSessionId) {
        return;
      }
      state.detailRefreshInFlight = true;
      try {
        await loadSessionDetail(state.selectedSessionId);
      } finally {
        state.detailRefreshInFlight = false;
      }
    }, 40);
  }

  async function refreshSessions() {
    try {
      const sessions = await window.assistDesktop.listSessions();
      state.sessions = Array.isArray(sessions) ? sortSessions(sessions) : [];
      renderSessionList();
      if (state.sessions.length > 0) {
        ensureSelectedSessionId();
        renderSessionList();
        await loadSessionDetail(state.selectedSessionId);
      } else {
        renderSessionDetail(null);
      }
    } catch (err) {
      sessionListEl.innerHTML = `<div class="empty">Failed to load sessions: ${err.message || 'Unknown error'}</div>`;
      renderSessionDetail(null);
    }
  }

  function appendRawCliEntry(rawCliEntry) {
    if (
      !rawCliEntry ||
      typeof rawCliEntry !== 'object' ||
      !state.selectedSessionDetail ||
      state.selectedSessionDetail.session_id !== state.selectedSessionId
    ) {
      return;
    }
    const currentEntries = Array.isArray(state.selectedSessionDetail.raw_cli_log)
      ? state.selectedSessionDetail.raw_cli_log
      : [];
    const nextSeq = Number.isFinite(Number(rawCliEntry.seq))
      ? Math.max(0, Math.floor(Number(rawCliEntry.seq)))
      : 0;
    const lastSeq = currentEntries.length > 0
      ? Number(currentEntries[currentEntries.length - 1].seq || 0)
      : 0;
    if (nextSeq > 0 && nextSeq <= lastSeq) {
      return;
    }
    state.selectedSessionDetail = {
      ...state.selectedSessionDetail,
      raw_cli_log: [...currentEntries, rawCliEntry],
    };
    renderRawCliLog(state.selectedSessionDetail.raw_cli_log);
  }

  function activateTab(tabName) {
    state.activeTab = tabName;
    for (const button of tabButtons) {
      button.classList.toggle('is-active', button.dataset.tab === tabName);
    }
    for (const [key, panel] of Object.entries(tabPanels)) {
      panel.classList.toggle('is-active', key === tabName);
    }
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
      const detail = await window.assistDesktop.cancelSession(state.selectedSessionId);
      if (detail) {
        upsertSession(detail);
        if (state.selectedSessionId === detail.session_id) {
          renderSessionDetail(detail);
        }
      } else {
        await loadSessionDetail(state.selectedSessionId);
      }
    } catch (err) {
      setText(sessionMetaEl, `Failed to cancel session: ${err.message || 'Unknown error'}`);
    }
  });

  sessionDeleteBtn.addEventListener('click', async () => {
    if (!state.selectedSessionId) {
      return;
    }
    const detail = state.selectedSessionDetail;
    const projectLabel = detail && detail.project_id ? detail.project_id : state.selectedSessionId;
    const runningNote = detail && detail.status === 'running'
      ? '\n\nThis will stop the active run and then delete the stored session.'
      : '';
    const confirmed = window.confirm(
      `Delete stored session for ${projectLabel}?${runningNote}`
    );
    if (!confirmed) {
      return;
    }

    state.sessionDeletePending = true;
    renderSessionDetail(state.selectedSessionDetail);
    try {
      const result = await window.assistDesktop.deleteSession(state.selectedSessionId);
      removeSession(result && result.session_id ? result.session_id : state.selectedSessionId);
    } catch (err) {
      setText(sessionMetaEl, `Failed to delete session: ${err.message || 'Unknown error'}`);
    } finally {
      state.sessionDeletePending = false;
      if (state.selectedSessionDetail) {
        renderSessionDetail(state.selectedSessionDetail);
      }
    }
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tab || 'status');
    });
  }

  window.assistDesktop.onDiagnostics((payload) => {
    renderDiagnostics(payload);
  });

  window.assistDesktop.onSessionUpdate((payload) => {
    if (!payload || typeof payload !== 'object') {
      refreshSessions();
      return;
    }

    if (payload.deleted) {
      removeSession(payload.session_id || '');
      return;
    }

    if (payload.session) {
      upsertSession(payload.session);
      if (payload.session.session_id === state.selectedSessionId) {
        mergeSessionSummaryIntoDetail(payload.session);
        if (payload.raw_cli_entry) {
          appendRawCliEntry(payload.raw_cli_entry);
        } else {
          scheduleSelectedSessionDetailRefresh();
        }
      }
      return;
    }

    refreshSessions();
  });

  (async () => {
    try {
      const [diagnostics, sessions] = await Promise.all([
        window.assistDesktop.getDiagnostics(),
        window.assistDesktop.listSessions(),
      ]);
      renderDiagnostics(diagnostics);
      state.sessions = Array.isArray(sessions) ? sortSessions(sessions) : [];
      renderSessionList();
      if (state.sessions.length > 0) {
        ensureSelectedSessionId();
        renderSessionList();
        await loadSessionDetail(state.selectedSessionId);
      } else {
        renderSessionDetail(null);
      }
    } catch (err) {
      renderDiagnostics(null);
      sessionListEl.innerHTML = `<div class="empty">Failed to initialize desktop UI: ${err.message || 'Unknown error'}</div>`;
      renderSessionDetail(null);
    }
  })();
})();
