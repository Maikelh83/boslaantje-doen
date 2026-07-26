// functions/api/auth/logout.js
// POST /api/auth/logout — sessie ongeldig maken en cookie wissen.

import { leesSessieIdUitCookie, verwijderCookieHeader, json } from "./_lib.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const sessionId = leesSessieIdUitCookie(request);
    if (sessionId && env.DB) {
      await env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": verwijderCookieHeader() });
  } catch (err) {
    console.error("auth/logout fout:", err);
    return json({ ok: true }, 200, { "Set-Cookie": verwijderCookieHeader() });
  }
}
