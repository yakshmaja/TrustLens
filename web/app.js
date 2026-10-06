/* TrustLens client
   Streams pipeline progress over SSE, drives the live lens graphic,
   and renders the report. */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const searchForm      = $('searchForm');
  const domainInput     = $('domainInput');
  const analyzeBtn      = $('analyzeBtn');
  const notice          = $('notice');
  const lensGraphic     = $('lensGraphic');
  const lensArc         = $('lensArc');
  const lensScore       = $('lensScore');
  const methodSection   = $('methodSection');

  const progressSection = $('progressSection');
  const progressTitle   = $('progressTitle');
  const progressTimer   = $('progressTimer');
  const progressBar     = $('progressBar');
  const progressCaption = $('progressCaption');
  const stepper         = $('stepper');
  const stepErrors      = $('stepErrors');

  const errorCard       = $('errorCard');
  const errorMessage    = $('errorMessage');
  const errorRetryBtn   = $('errorRetryBtn');

  const resultsSection  = $('resultsSection');
  const reportHero      = $('reportHero');
  const scoreCompany    = $('scoreCompany');
  const reportMeta      = $('reportMeta');
  const scoreBand       = $('scoreBand');
  const scoreMeter      = $('scoreMeter');
  const scoreMeterFill  = $('scoreMeterFill');
  const gaugeTicks      = $('gaugeTicks');
  const scoreValue      = $('scoreValue');
  const scoreBadges     = $('scoreBadges');
  const scoreSummary    = $('scoreSummary');

  const riskGrid        = $('riskGrid');
  const riskCount       = $('riskCount');
  const positiveSection = $('positiveSection');
  const positiveGrid    = $('positiveGrid');
  const positiveCount   = $('positiveCount');
  const neutralSection  = $('neutralSection');
  const neutralGrid     = $('neutralGrid');
  const neutralCount    = $('neutralCount');
  const evidenceTrailSection = $('evidenceTrailSection');
  const evidenceList    = $('evidenceList');
  const evidenceCount   = $('evidenceCount');
  const missingSection  = $('missingSection');
  const missingList     = $('missingList');
  const reasoningSection = $('reasoningSection');
  const reasoningText   = $('reasoningText');
  const rawEvidenceSection = $('rawEvidenceSection');
  const rawTabs         = $('rawTabs');
  const rawPre          = $('rawPre');

  // Backend URL: Modal when hosted on Vercel, otherwise the Flask
  // server that served this page (localhost, 127.0.0.1, LAN IP).
  const MODAL_API_URL = 'https://yakshmajas--trustlens-analyze.modal.run';
  const API_BASE = window.location.hostname.endsWith('vercel.app')
    ? MODAL_API_URL
    : '/api/analyze/stream';

  // Score bands match the scoring guidance given to the model.
  const BANDS = [
    { min: 90, label: 'Very strong evidence',             color: 'var(--good)' },
    { min: 75, label: 'Strong evidence',                  color: 'var(--good)' },
    { min: 55, label: 'Moderate evidence',                color: 'var(--caution)' },
    { min: 35, label: 'Limited or inconsistent evidence', color: 'var(--serious)' },
    { min: 0,  label: 'Serious evidence-backed concerns', color: 'var(--critical)' }
  ];

  const ASSESSMENTS = {
    strong_evidence_of_real_operation: { label: 'Strong evidence of real operation', color: 'var(--good)' },
    likely_real_but_limited_evidence:  { label: 'Likely real, limited evidence',     color: 'var(--caution)' },
    inconclusive:                      { label: 'Inconclusive',                      color: 'var(--ink-3)' },
    evidence_backed_concerns:          { label: 'Evidence-backed concerns',          color: 'var(--critical)' }
  };

  const ICONS = {
    positive: '<path d="M3 8.5l3.2 3L13 4.5"/>',
    neutral:  '<path d="M4 8h8"/>',
    risk:     '<path d="M8 2.2L14.5 13.5h-13z"/><path d="M8 6.8v3"/><path d="M8 11.8v.1"/>'
  };

  // The model cites collectors by their internal keys
  const SOURCES = {
    whois:           { name: 'WHOIS',      color: 'var(--src-whois)' },
    website:         { name: 'Website',    color: 'var(--src-website)' },
    github:          { name: 'GitHub',     color: 'var(--src-github)' },
    external_search: { name: 'Web search', color: 'var(--src-web)' },
    tavily:          { name: 'Web search', color: 'var(--src-web)' },
    'web search':    { name: 'Web search', color: 'var(--src-web)' }
  };

  const STEPS = ['whois', 'website', 'github', 'tavily', 'normalize', 'analysis'];

  // Pipeline step -> node in the hero graphic
  const GRAPHIC_NODE = {
    whois: 'whois',
    website: 'website',
    github: 'github',
    tavily: 'web'
  };

  const CAPTIONS = {
    whois:     (d) => `Looking up who registered ${d} and when`,
    website:   (d) => `Reading ${d}: homepage, about, team and contact pages`,
    github:    () => 'Looking for the company\'s GitHub organization and recent activity',
    tavily:    () => 'Searching the web for funding, founders, reviews and news',
    normalize: () => 'Combining everything into one evidence packet',
    analysis:  () => 'Mistral is weighing the evidence. This is usually the longest step'
  };

  const STATUS_TEXT = { active: 'Running', done: 'Done', error: 'Failed' };

  const GAUGE_LENGTH = 301.6;   // π × 96, the gauge arc
  const LENS_LENGTH = 339.3;    // 2π × 54, the lens ring

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentEventSource = null;
  let fullResultData = null;
  let currentTarget = '';
  let timerId = null;
  let stepState = {};


  // ── Helpers ──────────────────────────────────────────────

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function bandFor(score) {
    return BANDS.find(band => score >= band.min) || BANDS[BANDS.length - 1];
  }

  function sourceList(source) {
    return String(source || '')
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(part => SOURCES[part.toLowerCase()] || { name: part, color: 'var(--ink-3)' });
  }

  function sourceChips(source) {
    return sourceList(source)
      .map(s => `<span class="source-chip" style="--c:${s.color}">${escapeHtml(s.name)}</span>`)
      .join('');
  }

  function formatAge(years) {
    if (years == null || isNaN(years)) return null;
    if (years >= 1) {
      const whole = Math.floor(years);
      return `${whole} year${whole === 1 ? '' : 's'}`;
    }
    const months = Math.max(1, Math.round(years * 12));
    return `${months} month${months === 1 ? '' : 's'}`;
  }

  function animateNumber(el, to, duration) {
    if (reduceMotion) {
      el.textContent = to;
      return;
    }
    const start = performance.now();
    function frame(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(eased * to);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }


  // ── Scroll reveal ────────────────────────────────────────

  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 })
    : null;

  function observeReveals(root) {
    root.querySelectorAll('.reveal:not(.is-visible)').forEach(el => {
      if (revealObserver) revealObserver.observe(el);
      else el.classList.add('is-visible');
    });
  }


  // ── Hero graphic ─────────────────────────────────────────

  function resetGraphic() {
    lensGraphic.classList.remove('is-running', 'is-analyzing', 'has-score');
    lensGraphic.querySelectorAll('.source').forEach(node => {
      node.classList.remove('is-active', 'is-done', 'is-error');
    });
    lensArc.style.strokeDashoffset = LENS_LENGTH;
  }

  function setGraphicStep(step, state) {
    const nodeName = GRAPHIC_NODE[step];
    if (nodeName) {
      const node = lensGraphic.querySelector(`.source[data-node="${nodeName}"]`);
      node.classList.remove('is-active', 'is-done', 'is-error');
      node.classList.add(`is-${state === 'active' ? 'active' : state === 'done' ? 'done' : 'error'}`);
    }
    lensGraphic.classList.toggle('is-analyzing', step === 'analysis' && state === 'active');
  }

  function showGraphicScore(score, color) {
    lensGraphic.classList.remove('is-running', 'is-analyzing');
    lensGraphic.classList.add('has-score');
    lensGraphic.style.setProperty('--band', color);
    lensScore.textContent = score;
    requestAnimationFrame(() => {
      lensArc.style.strokeDashoffset = LENS_LENGTH * (1 - score / 100);
    });
  }


  // ── Progress ─────────────────────────────────────────────

  function startTimer() {
    const started = Date.now();
    progressTimer.textContent = '0:00';
    clearInterval(timerId);
    timerId = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      progressTimer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerId);
    timerId = null;
  }

  function updateProgressBar() {
    const done = STEPS.filter(s => stepState[s] === 'done' || stepState[s] === 'error').length;
    const active = STEPS.some(s => stepState[s] === 'active') ? 0.5 : 0;
    progressBar.style.width = `${Math.min(100, ((done + active) / STEPS.length) * 100)}%`;
  }

  function setStep(stepName, state, errorText) {
    const step = stepper.querySelector(`.step[data-step="${stepName}"]`);
    if (!step) return;

    stepState[stepName] = state;
    step.classList.remove('active', 'done', 'error');
    step.classList.add(state);
    step.querySelector('.step-status').textContent = STATUS_TEXT[state];

    if (state === 'active') {
      progressCaption.textContent = CAPTIONS[stepName](currentTarget);
    }

    if (state === 'error' && errorText) {
      const name = step.querySelector('.step-name').textContent;
      const item = document.createElement('li');
      item.textContent = `${name}: ${errorText}`;
      stepErrors.appendChild(item);
    }

    setGraphicStep(stepName, state);
    updateProgressBar();
  }


  // ── UI state ─────────────────────────────────────────────

  function setLoading(isLoading) {
    analyzeBtn.disabled = isLoading;
    analyzeBtn.classList.toggle('loading', isLoading);
    analyzeBtn.querySelector('.btn-text').textContent = isLoading ? 'Checking' : 'Run check';
  }

  function resetUI() {
    resultsSection.hidden = true;
    errorCard.hidden = true;
    notice.hidden = true;
    progressSection.hidden = true;
    methodSection.hidden = true;

    stepState = {};
    stepper.querySelectorAll('.step').forEach(step => {
      step.classList.remove('active', 'done', 'error');
      step.querySelector('.step-status').textContent = 'Waiting';
    });
    stepErrors.innerHTML = '';
    progressBar.style.width = '0';
    progressCaption.textContent = 'Starting';

    [riskGrid, positiveGrid, neutralGrid, evidenceList, missingList, scoreBadges]
      .forEach(el => { el.innerHTML = ''; });

    resultsSection.querySelectorAll('.reveal').forEach(el => el.classList.remove('is-visible'));
    scoreSummary.textContent = '';
    reasoningText.textContent = '';
    rawPre.textContent = '';
    scoreValue.textContent = '0';
    scoreMeterFill.style.strokeDashoffset = GAUGE_LENGTH;
    rawEvidenceSection.open = false;

    resetGraphic();
    fullResultData = null;
  }

  function showNotice(html) {
    notice.innerHTML = html;
    notice.hidden = false;
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorCard.hidden = false;
    errorCard.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }


  // ── Report rendering ─────────────────────────────────────

  function drawGaugeTicks() {
    if (gaugeTicks.childElementCount) return;
    const cx = 120, cy = 124, r = 96;
    const ns = 'http://www.w3.org/2000/svg';
    [35, 55, 75, 90].forEach(value => {
      const angle = Math.PI * (1 - value / 100);
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', cx + (r + 11) * cos);
      line.setAttribute('y1', cy - (r + 11) * sin);
      line.setAttribute('x2', cx + (r + 17) * cos);
      line.setAttribute('y2', cy - (r + 17) * sin);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', cx + (r + 28) * cos);
      label.setAttribute('y', cy - (r + 28) * sin + 3);
      label.textContent = value;
      gaugeTicks.append(line, label);
    });
  }

  function renderFinding(signal, type, index) {
    const detail = type === 'neutral'
      ? (signal.explanation || signal.evidence)
      : (signal.evidence || signal.explanation);

    return `
      <li class="finding reveal" style="--delay:${Math.min(index, 6) * 70}ms">
        <span class="finding-icon"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[type]}</svg></span>
        <div>
          <p class="finding-title">${escapeHtml(capitalize(signal.signal))}</p>
          ${detail ? `<p class="finding-text">${escapeHtml(detail)}</p>` : ''}
          ${signal.source ? `<div class="finding-sources">${sourceChips(signal.source)}</div>` : ''}
        </div>
      </li>`;
  }

  function renderEvidenceRow(item) {
    const level = (item.strength || 'low').toLowerCase();
    const filled = { high: 3, medium: 2, low: 1 }[level] || 1;
    const bars = [1, 2, 3].map(i => `<i class="${i <= filled ? 'on' : ''}"></i>`).join('');

    return `
      <tr>
        <td>${escapeHtml(item.claim)}</td>
        <td><div class="source-chips">${sourceChips(item.source)}</div></td>
        <td><span class="strength"><span class="strength-bars" aria-hidden="true">${bars}</span>${escapeHtml(capitalize(level))}</span></td>
      </tr>`;
  }

  function renderFacts(analysis, data) {
    const evidence = data.evidence_packet?.evidence || {};
    const assessment = ASSESSMENTS[analysis.assessment] || ASSESSMENTS.inconclusive;
    const facts = [];

    facts.push([
      'Assessment',
      `<span class="status-dot" style="background:${assessment.color}"></span>${escapeHtml(assessment.label)}`
    ]);

    facts.push(['Confidence', escapeHtml(capitalize(analysis.confidence || 'low'))]);

    const whois = evidence.whois || {};
    const age = formatAge(whois.domain_age_years);
    const year = (whois.creation_date || '').slice(0, 4);
    facts.push([
      'Domain age',
      age ? escapeHtml(year ? `${age} (since ${year})` : age) : 'Not available'
    ]);

    const chips = [];
    if (whois.available) chips.push(['WHOIS', 'var(--src-whois)']);
    if (evidence.website?.available) chips.push(['Website', 'var(--src-website)']);
    const githubLogin = evidence.github?.available && evidence.github.organization?.login;
    if (githubLogin) chips.push([`GitHub · ${githubLogin}`, 'var(--src-github)']);
    const webResults = evidence.external_search?.evidence_statistics?.total_relevant_results;
    if (webResults) chips.push([`${webResults} web results`, 'var(--src-web)']);

    facts.push([
      'Evidence collected',
      chips.length
        ? `<span class="source-chips">${chips.map(([name, color]) =>
            `<span class="source-chip" style="--c:${color}">${escapeHtml(name)}</span>`).join('')}</span>`
        : 'None'
    ]);

    scoreBadges.innerHTML = facts
      .map(([term, value], i) =>
        `<div class="fact reveal" style="--delay:${i * 70}ms"><dt>${term}</dt><dd>${value}</dd></div>`)
      .join('');
  }

  function renderList(section, list, countEl, items, type) {
    if (!items.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    countEl.textContent = items.length;
    list.innerHTML = items.map((item, i) => renderFinding(item, type, i)).join('');
  }

  function renderResults(data) {
    fullResultData = data;
    const analysis = data.analysis?.analysis || {};
    const domain = data.company_domain || '';
    const company = analysis.company || domain || 'Unknown company';

    document.title = `${company} · TrustLens`;

    // Header
    scoreCompany.textContent = company;
    const date = new Date().toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    reportMeta.innerHTML = domain
      ? `<a href="https://${escapeHtml(domain)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a> · ${escapeHtml(date)}`
      : escapeHtml(date);

    // Score
    const score = Math.max(0, Math.min(100, Math.round(Number(analysis.trust_score) || 0)));
    const band = bandFor(score);
    reportHero.style.setProperty('--band', band.color);
    scoreBand.textContent = band.label;
    scoreMeter.setAttribute('aria-label', `Evidence score ${score} out of 100: ${band.label}`);
    drawGaugeTicks();

    renderFacts(analysis, data);
    scoreSummary.textContent = analysis.summary || 'No summary was returned.';

    // Concerns are always shown, so "none found" is stated explicitly
    const risks = analysis.risk_signals || [];
    riskCount.textContent = risks.length;
    riskGrid.innerHTML = risks.length
      ? risks.map((item, i) => renderFinding(item, 'risk', i)).join('')
      : '<li class="empty-note">No evidence-backed concerns were identified in the collected evidence.</li>';

    renderList(positiveSection, positiveGrid, positiveCount, analysis.positive_signals || [], 'positive');
    renderList(neutralSection, neutralGrid, neutralCount, analysis.neutral_signals || [], 'neutral');

    const trail = analysis.evidence_trail || [];
    evidenceTrailSection.hidden = !trail.length;
    evidenceCount.textContent = trail.length;
    evidenceList.innerHTML = trail.map(renderEvidenceRow).join('');

    const missing = analysis.missing_information || [];
    missingSection.hidden = !missing.length;
    missingList.innerHTML = missing.map(item => `<li>${escapeHtml(item)}</li>`).join('');

    reasoningSection.hidden = !analysis.reasoning;
    reasoningText.textContent = analysis.reasoning || '';

    showRawTab('whois');

    progressSection.hidden = true;
    resultsSection.hidden = false;
    observeReveals(resultsSection);

    // Score animations
    scoreMeterFill.style.strokeDashoffset = GAUGE_LENGTH;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scoreMeterFill.style.strokeDashoffset = GAUGE_LENGTH * (1 - score / 100);
      });
    });
    animateNumber(scoreValue, score, 1400);
    showGraphicScore(score, band.color);

    resultsSection.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }


  // ── Raw evidence tabs ────────────────────────────────────

  function showRawTab(tabName) {
    if (!fullResultData) return;

    const evidence = fullResultData.evidence_packet?.evidence || {};
    const content = {
      whois: evidence.whois,
      website: evidence.website,
      github: evidence.github,
      search: evidence.external_search,
      full: fullResultData
    }[tabName] || {};

    rawPre.textContent = JSON.stringify(content, null, 2);

    rawTabs.querySelectorAll('.raw-tab').forEach(tab => {
      const isActive = tab.dataset.tab === tabName;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive);
    });
  }

  rawTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.raw-tab');
    if (tab) showRawTab(tab.dataset.tab);
  });


  // ── Analysis stream ──────────────────────────────────────

  function finish() {
    if (currentEventSource) {
      currentEventSource.close();
      currentEventSource = null;
    }
    stopTimer();
    setLoading(false);
    lensGraphic.classList.remove('is-running', 'is-analyzing');
  }

  function parse(e) {
    try {
      return JSON.parse(e.data);
    } catch (err) {
      return null;
    }
  }

  function startAnalysis(query) {
    if (currentEventSource) currentEventSource.close();

    resetUI();
    setLoading(true);
    currentTarget = query;
    progressTitle.textContent = `Checking ${query}`;
    progressSection.hidden = false;
    lensGraphic.classList.add('is-running');
    startTimer();
    document.title = 'TrustLens · Company due diligence';

    currentEventSource = new EventSource(`${API_BASE}?domain=${encodeURIComponent(query)}`);

    currentEventSource.addEventListener('resolved', (e) => {
      const data = parse(e);
      if (!data) return;
      currentTarget = data.domain;
      progressTitle.textContent = `Checking ${data.domain}`;
      showNotice(
        `Found the website <strong>${escapeHtml(data.domain)}</strong> for “${escapeHtml(data.input)}”`
      );
    });

    currentEventSource.addEventListener('step_start', (e) => {
      const data = parse(e);
      if (data) setStep(data.step, 'active');
    });

    currentEventSource.addEventListener('step_done', (e) => {
      const data = parse(e);
      if (data) setStep(data.step, 'done');
    });

    currentEventSource.addEventListener('step_error', (e) => {
      const data = parse(e);
      if (data) setStep(data.step, 'error', data.error);
    });

    currentEventSource.addEventListener('complete', (e) => {
      const data = parse(e);
      finish();

      if (!data) {
        showError('The server sent a result that could not be read.');
      } else if (data.success && data.result?.analysis?.success === false) {
        // Evidence was collected but the assessment step failed
        progressCaption.textContent = 'Stopped at the assessment step';
        showError(`The assessment step failed: ${data.result.analysis.error || 'unknown error'}`);
      } else if (data.success) {
        renderResults(data.result);
      } else {
        showError(data.error || 'The check failed.');
      }
    });

    currentEventSource.addEventListener('error_event', (e) => {
      const data = parse(e);
      finish();
      resetGraphic();
      progressSection.hidden = true;
      showError((data && data.error) || 'The check failed.');
    });

    currentEventSource.onerror = () => {
      if (!currentEventSource) return;
      finish();
      showError('Lost the connection to the server. Check that the backend is running, then try again.');
    };
  }


  // ── Events ───────────────────────────────────────────────

  // The server accepts a domain or a company name and normalizes it
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = domainInput.value.trim();
    if (!query) {
      domainInput.focus();
      return;
    }
    startAnalysis(query);
  });

  document.querySelectorAll('.example').forEach(button => {
    button.addEventListener('click', () => {
      domainInput.value = button.dataset.query;
      startAnalysis(button.dataset.query);
    });
  });

  errorRetryBtn.addEventListener('click', () => {
    const query = domainInput.value.trim();
    if (query) startAnalysis(query);
  });

  // Ctrl/Cmd+K focuses the search box
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      domainInput.focus();
      domainInput.select();
    }
  });

  observeReveals(document);

})();
