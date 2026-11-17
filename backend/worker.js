/**
 * Smile Studio demo — AI receptionist API (Cloudflare Worker).
 *
 * Secrets / variables to set in Cloudflare (Settings → Variables and Secrets):
 *   GEMINI_API_KEY   (Secret)  key from Google AI Studio
 *   SHEET_URL        (Secret)  Apps Script web app URL (ends in /exec)
 *   SHEET_SECRET     (Secret)  same value as SECRET in apps-script.gs
 *   ALLOWED_ORIGIN   (Text)    e.g. https://nikolaskahris-png.github.io   (optional, default *)
 *   GEMINI_MODEL     (Text)    optional, default gemini-flash-latest
 */

const MAX_TURNS = 16;
const MAX_CHARS = 1000;

const CLINIC = `
CLINIC: Smile Studio — a FICTIONAL dental clinic used as a live demo. Address: 12 Example Street, Athens (demo).
OPENING HOURS: Monday–Friday 09:00–17:00, Saturday 10:00–14:00, Sunday closed. Appointments are 30-minute slots.
SERVICES AND PRICES:
- Check-up & cleaning: €60
- Kids check-up (under 12): €40
- Filling: from €80
- Teeth whitening: €250
- Emergency visit (same day if a slot is free): €90
- Free 15-minute consultation for implants or braces
PAYMENT: card or cash. Most private insurers accepted — bring your insurance card.
CANCELLATION: free up to 24 hours before the appointment.
PARKING: public parking 100 m away.
`;

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Get the free 30-minute appointment slots for one date. Always call this before offering or booking times.',
    parameters: {
      type: 'OBJECT',
      properties: { date: { type: 'STRING', description: 'Date in YYYY-MM-DD format' } },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment. Only call after the patient has confirmed service, date, time, name and phone.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        phone: { type: 'STRING' },
        email: { type: 'STRING' },
        service: { type: 'STRING' },
        date: { type: 'STRING', description: 'YYYY-MM-DD' },
        time: { type: 'STRING', description: 'HH:MM, must be one of the free slots' },
        notes: { type: 'STRING' },
      },
      required: ['name', 'phone', 'service', 'date', 'time'],
    },
  },
  {
    name: 'save_lead',
    description: 'Save contact details of someone interested but not booking yet (e.g. wants a call back or a quote).',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        phone: { type: 'STRING' },
        email: { type: 'STRING' },
        interest: { type: 'STRING', description: 'What they are interested in' },
      },
      required: ['name', 'interest'],
    },
  },
  {
    name: 'handoff_to_human',
    description: 'Pass the conversation to a human team member: when the patient asks for a person, complains, has a question you cannot answer from the clinic info, or describes a medical problem that needs a dentist.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        phone: { type: 'STRING' },
        reason: { type: 'STRING' },
        summary: { type: 'STRING', description: 'Short summary of the conversation for the staff member' },
      },
      required: ['reason', 'summary'],
    },
  },
];

function systemPrompt() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });
  const weekday = now.toLocaleDateString('en-GB', { timeZone: 'Europe/Athens', weekday: 'long' });
  const time = now.toLocaleTimeString('en-GB', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit' });
  return `You are the AI receptionist of Smile Studio. Today is ${weekday} ${date}, local time ${time} (Europe/Athens).
${CLINIC}
RULES:
- Reply in the same language the patient writes in (Greek or English, or any other language).
- Be warm, short and clear: 1–4 sentences. No long lists unless asked.
- Only use the clinic information above. If you do not know something, say so and offer to pass the question to a team member (handoff_to_human).
- Never diagnose or give medical advice. For severe pain, swelling or bleeding, advise the emergency visit; for a life-threatening emergency tell them to call 112.
- Booking flow: ask which service → ask preferred day → call check_availability → offer 2–3 free times → collect full name and phone (email optional) → read back ALL details (service, date, time, name, phone) and ask "Shall I confirm this booking?" → ONLY after the patient answers yes in a new message, call book_appointment → give the booking ID.
- NEVER call book_appointment in the same turn in which you receive the name or phone. Always read the details back first and wait for an explicit yes.
- Write plain text only: no markdown, no asterisks, no bullet symbols.
- Convert relative dates ("tomorrow", "next Monday") to YYYY-MM-DD yourself using today's date.
- Never invent free slots or booking IDs; only use what the tools return.
- If someone gives contact details but does not want to book now, call save_lead.
- This is a public demo: if asked, explain that the clinic is fictional and that the bot shows how an AI receptionist works for a real business.`;
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);

    try {
      if (url.pathname === '/recent' && request.method === 'GET') {
        return json(await sheet(env, { action: 'recent' }), cors);
      }
      if (url.pathname === '/chat' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        let msgs = Array.isArray(body.messages) ? body.messages.slice(-MAX_TURNS) : [];
        while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // Gemini needs a user turn first
        if (!msgs.length) return json({ error: 'no_messages' }, cors, 400);
        const contents = msgs.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(m.text || '').slice(0, MAX_CHARS) }],
        }));
        const result = await runAgent(env, contents);
        return json(result, cors);
      }
      return json({ ok: true, service: 'Smile Studio demo API' }, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String(e && e.message ? e.message : e).slice(0, 300) }, cors, 500);
    }
  },
};

// Models tried in order. If one is overloaded (503), rate-limited (429) or unavailable (404),
// the next one is used, so the demo keeps answering.
function modelList(env) {
  // Fast, light models first: a receptionist needs quick answers more than deep reasoning.
  const list = [env.GEMINI_MODEL, 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];
  return [...new Set(list.filter(Boolean))];
}

const CALL_TIMEOUT_MS = 20000; // give up on one model after 20 s
const TOTAL_BUDGET_MS = 50000; // give up on the whole reply after 50 s

async function callGemini(env, payload, startedAt) {
  let last = '';
  for (const model of modelList(env)) {
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (res.ok) return { ok: true, data: await res.json(), model };
      last = `${model} ${res.status}`;
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`); // bad key or request: don't hide it
      }
      // 404 (model not available), 429 (quota), 5xx (overloaded / timeout): try the next model
    } catch (e) {
      if (String(e && e.message).startsWith('Gemini ')) throw e;
      last = `${model} timeout`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, last };
}

async function runAgent(env, contents) {
  const actions = [];
  const startedAt = Date.now();
  for (let step = 0; step < 5; step++) {
    const r = await callGemini(env, {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      tools: [{ functionDeclarations: TOOLS }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
    }, startedAt);
    if (!r.ok) {
      return { reply: 'The demo is busy right now (free AI quota). Please try again in a minute. / Το demo είναι φορτωμένο, δοκιμάστε ξανά σε ένα λεπτό.', actions, debug: r.last };
    }

    const data = r.data;
    const content = data.candidates && data.candidates[0] && data.candidates[0].content;
    const parts = (content && content.parts) || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return { reply: text || 'Sorry, could you say that again?', actions };
    }

    contents.push(content); // keep the model turn exactly as returned (includes any thought signatures)
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      const out = await callTool(env, name, args || {});
      actions.push({ tool: name, ok: !!out.ok });
      responses.push({ functionResponse: { name, response: out } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { reply: 'Sorry, something went wrong. A team member will help you — please call the clinic.', actions };
}

async function callTool(env, name, a) {
  switch (name) {
    case 'check_availability':
      return sheet(env, { action: 'availability', date: a.date });
    case 'book_appointment':
      return sheet(env, { action: 'book', ...pick(a, ['name', 'phone', 'email', 'service', 'date', 'time', 'notes']) });
    case 'save_lead':
      return sheet(env, { action: 'lead', ...pick(a, ['name', 'phone', 'email', 'interest']) });
    case 'handoff_to_human':
      return sheet(env, { action: 'handoff', ...pick(a, ['name', 'phone', 'reason', 'summary']) });
    default:
      return { ok: false, error: 'unknown_tool' };
  }
}

async function sheet(env, payload) {
  const res = await fetch(env.SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret: env.SHEET_SECRET }),
    redirect: 'follow',
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'sheet_unreachable' };
  }
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] != null) r[k] = String(o[k]);
  return r;
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}
