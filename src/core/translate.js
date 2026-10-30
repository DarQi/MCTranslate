'use strict';
/**
 * Translation engines + protection of Minecraft formatting.
 *
 * Supported engines:
 *  - google   : Free batched Google Translate (up to 40 strings per HTTP request,
 *               rotates across 3 Google hosts to avoid 429 rate limits)
 *  - deepl    : DeepL (Free Web JSON-RPC without key, DeepLX custom endpoint,
 *               or official DeepL API Free :fx / Pro with key)
 *  - mymemory : Free keyless MyMemory API (works without VPN in RU/BY)
 *  - llm      : OpenAI-compatible LLM API (OpenAI, Gemini, DeepSeek, OpenRouter, Ollama)
 */

const PROTECT_RE = /(?:(?:§[0-9a-fk-orx]|&[0-9a-fk-or])+|\{[^{}]*\}|%(?:\d+\$)?[sdf%]|<[^<>]+>|\\n|[\uE000-\uFAFF\uA980-\uA9DF]+)/gi;

function parseGlossary(text) {
  const list = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*(?:=|->|—|–)\s*(.+?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) list.push({ src: m[1], dst: m[2] });
  }
  return list.sort((a, b) => b.src.length - a.src.length);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function protect(text, glossary, glossaryAsTokens) {
  const tokens = [];
  let out = text.replace(PROTECT_RE, (m) => { tokens.push(m); return `{${tokens.length - 1}}`; });
  if (glossaryAsTokens && glossary.length) {
    for (const g of glossary) {
      const re = new RegExp(`(^|[^\\p{L}])(${escapeRe(g.src)})(?=$|[^\\p{L}])`, 'giu');
      out = out.replace(re, (m, pre) => { tokens.push(g.dst); return `${pre}{${tokens.length - 1}}`; });
    }
  }
  return { text: out, tokens };
}

function restore(text, tokens, srcProtected) {
  const used = new Set();
  if (srcProtected) {
    text = text.replace(/\{\s*(\d+)\s*\}( +)/g, (m, d) => {
      const glued = new RegExp(`\\{${d}\\}(?=\\S)`).test(srcProtected);
      return glued ? `{${d}}` : m;
    });
  }
  const out = text.replace(/\{\s*(\d+)\s*\}/g, (m, d) => {
    const k = Number(d);
    if (k < tokens.length) { used.add(k); return tokens[k]; }
    return m;
  });
  const missing = tokens.length - used.size;
  return { text: out, ok: missing === 0 };
}

function keepOuterWhitespace(orig, tr) {
  const lead = /^\s*/.exec(orig)[0];
  const trail = /\s*$/.exec(orig)[0];
  return lead + tr.trim() + trail;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/** Split an array of protected items into sub-chunks constrained by maxItems and maxChars. */
function chunkByChars(items, maxItems, maxChars) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const len = it.text.length + 10;
    if (cur.length && (cur.length >= maxItems || chars + len > maxChars)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ------------------------------------------------------------------ Google Translate (Batched + Multi-Host)
const GOOGLE_HOSTS = [
  'https://clients5.google.com',
  'https://translate.googleapis.com',
  'https://translate.google.com',
];
let googleHostIdx = 0;

async function googleSingleFallback(text, src, dst) {
  const host = GOOGLE_HOSTS[googleHostIdx++ % GOOGLE_HOSTS.length];
  const url = `${host}/translate_a/single?client=gtx&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(dst)}&dt=t`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
    },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!res.ok) {
    const err = new Error(`Google Translate: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data[0] || []).map((x) => x[0]).join('');
}

/**
 * Send up to 40 strings in a single POST request using multiple `q=` parameters
 * to `/translate_a/t?client=dict-chrome-ex`. This reduces request count by ~40x
 * and rotates across 3 Google hosts to avoid 429 rate limits.
 */
async function googleBatchRequest(texts, src, dst) {
  const body = texts.map((q) => 'q=' + encodeURIComponent(q)).join('&');
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const host = GOOGLE_HOSTS[googleHostIdx++ % GOOGLE_HOSTS.length];
    const url = `${host}/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(src)}&tl=${encodeURIComponent(dst)}`;
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
        },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Google Translate: превышен лимит запросов (HTTP ${res.status})`);
        await sleep(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Google Translate: HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data) && data.length === texts.length) {
        return data.map((el) => (typeof el === 'string' ? el : Array.isArray(el) ? String(el[0] ?? '') : ''));
      }
      // Fallback if response shape differs for single string
      if (texts.length === 1 && typeof data === 'string') return [data];
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  // Last-resort per-string fallback via gtx
  try {
    const out = [];
    for (const t of texts) {
      out.push(await googleSingleFallback(t, src, dst));
      if (texts.length > 1) await sleep(150);
    }
    return out;
  } catch {
    throw lastErr || new Error('Google Translate: не удалось выполнить перевод');
  }
}

async function translateGoogle(texts, s) {
  const glossary = parseGlossary(s.glossary);
  const dst = (s.targetLang || 'ru_ru').split('_')[0];
  const src = s.sourceLang || 'auto';
  const prot = texts.map((t, idx) => ({ idx, orig: t, ...protect(t, glossary, true) }));
  const subChunks = chunkByChars(prot, 35, 3600);
  const results = new Array(texts.length);
  const delayMs = Math.max(0, Number(s.requestDelayMs ?? 250));

  for (let c = 0; c < subChunks.length; c++) {
    const chunk = subChunks[c];
    const translated = await googleBatchRequest(chunk.map((x) => x.text), src, dst);
    for (let k = 0; k < chunk.length; k++) {
      const item = chunk[k];
      const r = restore(translated[k] || '', item.tokens, item.text);
      results[item.idx] = { text: keepOuterWhitespace(item.orig, r.text), ok: r.ok };
    }
    if (c + 1 < subChunks.length && delayMs > 0) await sleep(delayMs);
  }
  return results;
}

// ------------------------------------------------------------------ DeepL (Web JSON-RPC + DeepLX + Official API)
const DEEPL_LANG_MAP = {
  ru_ru: 'RU', uk_ua: 'UK', de_de: 'DE', fr_fr: 'FR', es_es: 'ES',
  pl_pl: 'PL', pt_br: 'PT-BR', zh_cn: 'ZH', ja_jp: 'JA', en: 'EN',
};

function toDeepLLang(code, fallback = 'RU') {
  if (!code || code === 'auto') return 'auto';
  const lower = code.toLowerCase();
  return DEEPL_LANG_MAP[lower] || lower.split(/[_-]/)[0].toUpperCase() || fallback;
}

async function deeplOfficialApi(texts, srcLang, dstLang, apiKey, customUrl) {
  const isFree = apiKey.trim().endsWith(':fx');
  const base = (customUrl || (isFree ? 'https://api-free.deepl.com' : 'https://api.deepl.com')).replace(/\/+$/, '');
  const url = base.endsWith('/translate') ? base : `${base}/v2/translate`;
  const payload = { text: texts, target_lang: dstLang };
  if (srcLang && srcLang !== 'auto') payload.source_lang = srcLang;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 451) {
    throw new Error('DeepL недоступен в вашем регионе (HTTP 451 — блокировка РФ/РБ со стороны DeepL). Включите VPN/прокси или выберите Google Translate / MyMemory / Нейросеть.');
  }
  if (res.status === 403) throw new Error('DeepL API: неверный API-ключ (HTTP 403)');
  if (res.status === 456) throw new Error('DeepL API: исчерпан лимит символов на аккаунте (HTTP 456)');
  if (!res.ok) throw new Error(`DeepL API: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.translations)) throw new Error('DeepL API: некорректный ответ сервера');
  return data.translations.map((t) => t.text || '');
}

async function deeplCustomEndpoint(texts, srcLang, dstLang, endpointUrl, apiKey) {
  // Compatible with DeepLX (POST /translate { text, source_lang, target_lang })
  const out = [];
  for (const t of texts) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    const res = await fetchWithTimeout(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: t,
        source_lang: srcLang === 'auto' ? 'auto' : srcLang,
        target_lang: dstLang,
      }),
    });
    if (res.status === 451) {
      throw new Error('DeepL вернул HTTP 451 (недоступно в РФ/РБ без VPN). Включите VPN или переключитесь на Google Translate.');
    }
    if (!res.ok) throw new Error(`DeepLX: HTTP ${res.status}`);
    const data = await res.json();
    out.push(data.data || data.text || (Array.isArray(data.translations) ? data.translations[0]?.text : '') || '');
  }
  return out;
}

async function deeplWebJsonRpc(texts, srcLang, dstLang) {
  let iCount = 1;
  for (const t of texts) for (const ch of t) if (ch === 'i') iCount++;
  const id = Math.floor(Math.random() * 90000000) + 10000000;
  const ts = Date.now();
  const timestamp = ts - (ts % iCount) + iCount;

  const payload = {
    jsonrpc: '2.0',
    method: 'LMT_handle_jobs',
    params: {
      jobs: texts.map((t, idx) => ({
        kind: 'default',
        sentences: [{ text: t, id: idx + 1, prefix: '' }],
        raw_en_context_before: [],
        raw_en_context_after: [],
        preferred_num_beams: 1,
      })),
      lang: {
        target_lang: dstLang.split('-')[0],
        preference: { weight: {}, default: 'default' },
        source_lang_computed: srcLang === 'auto' ? 'EN' : srcLang,
      },
      priority: 1,
      commonJobParams: { mode: 'translate', browserType: 1, textType: 'plaintext' },
      timestamp,
    },
    id,
  };
  let bodyStr = JSON.stringify(payload);
  bodyStr = bodyStr.replace(
    '"method":"',
    (id + 3) % 13 === 0 || (id + 5) % 29 === 0 ? '"method" : "' : '"method": "'
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout('https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': '*/*',
        'Origin': 'https://www.deepl.com',
        'Referer': 'https://www.deepl.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: bodyStr,
    });
    if (res.status === 451) {
      throw new Error('DeepL заблокирован в вашем регионе (HTTP 451 для РФ/РБ без VPN). Включите VPN, укажите DeepLX-зеркало в настройках или выберите Google Translate / MyMemory.');
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`DeepL Web: HTTP ${res.status}`);
    const data = await res.json();
    const translations = data.result?.translations;
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      throw new Error('DeepL Web: неожиданный формат ответа');
    }
    return translations.map((tr) => {
      const beams = tr.beams || [];
      const sentences = beams[0]?.sentences || [];
      return sentences.map((s) => s.text || '').join('');
    });
  }
  throw new Error('DeepL Web: превышен лимит запросов (HTTP 429). Подождите немного или укажите API-ключ DeepL.');
}

async function translateDeepL(texts, s) {
  const glossary = parseGlossary(s.glossary);
  const srcLang = toDeepLLang(s.sourceLang, 'EN');
  const dstLang = toDeepLLang(s.targetLang || 'ru_ru', 'RU');
  const prot = texts.map((t, idx) => ({ idx, orig: t, ...protect(t, glossary, true) }));
  const subChunks = chunkByChars(prot, 20, 3000);
  const results = new Array(texts.length);
  const apiKey = (s.deeplApiKey || '').trim();
  const customUrl = (s.deeplApiUrl || '').trim();
  const delayMs = Math.max(0, Number(s.requestDelayMs ?? 250));

  for (let c = 0; c < subChunks.length; c++) {
    const chunk = subChunks[c];
    const rawTexts = chunk.map((x) => x.text);
    let translated;
    if (apiKey && (!customUrl || customUrl.includes('deepl.com') || customUrl.includes('/v2/'))) {
      translated = await deeplOfficialApi(rawTexts, srcLang, dstLang, apiKey, customUrl);
    } else if (customUrl) {
      translated = await deeplCustomEndpoint(rawTexts, srcLang, dstLang, customUrl, apiKey);
    } else {
      translated = await deeplWebJsonRpc(rawTexts, srcLang, dstLang);
    }
    for (let k = 0; k < chunk.length; k++) {
      const item = chunk[k];
      const r = restore(translated[k] || '', item.tokens, item.text);
      results[item.idx] = { text: keepOuterWhitespace(item.orig, r.text), ok: r.ok };
    }
    if (c + 1 < subChunks.length && delayMs > 0) await sleep(delayMs);
  }
  return results;
}

// ------------------------------------------------------------------ MyMemory (Keyless fallback, works in RU without VPN)
async function translateMyMemory(texts, s) {
  const glossary = parseGlossary(s.glossary);
  const src = !s.sourceLang || s.sourceLang === 'auto' ? 'en' : s.sourceLang.split('_')[0];
  const dst = (s.targetLang || 'ru_ru').split('_')[0];
  const results = new Array(texts.length);
  for (let k = 0; k < texts.length; k++) {
    const p = protect(texts[k], glossary, true);
    let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(p.text)}&langpair=${encodeURIComponent(src)}|${encodeURIComponent(dst)}`;
    if (s.mymemoryEmail) url += `&de=${encodeURIComponent(s.mymemoryEmail.trim())}`;
    const res = await fetchWithTimeout(url, { method: 'GET' });
    if (!res.ok) throw new Error(`MyMemory: HTTP ${res.status}`);
    const data = await res.json();
    if (data.responseStatus && Number(data.responseStatus) !== 200) {
      throw new Error(`MyMemory: ${data.responseDetails || 'HTTP ' + data.responseStatus}`);
    }
    const raw = data.responseData?.translatedText || '';
    const r = restore(raw, p.tokens, p.text);
    results[k] = { text: keepOuterWhitespace(texts[k], r.text), ok: r.ok };
  }
  return results;
}

// ------------------------------------------------------------------ LLM (OpenAI-compatible)
function buildSystemPrompt(s, glossary) {
  const lang = { ru_ru: 'Russian', uk_ua: 'Ukrainian', be_by: 'Belarusian', kk_kz: 'Kazakh', de_de: 'German', es_es: 'Spanish', fr_fr: 'French', pl_pl: 'Polish', pt_br: 'Brazilian Portuguese', zh_cn: 'Simplified Chinese', ja_jp: 'Japanese' }[s.targetLang] || s.targetLang;

  const styleMap = {
    balanced: 'Keep a natural gaming tone: preserve the author\'s humor, casual remarks, and lore while keeping quest instructions clear and accurate.',
    literal: 'Use a strict, concise technical style: focus on maximum accuracy of instructions, crafting steps, and mechanics without literary embellishment.',
    creative: 'Use an expressive, atmospheric literary style suitable for RPG and story-driven quests while keeping mechanics accurate.',
  };
  const namesMap = {
    mods: 'Use the official translation for vanilla Minecraft items/blocks/mobs. Mod names and mod-specific proper nouns should stay in English if there is no established translation.',
    brackets: 'When translating specific modded item, block, or machine names inside quest descriptions, keep the original English name in parentheses on first mention, e.g. "Дробитель (Crusher)", so the player can find it in JEI.',
    translate_all: 'Translate all item, block, machine, and quest names into the target language without leaving English words.',
  };

  let p = `You are a professional localizer of Minecraft modpacks (quests, item tooltips, guide books).
Translate every input string into ${lang}.
Rules:
- ${namesMap[s.llmKeepOriginalNames] || namesMap.mods}
- ${styleMap[s.llmStyle] || styleMap.balanced}
- Tokens like {0}, {1} are placeholders for formatting codes – keep EVERY token exactly as is and in a sensible position.
- Keep line breaks. Do not add explanations, markdown wrappers, or notes.
Input: a JSON array of strings. Output: ONLY a valid JSON array of translated strings of the exact same length and order.`;
  if (glossary.length) p += `\nGlossary (always use these translations):\n` + glossary.map((g) => `${g.src} = ${g.dst}`).join('\n');
  if (s.llmExtraPrompt) p += `\nAdditional instructions: ${s.llmExtraPrompt}`;
  return p;
}

function extractJsonArray(content) {
  // Strip <think>...</think> blocks if returned by local reasoning models (e.g. DeepSeek R1 in Ollama)
  const cleaned = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const c = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = c.indexOf('[');
  const b = c.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error('Модель вернула не JSON-массив');
  return JSON.parse(c.slice(a, b + 1));
}

function resolveLlmModel(s) {
  let model = (s.llmModel || 'deepseek-chat').trim();
  if (s.llmDeepThink) {
    if (model === 'deepseek-chat') return 'deepseek-reasoner';
    if (model === 'gpt-4o-mini') return 'o3-mini';
    if (model === 'gemini-2.5-flash') return 'gemini-2.5-pro';
  } else if (model === 'deepseek-reasoner') {
    return 'deepseek-chat';
  }
  return model;
}

async function translateLLM(texts, s) {
  const glossary = parseGlossary(s.glossary);
  const prot = texts.map((t) => protect(t, glossary, false));
  const base = (s.llmBaseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = resolveLlmModel(s);
  const isAuto = (s.llmParamMode || 'auto') === 'auto';
  const isReasoner = Boolean(s.llmDeepThink) || /reasoner|^o[134]|r1/i.test(model);

  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(s, glossary) },
      { role: 'user', content: JSON.stringify(prot.map((p) => p.text)) },
    ],
  };

  // Reasoner models (like deepseek-reasoner / o3-mini) either ignore or reject temperature/top_p
  if (!isReasoner) {
    body.temperature = isAuto ? 0.2 : Math.max(0, Math.min(1.5, Number(s.llmTemperature ?? 0.2)));
    if (!isAuto && s.llmTopP !== undefined) {
      body.top_p = Math.max(0.1, Math.min(1.0, Number(s.llmTopP ?? 0.95)));
    }
  } else if (!isAuto && s.llmReasoningEffort && s.llmReasoningEffort !== 'auto' && !/deepseek-reasoner/i.test(model)) {
    body.reasoning_effort = s.llmReasoningEffort;
  }

  const maxTokens = isAuto ? (isReasoner ? 8192 : 4096) : Math.max(256, Number(s.llmMaxTokens) || 4096);
  body.max_tokens = maxTokens;

  const headers = { 'Content-Type': 'application/json' };
  if (s.llmApiKey) headers.Authorization = `Bearer ${s.llmApiKey}`;

  let lastErr;
  const timeoutMs = isReasoner ? 300000 : 180000;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM: HTTP ${res.status}`);
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`LLM: HTTP ${res.status} ${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const arr = extractJsonArray(content);
      if (!Array.isArray(arr) || arr.length !== texts.length) {
        lastErr = new Error(`Модель вернула ${arr.length} строк вместо ${texts.length}`);
        continue;
      }
      return arr.map((t, k) => {
        const r = restore(String(t), prot[k].tokens, prot[k].text);
        return { text: keepOuterWhitespace(texts[k], r.text), ok: r.ok };
      });
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message) && !/429/.test(e.message)) break;
    }
  }
  throw lastErr;
}

async function translateBatch(texts, settings) {
  if (!texts.length) return [];
  if (settings.engine === 'llm') return translateLLM(texts, settings);
  if (settings.engine === 'deepl') return translateDeepL(texts, settings);
  if (settings.engine === 'mymemory') return translateMyMemory(texts, settings);
  return translateGoogle(texts, settings);
}

module.exports = { translateBatch, protect, restore, parseGlossary };
