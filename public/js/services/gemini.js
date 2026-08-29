/**
 * Gemini Service — Handles API key storage, connections, and analysis generation
 * WiFi Sleep Monitor
 */

const MODEL_NAME = 'gemini-1.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

/**
 * Get the stored Gemini API key.
 * @returns {string}
 */
export function getStoredApiKey() {
  return localStorage.getItem('sleepmon_gemini_api_key') || '';
}

/**
 * Set the stored Gemini API key.
 * @param {string} key
 */
export function setStoredApiKey(key) {
  if (key) {
    localStorage.setItem('sleepmon_gemini_api_key', key.trim());
  } else {
    clearStoredApiKey();
  }
}

/**
 * Clear the stored Gemini API key.
 */
export function clearStoredApiKey() {
  localStorage.removeItem('sleepmon_gemini_api_key');
}

/**
 * Test a Gemini API key by making a minimal request.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function testGeminiKey(key) {
  if (!key) throw new Error('API key is empty');
  
  const response = await fetch(`${API_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: 'Respond with the word OK if you can read this.' }]
      }],
      generationConfig: {
        maxOutputTokens: 10
      }
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const message = errData.error?.message || `HTTP error ${response.status}`;
    throw new Error(message);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim().toUpperCase().includes('OK');
}

/**
 * Send sleep metrics to Gemini to generate clinical-style analysis.
 * @param {object} session
 * @returns {Promise<string>} Markdown response
 */
export async function generateSleepAnalysis(session) {
  // Check if session already has cached analysis
  if (session && session.aiAnalysis) {
    return session.aiAnalysis;
  }

  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured. Set it in the Setup page.');

  // Formulate data payload. Session times are UNIX epoch seconds.
  const date = session.date ?? session.id;
  const startTime = session.startTime ? new Date(session.startTime * 1000).toLocaleTimeString() : 'N/A';
  const endTime = session.endTime ? new Date(session.endTime * 1000).toLocaleTimeString() : 'N/A';
  const durationHrs = session.startTime && session.endTime
    ? ((session.endTime - session.startTime) / 3600).toFixed(1)
    : 'N/A';

  const prompt = `You are a clinical sleep researcher analyzing data from a contactless WiFi CSI sleep monitoring sensor (ESP32-C6).
Analyze the following sleep session data:
- **Date**: ${date}
- **Session Times**: ${startTime} to ${endTime} (Duration: ${durationHrs} hours)
- **Breathing Rate (Respiration)**:
  - Average: ${session.avgBreathingRate?.toFixed(1) || 'N/A'} RPM
  - Range: ${session.minBreathingRate || 'N/A'} to ${session.maxBreathingRate || 'N/A'} RPM
- **Heart Rate**:
  - Average: ${session.avgHeartRate?.toFixed(1) || 'N/A'} BPM
  - Range: ${session.minHeartRate || 'N/A'} to ${session.maxHeartRate || 'N/A'} BPM
- **Sleep Apnea Indicators**:
  - Total Apnea Events (breathing flatline >10s): ${session.apneaEvents ?? 0}
  - Apnea-Hypopnea Index (AHI): ${session.ahi?.toFixed(2) ?? 0} events/hour
- **Sleep Quality**:
  - Score: ${session.sleepQualityScore ?? 0}%
  - Resting Stability: ${session.avgPresenceVariance?.toFixed(3) || 'N/A'} phase variance (lower = quieter sleep)

Provide a detailed clinical report in Markdown format. Organize your analysis into these four exact sections:

1. ### Executive Summary
Provide a 2-3 sentence clinical summary of the sleep session, assessing the overall sleep quality and identifying any major highlights.

2. ### Respiration & Apnea Evaluation
Analyze the breathing rate range and stability. Focus on the AHI score (${session.ahi?.toFixed(2) ?? 0}) and explain what this index means clinically (e.g. Normal < 5, Mild 5-15, Moderate 15-30, Severe >30). Discuss the frequency of apnea events.

3. ### Cardiovascular Trends
Examine the heart rate metrics. Mention if the heart rate dipped appropriately during sleep (circadian dip) and what the resting heart rate suggests about autonomic nervous system recovery.

4. ### Sleep Hygiene Suggestions
Provide 2-3 specific, actionable sleep hygiene recommendations tailored to this night's data.

Keep the tone highly objective, clinical, and reassuring. Do not make diagnostic claims. Add a standard medical disclaimer at the bottom in italics.`;

  const response = await fetch(`${API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.3
      }
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Gemini API error ${response.status}`);
  }

  const result = await response.json();
  return result.candidates?.[0]?.content?.parts?.[0]?.text || 'Failed to generate analysis content.';
}

/**
 * A basic, safe parser to convert markdown structure to HTML.
 * @param {string} text 
 * @returns {string}
 */
export function renderMarkdown(text) {
  if (!text) return '';
  
  // Normalize newlines
  let cleanText = text.replace(/\r\n/g, '\n').trim();
  
  // Split into paragraphs/blocks by double newlines
  const blocks = cleanText.split('\n\n');
  
  const htmlBlocks = blocks.map(block => {
    const line = block.trim();
    if (!line) return '';
    
    // Headers
    if (line.startsWith('####')) {
      return `<h5>${parseInline(line.replace(/^####\s*/, ''))}</h5>`;
    }
    if (line.startsWith('###')) {
      return `<h4>${parseInline(line.replace(/^###\s*/, ''))}</h4>`;
    }
    if (line.startsWith('##')) {
      return `<h3>${parseInline(line.replace(/^##\s*/, ''))}</h3>`;
    }
    if (line.startsWith('#')) {
      return `<h2>${parseInline(line.replace(/^#\s*/, ''))}</h2>`;
    }
    
    // Blockquote
    if (line.startsWith('>')) {
      return `<blockquote>${parseInline(line.replace(/^>\s*/, ''))}</blockquote>`;
    }
    
    // Lists
    if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\.\s/.test(line)) {
      const lines = line.split('\n');
      const isOrdered = /^\d+\.\s/.test(lines[0]);
      
      const listItems = lines.map(item => {
        const itemContent = item.replace(/^(?:-\s|\*\s|\d+\.\s)/, '');
        return `<li>${parseInline(itemContent)}</li>`;
      }).join('');
      
      return isOrdered ? `<ol>${listItems}</ol>` : `<ul>${listItems}</ul>`;
    }
    
    // Normal paragraph
    return `<p>${parseInline(line)}</p>`;
  });
  
  return htmlBlocks.join('');
}

/**
 * Helper to parse inline bold, italics, and code styles
 */
function parseInline(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}
