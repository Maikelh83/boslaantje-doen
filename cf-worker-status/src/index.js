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
      return JSON.parse(raw);
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
  };
}

async function saveState(env, state) {
  await env.STATUS_KV.put("state", JSON.stringify(state));
}

async function postToMeta(env, message) {
  const results = {};

  if (env.FB_PAGE_ID && env.FB_PAGE_TOKEN) {
    try {
      const fbRes = await fetch(`https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}/feed`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message, access_token: env.FB_PAGE_TOKEN }),
      });
      results.facebook = await fbRes.json();
    } catch (e) {
      results.facebook = { error: String(e) };
    }
  } else {
    results.facebook = { skipped: "FB_PAGE_ID / FB_PAGE_TOKEN nog niet ingesteld" };
  }

  if (env.IG_USER_ID && env.FB_PAGE_TOKEN) {
    try {
      const imageUrl = env.IG_STATUS_IMAGE_URL || FALLBACK_IMAGE;
      const createRes = await fetch(`https://graph.facebook.com/v21.0/${env.IG_USER_ID}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          image_url: imageUrl,
          caption: message,
          access_token: env.FB_PAGE_TOKEN,
        }),
      });
      const createJson = await createRes.json();
      if (createJson.id) {
        const pubRes = await fetch(`https://graph.facebook.com/v21.0/${env.IG_USER_ID}/media_publish`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ creation_id: createJson.id, access_token: env.FB_PAGE_TOKEN }),
        });
        results.instagram = await pubRes.json();
      } else {
        results.instagram = createJson;
      }
    } catch (e) {
      results.instagram = { error: String(e) };
    }
  } else {
    results.instagram = { skipped: "IG_USER_ID / FB_PAGE_TOKEN nog niet ingesteld" };
  }

  return results;
}

async function handleTick(env) {
  const ok = await checkCashdesk();
  const state = await getState(env);
  state.lastChecked = new Date().toISOString();
  let socialResult = null;

  if (ok) {
    state.consecutiveOk += 1;
    state.consecutiveFail = 0;
    if (state.down && state.consecutiveOk >= OK_THRESHOLD) {
      state.down = false;
      state.downSince = null;
      const msg =
        "Update: onze online bestelsite is weer bereikbaar! Je kunt weer gewoon bestellen voor bezorgen en afhalen via de website. Bedankt voor je geduld!";
      socialResult = await postToMeta(env, msg);
    }
  } else {
    state.consecutiveFail += 1;
    state.consecutiveOk = 0;
    if (!state.down && state.consecutiveFail >= FAIL_THRESHOLD) {
      state.down = true;
      state.downSince = state.downSince || new Date().toISOString();
      const msg =
        "Let op: onze online bestelsite ligt er momenteel uit. Wil je afhalen? Bel ons even op 0318-514916. Wil je laten bezorgen? Bestel dan via Thuisbezorgd: https://www.thuisbezorgd.nl/menu/boslaantje. Excuses voor het ongemak!";
      socialResult = await postToMeta(env, msg);
    }
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

    if (url.pathname === "/simulate-down" && authorized) {
      const state = await getState(env);
      state.down = true;
      state.downSince = state.downSince || new Date().toISOString();
      state.consecutiveFail = FAIL_THRESHOLD;
      state.consecutiveOk = 0;
      await saveState(env, state);
      return new Response(JSON.stringify(state, null, 2), { headers: CORS_HEADERS });
    }

    if (url.pathname === "/simulate-up" && authorized) {
      const state = await getState(env);
      state.down = false;
      state.downSince = null;
      state.consecutiveFail = 0;
      state.consecutiveOk = OK_THRESHOLD;
      await saveState(env, state);
      return new Response(JSON.stringify(state, null, 2), { headers: CORS_HEADERS });
    }

    return new Response("Boslaantje status monitor", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
