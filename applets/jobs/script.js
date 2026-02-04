// Load jobs on startup
console.log('[Jobs Applet] Script loaded');

// DOMContentLoaded may have already fired, so try both approaches
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[Jobs Applet] DOMContentLoaded fired');
    loadJobs();
  });
} else {
  // DOM is already ready
  console.log('[Jobs Applet] DOM already ready, loading immediately');
  loadJobs();
}

async function loadJobs() {
  console.log('[Jobs Applet] loadJobs() called');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const jobsList = document.getElementById('jobs-list');
  const empty = document.getElementById('empty');

  console.log('[Jobs Applet] Elements:', { loading, error, jobsList, empty });

  // Show loading
  loading.style.display = 'block';
  error.style.display = 'none';
  jobsList.innerHTML = '';
  empty.style.display = 'none';

  try {
    console.log('[Jobs Applet] Fetching /api/schedule...');
    const response = await fetch('/api/schedule');
    console.log('[Jobs Applet] Response:', response.status, response.statusText);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const jobs = data.schedules || [];
    
    loading.style.display = 'none';

    if (!jobs || jobs.length === 0) {
      empty.style.display = 'block';
      return;
    }

    // Render jobs
    jobs.forEach(job => {
      const jobCard = createJobCard(job);
      jobsList.appendChild(jobCard);
    });

  } catch (err) {
    loading.style.display = 'none';
    error.style.display = 'block';
    error.textContent = `Error: ${err.message}`;
    console.error('Failed to load jobs:', err);
  }
}

function createJobCard(job) {
  const card = document.createElement('div');
  card.className = 'job-card';

  // Header with slug and status
  const header = document.createElement('div');
  header.className = 'job-header';
  
  const title = document.createElement('div');
  title.className = 'job-title';
  
  const slug = document.createElement('div');
  slug.className = 'job-slug';
  slug.textContent = job.slug;
  
  const statusBadge = document.createElement('span');
  statusBadge.className = `status-badge ${job.enabled ? 'status-enabled' : 'status-disabled'}`;
  statusBadge.textContent = job.enabled ? 'Enabled' : 'Disabled';
  
  title.appendChild(slug);
  title.appendChild(statusBadge);
  header.appendChild(title);

  // Last result badge (if available)
  if (job.lastResult) {
    const resultBadge = document.createElement('span');
    resultBadge.className = `result-badge result-${job.lastResult}`;
    resultBadge.textContent = job.lastResult;
    header.appendChild(resultBadge);
  }

  card.appendChild(header);

  // Prompt
  if (job.prompt) {
    const prompt = document.createElement('div');
    prompt.className = 'job-prompt';
    prompt.textContent = job.prompt;
    card.appendChild(prompt);
  }

  // Schedule info
  if (job.schedule) {
    const scheduleInfo = document.createElement('div');
    scheduleInfo.className = 'schedule-info';
    
    const scheduleType = document.createElement('div');
    scheduleType.className = 'schedule-type';
    scheduleType.textContent = `Schedule Type: ${job.schedule.type}`;
    
    const scheduleExpression = document.createElement('div');
    scheduleExpression.className = 'schedule-expression';
    scheduleExpression.textContent = job.schedule.type === 'cron' 
      ? job.schedule.expression 
      : `Every ${job.schedule.intervalMinutes} minutes`;
    
    scheduleInfo.appendChild(scheduleType);
    scheduleInfo.appendChild(scheduleExpression);
    card.appendChild(scheduleInfo);
  }

  // Details grid
  const details = document.createElement('div');
  details.className = 'job-details';

  // Next run
  if (job.nextRun) {
    details.appendChild(createDetailItem('Next Run', formatDateTime(job.nextRun), 'time'));
  }

  // Last run
  if (job.lastRun) {
    details.appendChild(createDetailItem('Last Run', formatDateTime(job.lastRun), 'time'));
  }

  // Session ID
  if (job.sessionId) {
    details.appendChild(createDetailItem('Session ID', job.sessionId, 'highlight'));
  }

  // Model
  if (job.sessionConfig?.model) {
    details.appendChild(createDetailItem('Model', job.sessionConfig.model, 'highlight'));
  }

  // Persist session
  if (job.sessionConfig?.persistSession !== undefined) {
    details.appendChild(createDetailItem('Persist Session', job.sessionConfig.persistSession ? 'Yes' : 'No'));
  }

  // Last error
  if (job.lastError) {
    details.appendChild(createDetailItem('Last Error', job.lastError, 'error'));
  }

  card.appendChild(details);

  return card;
}

function createDetailItem(label, value, className = '') {
  const item = document.createElement('div');
  item.className = 'detail-item';

  const labelEl = document.createElement('div');
  labelEl.className = 'detail-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = `detail-value ${className}`;
  valueEl.textContent = value;

  item.appendChild(labelEl);
  item.appendChild(valueEl);

  return item;
}

function formatDateTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date - now;
    const diffMins = Math.round(diffMs / 60000);
    
    // Format the date/time
    const formatted = date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    // Add relative time
    if (Math.abs(diffMins) < 60) {
      if (diffMins > 0) {
        return `${formatted} (in ${diffMins}m)`;
      } else if (diffMins < 0) {
        return `${formatted} (${Math.abs(diffMins)}m ago)`;
      } else {
        return `${formatted} (now)`;
      }
    } else if (Math.abs(diffMins) < 1440) { // < 24 hours
      const diffHours = Math.round(diffMins / 60);
      if (diffHours > 0) {
        return `${formatted} (in ${diffHours}h)`;
      } else {
        return `${formatted} (${Math.abs(diffHours)}h ago)`;
      }
    }

    return formatted;
  } catch (err) {
    return isoString;
  }
}

function refreshJobs() {
  console.log('[Jobs Applet] Refresh button clicked');
  loadJobs();
}

// Make refreshJobs available globally for onclick handler
window.refreshJobs = refreshJobs;
