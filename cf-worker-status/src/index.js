const CASHDESK_URL = "https://www.boslaantjedoen.nl/SelectStore/boslaantje-doen";
const FALLBACK_IMAGE = "https://boslaantjedoen.com/images/hero-boslaantje-doen.jpg";
const FAIL_THRESHOLD = 2; // 2x5 min = ~10 min bevestigde storing voordat we "down" melden
const OK_THRESHOLD = 2;   // 2x5 min bevestigd herstel voordat we "up" melden
const TIMEOUT_MS = 10000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

// Openingstijden van de snackbar (Europe/Amsterdam). Buiten deze tijden posten
// we GEEN storings-/herstelberichten op Facebook/Instagram, want dan is de
// zaak toch gesloten en heeft een melding geen zin. De banner op de website
// zelf (via /status.json) blijft wel altijd kloppen, ongeacht openingstijd.
const OPENING_HOURS = {
  Mon: [16 * 60, 21 * 60],
  Tue: [16 * 60, 21 * 60],
  Wed: [16 * 60, 21 * 60],
  Thu: [16 * 60, 21 * 60],
  Fri: [11 * 60, 21 * 60],
  Sat: [16 * 60, 21 * 60],
  Sun: null, // gesloten
};

function isBusinessHours(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const range = OPENING_HOURS[map.weekday];
  if (!range) return false;
  const minutesNow = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
  return minutesNow >= range[0] && minutesNow < range[1];
}

async function checkCashdesk() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CASHDESK_URL, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "BoslaantjeStatusMonitor/1.0" },
    });
    clearTimeout(timer);
    // 5xx of geen respons = storing. Alles onder de 500 (incl. redirects/4xx) tellen we als "bereikbaar".
    return res.status < 500;
  } catch (e) {
    clearTimeout(timer);
    return false;
  }
}

async function getState(env) {
  const raw = await env.STATUS_KV.get("state");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        down: false,
        consecutiveFail: 0,
        consecutiveOk: 0,
        downSince: null,
        lastChecked: null,
        notifiedDown: false,
        pendingUpNotify: false,
        ...parsed,
      };
    } catch (e) {
      /* corrupt state, val terug op default */
    }
  }
  return {
    down: false,
    consecutiveFail: 0,
    consecutiveOk: 0,
    downSince: null,
    lastChecked: null,
    notifiedDown: false,
    pendingUpNotify: false,
  };
}

async function saveState(env, state) {
  await env.STATUS_KV.put("state", JSON.stringify(state));
}

// Post-route: deze Worker roept alleen de Make.com-webhook aan (event/message/timestamp).
// Make.com regelt vervolgens zelf de branded Facebook- en Instagram-posts (met plaatje).
// Er wordt hier NIET meer rechtstreeks naar de Facebook/Instagram Graph API gepost,
// om te voorkomen dat berichten dubbel geplaatst worden.
async function postToMakeWebhook(env, event, message) {
  if (!env.MAKE_WEBHOOK_URL) {
    return { skipped: "MAKE_WEBHOOK_URL nog niet ingesteld" };
  }
  try {
    const res = await fetch(env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        message,
        timestamp: new Date().toISOString(),
      }),
    });
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (e) {
    return { error: String(e) };
  }
}

const DOWN_MESSAGE =
  "Let op: onze online bestelsite ligt er momenteel uit. Wil je afhalen? Bel ons even op 0318-514916. Wil je laten bezorgen? Bestel dan via Thuisbezorgd: https://www.thuisbezorgd.nl/menu/boslaantje. Excuses voor het ongemak!";
const UP_MESSAGE =
  "Update: onze online bestelsite is weer bereikbaar! Je kunt weer gewoon bestellen voor bezorgen en afhalen via de website. Bedankt voor je geduld!";

async function handleTick(env) {
  const ok = await checkCashdesk();
  const state = await getState(env);
  const now = new Date();
  const withinHours = isBusinessHours(now);
  state.lastChecked = now.toISOString();
  let socialResult = null;

  if (ok) {
    state.consecutiveOk += 1;
    state.consecutiveFail = 0;
    if (state.down && state.consecutiveOk >= OK_THRESHOLD) {
      state.down = false;
      state.downSince = null;
      if (state.notifiedDown) {
        if (withinHours) {
          socialResult = await postToMakeWebhook(env, "up", UP_MESSAGE);
          state.notifiedDown = false;
          state.pendingUpNotify = false;
        } else {
          // storing was gemeld, herstel wachten tot de zaak weer open is
          state.pendingUpNotify = true;
        }
      } else {
        // storing is nooit gemeld (viel volledig buiten openingstijden), dus ook geen herstelbericht nodig
        state.pendingUpNotify = false;
      }
    }
  } else {
    state.consecutiveFail += 1;
    state.consecutiveOk = 0;
    if (!state.down && state.consecutiveFail >= FAIL_THRESHOLD) {
      state.down = true;
      state.downSince = state.downSince || now.toISOString();
      if (withinHours) {
        socialResult = await postToMakeWebhook(env, "down", DOWN_MESSAGE);
        state.notifiedDown = true;
      } else {
        state.notifiedDown = false; // wordt ingehaald zodra de zaak open gaat
      }
    }
  }

  // Inhaalslag: storing was (nog) niet gemeld en de zaak is nu open -> alsnog posten
  if (state.down && !state.notifiedDown && withinHours) {
    socialResult = await postToMakeWebhook(env, "down", DOWN_MESSAGE);
    state.notifiedDown = true;
  }
  // Inhaalslag: herstel stond klaar te wachten en de zaak is nu open -> alsnog posten
  if (!state.down && state.pendingUpNotify && withinHours) {
    socialResult = await postToMakeWebhook(env, "up", UP_MESSAGE);
    state.pendingUpNotify = false;
  }

  await saveState(env, state);
  return { state, socialResult };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleTick(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/status.json") {
      const state = await getState(env);
      return new Response(
        JSON.stringify({
          down: state.down,
          downSince: state.downSince,
          lastChecked: state.lastChecked,
        }),
        { headers: CORS_HEADERS }
      );
    }

    // Handmatige/test-endpoints: alleen bruikbaar met de juiste sleutel (env.TRIGGER_KEY),
    // zodat vreemden niet zomaar de banner of social posts kunnen laten afgaan.
    const key = url.searchParams.get("key");
    const authorized = env.TRIGGER_KEY && key === env.TRIGGER_KEY;

    if (url.pathname === "/check-now" && authorized) {
      const result = await handleTick(env);
      return new Response(JSON.stringify(result, null, 2), { headers: CORS_HEADERS });
    }

    if (url.pathname === "/debug-hours" && authorized) {
      const now = new Date();
      return new Response(
        JSON.stringify({ now: now.toISOString(), withinBusinessHours: isBusinessHours(now) }, null, 2),
        { headers: CORS_HEADERS }
      );
    }

    // simulate-down/up zetten niet alleen de state (voor de banner op de site),
    // maar roepen ook echt de Make-webhook aan, zodat je de volledige keten
    // (Worker -> Make -> Facebook/Instagram) kan testen zonder op een echte
    // storing te hoeven wachten. Deze test-endpoints negeren bewust de
    // openingstijden-check, zodat je altijd kan testen. Voeg ?post=0 toe om
    // alléén de state te zetten zonder de webhook aan te roepen.
    if (url.pathname === "/simulate-down" && authorized) {
      const state = await getState(env);
      state.down = true;
      state.downSince = state.downSince || new Date().toISOString();
      state.consecutiveFail = FAIL_THRESHOLD;
      state.consecutiveOk = 0;
      state.notifiedDown = true;
      await saveState(env, state);
      let socialResult = null;
      if (url.searchParams.get("post") !== "0") {
        socialResult = await postToMakeWebhook(env, "down", DOWN_MESSAGE);
      }
      return new Response(JSON.stringify({ state, socialResult }, null, 2), { headers: CORS_HEADERS });
    }

    if (url.pathname === "/simulate-up" && authorized) {
      const state = await getState(env);
      state.down = false;
      state.downSince = null;
      state.consecutiveFail = 0;
      state.consecutiveOk = OK_THRESHOLD;
      state.notifiedDown = false;
      state.pendingUpNotify = false;
      await saveState(env, state);
      let socialResult = null;
      if (url.searchParams.get("post") !== "0") {
        socialResult = await postToMakeWebhook(env, "up", UP_MESSAGE);
      }
      return new Response(JSON.stringify({ state, socialResult }, null, 2), { headers: CORS_HEADERS });
    }

    return new Response("Boslaantje status monitor", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
