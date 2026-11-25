// Relevo AIS para la app «Previsión meteorológica» — versión 3.
// Ajustado a la documentación de AISStream (aisstream.io/documentation):
//  · conexión con compresión permessage-deflate (las conexiones sin comprimir tienen límite de ancho
//    de banda desde septiembre de 2026 y AISStream descarta los mensajes que lo exceden);
//  · suscripción completa dentro de los 3 s, en un solo mensaje y con las claves exactas
//    APIKey / BoundingBoxes / FilterMessageTypes;
//  · zonas válidas ([lat, lon], lat entre −90 y 90, lon entre −180 y 180);
//  · como máximo 1 cambio de suscripción por segundo;
//  · reenvío de la confirmación de suscripción (SubscriptionConfirmation) a la app.
//
// IMPORTANTE (Cloudflare): para que la compresión funcione hay que activar el flag
// «web_socket_compression» en Settings → Runtime → Compatibility flags.
//
// Diagnóstico: https://TU-RELEVO.workers.dev/test

const TYPES = ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"];
const UPSTREAM = "https://stream.aisstream.io/v0/stream";

async function openUpstream() {
  const up = await fetch(UPSTREAM, { headers: { Upgrade: "websocket", "Sec-WebSocket-Extensions": "permessage-deflate" } });
  if (!up.webSocket) {
    let body = ""; try { body = (await up.text()).slice(0, 200); } catch (e) {}
    throw new Error(`AISStream no aceptó la conexión (HTTP ${up.status}) ${body}`);
  }
  up.webSocket.accept();
  return { ws: up.webSocket, ext: up.headers.get("Sec-WebSocket-Extensions") || "" };
}
const asText = d => typeof d === "string" ? d : new TextDecoder().decode(d);
const clampBox = b => {
  if (!Array.isArray(b) || b.length !== 2) return null;
  const c = b.map(p => [Math.max(-90, Math.min(90, +p[0])), Math.max(-180, Math.min(180, +p[1]))]);
  return c.some(p => p.some(v => !isFinite(v))) ? null : c;
};
const sub = (key, boxes) => JSON.stringify({ APIKey: key, BoundingBoxes: boxes, FilterMessageTypes: TYPES });

async function selfTest(env) {
  const out = [];
  if (!env.AISSTREAM_KEY) return "ERROR: falta el secreto AISSTREAM_KEY en Settings → Variables and Secrets.";
  out.push(`Clave cargada: sí (${env.AISSTREAM_KEY.length} caracteres, termina en …${env.AISSTREAM_KEY.slice(-4)})`);
  let ws, ext;
  try { ({ ws, ext } = await openUpstream()); out.push("Conexión con AISStream: OK"); }
  catch (e) { out.push("Conexión con AISStream: FALLÓ — " + e.message); return out.join("\n"); }
  out.push("Compresión negociada en la conexión: " + (/permessage-deflate/i.test(ext) ? "sí" : "NO — activá el flag web_socket_compression en Settings → Runtime → Compatibility flags"));
  let n = 0, conf = null, sample = "", err = "", closed = "";
  const done = new Promise(res => {
    const t = setTimeout(res, 20000);
    ws.addEventListener("message", ev => {
      const txt = asText(ev.data);
      try {
        const m = JSON.parse(txt);
        if (m.error) { err = m.error; clearTimeout(t); res(); return; }
        if (m.MessageType === "SubscriptionConfirmation") { conf = m.Message || {}; return; }
        n++;
        if (!sample && m.MetaData) { const md = m.MetaData; sample = `${(md.ShipName || "").trim() || "sin nombre"} (MMSI ${md.MMSI}) en ${(+(md.Latitude ?? md.latitude)).toFixed(3)}, ${(+(md.Longitude ?? md.longitude)).toFixed(3)}`; }
        if (n >= 50) { clearTimeout(t); res(); }
      } catch (e) { err = "respuesta no reconocida: " + txt.slice(0, 120); }
    });
    ws.addEventListener("close", ev => { closed = `código ${ev.code} ${ev.reason || ""}`; clearTimeout(t); res(); });
  });
  ws.send(sub(env.AISSTREAM_KEY, [[[-90, -180], [90, 180]]]));
  await done;
  try { ws.close(1000, "fin de prueba"); } catch (e) {}
  out.push("Confirmación de suscripción: " + (conf ? `sí (compresión según AISStream: ${conf.CompressionEnabled ? "sí" : "no"})` : "NO — según la documentación, AISStream no confirma suscripciones inválidas"));
  if (err) out.push("AISStream respondió con error: " + err);
  if (closed && !n) out.push("AISStream cerró la conexión: " + closed);
  out.push(`Reportes recibidos en la prueba (todo el mundo, hasta 20 s): ${n}`);
  if (sample) out.push("Ejemplo: " + sample);
  if (!n && !err && conf) out.push("Suscripción aceptada pero sin reportes: si la compresión dice NO, activala; si dice sí, es una falla del servicio de AISStream.");
  if (!n && !err && !conf && !closed) out.push("Sin confirmación ni reportes: clave inválida o deshabilitada, límite de 3 conexiones por cuenta alcanzado (cerrá otras pestañas/equipos con la app y esperá unos minutos) o falla del servicio.");
  return out.join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      return new Response(await selfTest(env), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Relevo AIS activo (v3). Para diagnosticar abrí /test en esta misma dirección.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://fetchegaray.github.io").split(",").map(s => s.trim());
    if (!allowed.includes(origin)) return new Response("Origen no autorizado: " + origin, { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const fail = msg => { try { server.send(JSON.stringify({ error: msg })); } catch (e) {} try { server.close(1011, "relevo"); } catch (e) {} };
    if (!env.AISSTREAM_KEY) { fail("Falta el secreto AISSTREAM_KEY en el relevo."); return new Response(null, { status: 101, webSocket: client }); }

    // La suscripción inicial tiene que llegar a AISStream dentro de los 3 s:
    // primero se espera la zona que manda la app y recién ahí se abre la conexión con AISStream.
    let ais = null, opening = null, last = 0, pending = null, count = 0, boxes = null, closedByUs = false;
    const send = () => { if (!ais || !boxes) return; last = Date.now(); try { ais.send(sub(env.AISSTREAM_KEY, boxes)); } catch (e) {} };
    const open = async () => {
      try {
        const r = await openUpstream(); ais = r.ws;
        server.send(JSON.stringify({ relay: "upstream", compression: /permessage-deflate/i.test(r.ext) }));
        ais.addEventListener("message", ev => { count++; try { server.send(asText(ev.data)); } catch (e) {} });
        ais.addEventListener("close", ev => { if (!closedByUs) fail(`AISStream cerró la conexión (código ${ev.code}${ev.reason ? ", " + ev.reason : ""}) tras ${count} mensajes.`); });
        ais.addEventListener("error", () => { if (!closedByUs) fail("Error en la conexión con AISStream."); });
        send();
      } catch (e) { fail(e.message); }
    };
    server.addEventListener("message", ev => {
      let m; try { m = JSON.parse(asText(ev.data)); } catch (e) { return; }
      const b = Array.isArray(m.BoundingBoxes) ? m.BoundingBoxes.map(clampBox).filter(Boolean) : [];
      if (!b.length) return;
      boxes = b;
      if (!ais) { if (!opening) opening = open(); return; }
      const now = Date.now();
      if (now - last >= 1100) send();
      else { clearTimeout(pending); pending = setTimeout(send, 1100 - (now - last) + 50); }
    });
    server.addEventListener("close", () => { closedByUs = true; clearTimeout(pending); try { ais && ais.close(1000, "cliente desconectado"); } catch (e) {} });
    return new Response(null, { status: 101, webSocket: client });
  }
};
