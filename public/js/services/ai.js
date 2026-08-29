/**
 * Unified AI Sleep Analyst Service
 * CU SLEEP — WiFi Sleep Monitor
 *
 * Supports both Google Gemini and Anthropic Claude with extended thinking/reasoning.
 * Keys and preferences are stored exclusively in browser localStorage.
 */

export const AI_PROVIDERS = {
  GEMINI: 'gemini',
  CLAUDE: 'claude',
};

export const AI_MODELS = {
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tag: 'Fast · Reasoning', default: true, supportsThinking: true },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tag: 'Deep Clinical Synthesis', supportsThinking: true },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', tag: 'High Speed · Thinking', supportsThinking: true },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', tag: 'Long Context' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', tag: 'Lightweight Baseline' },
  ],
  claude: [
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', tag: 'Hybrid Reasoning · Extended Thinking', default: true, supportsThinking: true },
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', tag: 'High Capability' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', tag: 'Fast & Compact' },
  ],
};

export const THINKING_BUDGETS = [
  { value: 0, label: 'Off (Standard Speed)' },
  { value: 1024, label: 'Low (1,024 tokens)' },
  { value: 2048, label: 'Medium (2,048 tokens)', default: true },
  { value: 4096, label: 'High (4,096 tokens)' },
  { value: 8192, label: 'Deep (8,192 tokens)' },
];

const API_BASE = window.API_BASE ?? '';

// ─── Storage Keys & Settings ──────────────────────────────────────────────

const KEY_PROVIDER = 'sleepmon_ai_provider';
const keyForProvider = p => sleepmon__api_key;
const modelForProvider = p => sleepmon__model;
const thinkingForProvider = p => sleepmon__thinking_budget;

export function getActiveProvider() {
  return localStorage.getItem(KEY_PROVIDER) || AI_PROVIDERS.GEMINI;
}

export function setActiveProvider(provider) {
  if (provider === AI_PROVIDERS.CLAUDE || provider === AI_PROVIDERS.GEMINI) {
    localStorage.setItem(KEY_PROVIDER, provider);
  }
}

export function getStoredApiKey(provider = getActiveProvider()) {
  if (provider === AI_PROVIDERS.GEMINI) {
    return localStorage.getItem(keyForProvider(provider))
        || localStorage.getItem('sleepmon_gemini_api_key')
        || '';
  }
  return localStorage.getItem(keyForProvider(provider)) || '';
}

export function setStoredApiKey(providerOrKey, optionalKey) {
  let provider = getActiveProvider();
  let key = providerOrKey;
  if (optionalKey !== undefined) {
    provider = providerOrKey;
    key = optionalKey;
  }
  if (key) {
    localStorage.setItem(keyForProvider(provider), key.trim());
    if (provider === AI_PROVIDERS.GEMINI) {
      localStorage.setItem('sleepmon_gemini_api_key', key.trim());
    }
  } else {
    clearStoredApiKey(provider);
  }
}

export function clearStoredApiKey(provider = getActiveProvider()) {
  localStorage.removeItem(keyForProvider(provider));
  if (provider === AI_PROVIDERS.GEMINI) {
    localStorage.removeItem('sleepmon_gemini_api_key');
  }
}

export function getSelectedModel(provider = getActiveProvider()) {
  const stored = localStorage.getItem(modelForProvider(provider));
  if (stored && AI_MODELS[provider]?.some(m => m.id === stored)) {
    return stored;
  }
  const def = AI_MODELS[provider]?.find(m => m.default) || AI_MODELS[provider]?.[0];
  return def?.id || (provider === AI_PROVIDERS.CLAUDE ? 'claude-3-7-sonnet-20250219' : 'gemini-2.5-flash');
}

export function setSelectedModel(provider, modelId) {
  localStorage.setItem(modelForProvider(provider), modelId);
}

export function getThinkingBudget(provider = getActiveProvider()) {
  const raw = localStorage.getItem(thinkingForProvider(provider));
  if (raw !== null) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return 2048;
}

export function setThinkingBudget(provider, budget) {
  localStorage.setItem(thinkingForProvider(provider), String(budget));
}

// ─── API Connection Testing ───────────────────────────────────────────────

export async function testApiKey(provider, key, model) {
  if (!key) throw new Error('API key cannot be empty');

  const selectedModel = model || getSelectedModel(provider);

  const res = await fetch(${API_BASE}/api/ai/test, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      api_key: key.trim(),
      model: selectedModel,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || HTTP );
  }

  const result = await res.json();
  return result && result.valid === true;
}

export async function testGeminiKey(key) {
  return testApiKey(AI_PROVIDERS.GEMINI, key, 'gemini-2.5-flash');
}

// ─── Sleep Analysis Generation ───────────────────────────────────────────

export async function generateSleepAnalysis(session, options = {}) {
  if (session && session.aiAnalysis && !options.force) {
    if (typeof session.aiAnalysis === 'string') {
      return { text: session.aiAnalysis, provider: 'ai', model: '' };
    }
    return session.aiAnalysis;
  }

  const provider = options.provider || getActiveProvider();
  const apiKey = options.apiKey || getStoredApiKey(provider);
  const model = options.model || getSelectedModel(provider);
  const thinkingBudget = options.thinkingBudget !== undefined
    ? options.thinkingBudget
    : getThinkingBudget(provider);

  if (!apiKey) {
    const name = provider === AI_PROVIDERS.CLAUDE ? 'Anthropic Claude' : 'Google Gemini';
    throw new Error(${name} API key not configured. Please add your key in the Setup page.);
  }

  const date = session.date ?? session.id;
  const startTime = session.startTime ? new Date(session.startTime * 1000).toLocaleTimeString() : 'N/A';
  const endTime = session.endTime ? new Date(session.endTime * 1000).toLocaleTimeString() : 'N/A';
  const durationHrs = session.startTime && session.endTime
    ? ((session.endTime - session.startTime) / 3600).toFixed(1)
    : 'N/A';

  const systemPrompt = You are a clinical sleep physiology specialist analyzing telemetry from a contactless WiFi Channel State Information (CSI) sleep monitor (ESP32-C6).
Analyze the overnight vitals objectively, scientifically, and reassuringly. Organize your findings into clear structured sections with actionable sleep hygiene takeaways.;

  const prompt = Please provide a clinical sleep analysis based on the following WiFi CSI overnight session data:

## Session Telemetry:
- **Date**: 
- **Recording Interval**:  →  (Total Monitored:  hours,  active minutes)
- **Respiration (Breathing Rate)**:
  - Mean:  RPM (Breaths/min)
  - Min / Max:  –  RPM
- **Cardiovascular (Heart Rate)**:
  - Mean:  BPM
  - Min / Max:  –  BPM
- **Respiratory Events & Sleep Apnea**:
  - Apnea Events (breathing flatline >10 seconds):  events
  - Apnea-Hypopnea Index (AHI):  events/hr
- **Sleep Quality & Stability**:
  - Rest Quality Score: %
  - Mean Phase Variance:  (Lower variance indicates stillness / deep rest)

---

Please organize your report in Markdown into these four exact sections:

### 1. Executive Summary
Provide a 2-3 sentence overview of this sleep session, assessing the overall sleep quality, recovery indicators, and notable highlights.

### 2. Respiration & Apnea Evaluation
Analyze the breathing rate stability. Clinically interpret the Apnea-Hypopnea Index (AHI:  events/hr) using standard clinical ranges:
- Normal: < 5 events/hr
- Mild: 5–15 events/hr
- Moderate: 15–30 events/hr
- Severe: > 30 events/hr
Discuss the frequency and impact of the observed apnea flatline events.

### 3. Cardiovascular & Autonomic Trends
Examine the resting heart rate and range. Assess whether the overnight heart rate pattern indicates normal parasympathetic activation and circadian recovery.

### 4. Sleep Hygiene & Recommendations
Provide 2-3 specific, actionable recommendations tailored specifically to this night's telemetry to optimize sleep continuity and airway patency.

*Keep the tone objective, clinical, and reassuring. Conclude with a standard medical disclaimer in italics.*;

  const res = await fetch(${API_BASE}/api/ai/analyze, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      api_key: apiKey,
      model,
      thinking_budget: thinkingBudget,
      prompt,
      system_prompt: systemPrompt,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || AI Request Failed (HTTP ));
  }

  const data = await res.json();
  return {
    text: data.text || 'Failed to generate analysis content.',
    thinking: data.thinking || null,
    provider: data.provider || provider,
    model: data.model || model,
    usage: data.usage || null,
  };
}

// ─── Markdown Renderer ───────────────────────────────────────────────────

export function renderMarkdown(text) {
  if (!text) return '';

  let cleanText = text.replace(/\r\n/g, '\n').trim();
  const blocks = cleanText.split(/\n\n+/);

  const htmlBlocks = blocks.map(block => {
    const line = block.trim();
    if (!line) return '';

    // Headers
    if (line.startsWith('####')) {
      return <h5></h5>;
    }
    if (line.startsWith('###')) {
      return <h4></h4>;
    }
    if (line.startsWith('##')) {
      return <h3></h3>;
    }
    if (line.startsWith('#')) {
      return <h2></h2>;
    }

    // Horizontal Rule
    if (line === '---' || line === '***') {
      return '<hr class="ai-divider" />';
    }

    // Blockquote
    if (line.startsWith('>')) {
      return <blockquote></blockquote>;
    }

    // Lists
    if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\.\s/.test(line)) {
      const lines = line.split('\n');
      const isOrdered = /^\d+\.\s/.test(lines[0]);

      const listItems = lines.map(item => {
        const itemContent = item.replace(/^(?:-\s|\*\s|\d+\.\s)/, '');
        return <li></li>;
      }).join('');

      return isOrdered ? <ol></ol> : <ul></ul>;
    }

    // Normal paragraph
    return <p></p>;
  });

  return htmlBlocks.join('');
}

function parseInline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong></strong>')
    .replace(/\*(.*?)\*/g, '<em></em>')
    .replace(/(.*?)/g, '<code></code>');
}
