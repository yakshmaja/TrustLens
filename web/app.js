/* TrustLens client
   Streams pipeline progress over SSE and renders the report. */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const searchForm      = $('searchForm');
  const domainInput     = $('domainInput');
  const analyzeBtn      = $('analyzeBtn');
  const notice          = $('notice');
  const methodSection   = $('methodSection');
  const progressSection = $('progressSection');
  const stepper         = $('stepper');
  const errorCard       = $('errorCard');
  const errorMessage    = $('errorMessage');
  const errorRetryBtn   = $('errorRetryBtn');
  const resultsSection  = $('resultsSection');

  const scoreCompany    = $('scoreCompany');
  const reportMeta      = $('reportMeta');
  const scoreValue      = $('scoreValue');
  const scoreBand       = $('scoreBand');
  const scoreMeter      = $('scoreMeter');
  const scoreMeterFill  = $('scoreMeterFill');
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
  const SOURCE_NAMES = {
    whois: 'WHOIS',
    website: 'Website',
    github: 'GitHub',
    external_search: 'Web search',
    tavily: 'Web search'
  };

  const STATUS_TEXT = {
    active: 'Running',
    done: 'Done',
    error: 'Failed'
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentEventSource = null;
  let fullResultData = null;


  // ── Helpers ──────────────────────────────────────────────

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  function formatSource(source) {
    return String(source || '')
      .split(/\s*,\s*/)
      .filter(Boolean)
      .map(part => SOURCE_NAMES[part.toLowerCase()] || part)
      .join(', ');
  }

  function bandFor(score) {
    return BANDS.find(band => score >= band.min) || BANDS[BANDS.length - 1];
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

    stepper.querySelectorAll('.step').forEach(step => {
      step.classList.remove('active', 'done', 'error');
      step.querySelector('.step-status').textContent = 'Waiting';
      const err = step.querySelector('.step-error');
      if (err) err.remove();
    });

    [riskGrid, positiveGrid, neutralGrid, evidenceList, missingList, scoreBadges]
      .forEach(el => { el.innerHTML = ''; });

    scoreSummary.textContent = '';
    reasoningText.textContent = '';
    rawPre.textContent = '';
    scoreMeterFill.style.width = '0';
    rawEvidenceSection.open = false;

    fullResultData = null;
  }

  function showNotice(html) {
    notice.innerHTML = html;
    notice.hidden = false;
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorCard.hidden = false;
  }

  function setStep(stepName, state, errorText) {
    const step = stepper.querySelector(`.step[data-step="${stepName}"]`);
    if (!step) return;

    step.classList.remove('active', 'done', 'error');
    step.classList.add(state);
    step.querySelector('.step-status').textContent = STATUS_TEXT[state];

    if (state === 'error' && errorText) {
      const detail = document.createElement('span');
      detail.className = 'step-error';
      detail.textContent = errorText;
      step.appendChild(detail);
    }
  }


  // ── Report rendering ─────────────────────────────────────

  function renderFinding(signal, type) {
    const detail = type === 'neutral'
      ? (signal.explanation || signal.evidence)
      : (signal.evidence || signal.explanation);

    return `
      <li class="finding ${type}">
        <svg class="finding-icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[type]}</svg>
        <div>
          <p class="finding-title">${escapeHtml(capitalize(signal.signal))}</p>
          ${detail ? `<p class="finding-text">${escapeHtml(detail)}</p>` : ''}
          ${signal.source ? `<p class="finding-source">Source: ${escapeHtml(formatSource(signal.source))}</p>` : ''}
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
        <td>${escapeHtml(formatSource(item.source))}</td>
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
    if (age) {
      const year = (whois.creation_date || '').slice(0, 4);
      facts.push(['Domain age', escapeHtml(year ? `${age} (registered ${year})` : age)]);
    }

    const sources = [];
    if (whois.available) sources.push('WHOIS');
    if (evidence.website?.available) sources.push('website');
    const githubLogin = evidence.github?.available && evidence.github.organization?.login;
    if (githubLogin) sources.push(`GitHub (${githubLogin})`);
    const webResults = evidence.external_search?.evidence_statistics?.total_relevant_results;
    if (webResults) sources.push(`${webResults} web results`);
    if (sources.length) {
      facts.push(['Evidence collected', escapeHtml(sources.join(', '))]);
    }

    scoreBadges.innerHTML = facts
      .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
      .join('');
  }

  function renderList(section, list, countEl, items, type) {
    if (!items.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    countEl.textContent = items.length;
    list.innerHTML = items.map(item => renderFinding(item, type)).join('');
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
      ? `Website <a href="https://${escapeHtml(domain)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a> · ${escapeHtml(date)}`
      : escapeHtml(date);

    // Score
    const score = Math.max(0, Math.min(100, Number(analysis.trust_score) || 0));
    const band = bandFor(score);
    scoreValue.textContent = score;
    scoreBand.textContent = band.label;
    scoreBand.style.setProperty('--band', band.color);
    scoreMeter.style.setProperty('--band', band.color);
    scoreMeter.setAttribute('aria-label', `Evidence score ${score} out of 100: ${band.label}`);
    requestAnimationFrame(() => { scoreMeterFill.style.width = `${score}%`; });

    renderFacts(analysis, data);
    scoreSummary.textContent = analysis.summary || 'No summary was returned.';

    // Concerns are always shown, so "none found" is stated explicitly
    const risks = analysis.risk_signals || [];
    riskCount.textContent = risks.length;
    riskGrid.innerHTML = risks.length
      ? risks.map(item => renderFinding(item, 'risk')).join('')
      : '<li class="empty">No evidence-backed concerns were identified in the collected evidence.</li>';

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
    setLoading(false);
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
    progressSection.hidden = false;
    document.title = 'TrustLens · Company due diligence';

    currentEventSource = new EventSource(`${API_BASE}?domain=${encodeURIComponent(query)}`);

    currentEventSource.addEventListener('resolved', (e) => {
      const data = parse(e);
      if (!data) return;
      showNotice(
        `Searched for “${escapeHtml(data.input)}” and found the website ` +
        `<strong>${escapeHtml(data.domain)}</strong>.`
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

})();
