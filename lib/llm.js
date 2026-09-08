// Minimal OpenAI-compatible chat client with structured output, timeouts,
// retries, and a JSON "repair" pass for malformed responses.
// Provider is configured via environment variables (see README).

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-plus';

export class LLMError extends Error {
  constructor(message, { retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'LLMError';
    this.retryable = retryable;
    this.cause = cause;
  }
}

export function getLLMConfig() {
  const apiKey = process.env.LLM_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new LLMError(
      'Missing LLM API key. Set LLM_API_KEY (or DASHSCOPE_API_KEY) in the environment or .env — see README.',
    );
  }
  return {
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 90_000),
  };
}

async function rawChat({ apiKey, baseUrl, model, timeoutMs }, messages, { temperature = 0.2 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LLMError(`LLM request timed out after ${timeoutMs / 1000}s`, { retryable: true, cause: err });
    }
    throw new LLMError(`Network error talking to LLM: ${err.message}`, { retryable: true, cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new LLMError('LLM rate limit hit (429)', { retryable: true });
  }
  if (res.status >= 500) {
    throw new LLMError(`LLM provider error (${res.status})`, { retryable: true });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LLMError(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LLMError('LLM returned an empty completion', { retryable: true });
  }
  return content;
}

function extractJson(text) {
  // Models occasionally wrap JSON in prose or code fences despite json_object mode.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  if (end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the LLM and return a validated JSON object.
 * @param {{system: string, user: string}} prompt
 * @param {(raw: unknown) => T} validate  normalizer; throws ValidationError on bad shape
 * @returns {Promise<T>}
 */
export async function callStructured(prompt, validate, { maxAttempts = 3 } = {}) {
  const cfg = getLLMConfig();
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(Math.min(1000 * 2 ** (attempt - 1), 4000)); // backoff: 2s, 4s
    try {
      const content = await rawChat(cfg, messages);
      const parsed = extractJson(content);
      if (parsed == null) {
        lastErr = new LLMError('LLM output was not parseable JSON', { retryable: true });
        // Feed the bad output back so the retry has a chance to self-correct.
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.' });
        continue;
      }
      try {
        return validate(parsed);
      } catch (verr) {
        lastErr = verr;
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: `Your previous JSON failed validation: ${verr.message}\nReply again with ONLY a corrected JSON object matching the required shape.` });
        continue;
      }
    } catch (err) {
      if (err instanceof LLMError && !err.retryable) throw err;
      lastErr = err;
    }
  }
  throw new LLMError(`LLM call failed after ${maxAttempts} attempts: ${lastErr.message}`, { cause: lastErr });
}
