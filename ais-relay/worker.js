// Relevo AIS para la app «Previsión meteorológica» — versión 2 (con diagnóstico).
// Recibe la suscripción de la app (zona del mapa), le agrega tu clave de AISStream
// (guardada como secreto AISSTREAM_KEY en Cloudflare) y reenvía los reportes a la app.
//
// Diagnóstico: abrí en el navegador  https://TU-RELEVO.workers.dev/test
// Se conecta 15 segundos a AISStream con todo el mundo como zona y te dice qué pasó.

const TYPES = ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"];
const UPSTREAM = "https://stream.aisstream.io/v0/stream";

async function openUpstream() {
  const up = await fetch(UPSTREAM, { headers: { Upgrade: "websocket" } });
  if (!up.webSocket) {
    let body = ""; try { body = (await up.text()).slice(0, 200); } catch (e) {}
    throw new Error(`AISStream no aceptó la conexión (HTTP ${up.status}) ${body}`);
  }
  up.webSocket.accept();
  return up.webSocket;
}
const asText = d => typeof d === "string" ? d : new TextDecoder().decode(d);

async function selfTest(env) {
  const out = [];
  if (!env.AISSTREAM_KEY) return "ERROR: falta el secreto AISSTREAM_KEY en Settings → Variables and Secrets.";
  out.push(`Clave cargada: sí (${env.AISSTREAM_KEY.length} caracteres, termina en …${env.AISSTREAM_KEY.slice(-4)})`);
  let ws;
  try { ws = await openUpstream(); out.push("Conexión con AISStream: OK"); }
  catch (e) { out.push("Conexión con AISStream: FALLÓ — " + e.message); return out.join("\n"); }
  let n = 0, sample = "", err = "", closed = "";
  const done = new Promise(res => {
    const t = setTimeout(res, 15000);
    ws.addEventListener("message", ev => {
      const txt = asText(ev.data);
      try { const m = JSON.parse(txt); if (m.error) { err = m.error; clearTimeout(t); res(); return; }
        n++; if (!sample && m.MetaData) sample = `${(m.MetaData.ShipName || "").trim() || "sin nombre"} (MMSI ${m.MetaData.MMSI}) en ${(+m.MetaData.latitude).toFixed(3)}, ${(+m.MetaData.longitude).toFixed(3)}`;
        if (n >= 50) { clearTimeout(t); res(); } } catch (e) { err = "respuesta no reconocida: " + txt.slice(0, 120); }
    });
    ws.addEventListener("close", ev => { closed = `código ${ev.code} ${ev.reason || ""}`; clearTimeout(t); res(); });
  });
  ws.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ["PositionReport"] }));
  await done;
  try { ws.close(); } catch (e) {}
  if (err) out.push("AISStream respondió con error: " + err);
  if (closed && !n) out.push("AISStream cerró la conexión: " + closed);
  out.push(`Reportes recibidos en la prueba (todo el mundo, hasta 15 s): ${n}`);
  if (sample) out.push("Ejemplo: " + sample);
  if (!n && !err) out.push("Sin reportes: AISStream aceptó la conexión pero no envió datos. Puede ser una falla temporal del servicio o una clave recién creada; probá de nuevo en unos minutos o generá una clave nueva.");
  return out.join("\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      return new Response(await selfTest(env), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Relevo AIS activo (v2). Para diagnosticar abrí /test en esta misma dirección.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://fetchegaray.github.io").split(",").map(s => s.trim());
    if (!allowed.includes(origin)) return new Response("Origen no autorizado: " + origin, { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const fail = msg => { try { server.send(JSON.stringify({ error: msg })); } catch (e) {} try { server.close(1011, "relevo"); } catch (e) {} };
    if (!env.AISSTREAM_KEY) { fail("Falta el secreto AISSTREAM_KEY en el relevo."); return new Response(null, { status: 101, webSocket: client }); }

    let ais;
    try { ais = await openUpstream(); } catch (e) { fail(e.message); return new Response(null, { status: 101, webSocket: client }); }

    let last = 0, pending = null, count = 0;
    const subscribe = boxes => ais.send(JSON.stringify({ APIKey: env.AISSTREAM_KEY, BoundingBoxes: boxes, FilterMessageTypes: TYPES }));
    server.addEventListener("message", ev => {
      let m; try { m = JSON.parse(asText(ev.data)); } catch (e) { return; }
      if (!Array.isArray(m.BoundingBoxes)) return;
      // AISStream admite como máximo 1 cambio de suscripción por segundo: se agrupan.
      const now = Date.now();
      if (now - last >= 1100) { last = now; subscribe(m.BoundingBoxes); }
      else { clearTimeout(pending); pending = setTimeout(() => { last = Date.now(); subscribe(m.BoundingBoxes); }, 1200); }
    });
    ais.addEventListener("message", ev => {
      count++;
      try { server.send(asText(ev.data)); } catch (e) {}
    });
    ais.addEventListener("close", ev => fail(`AISStream cerró la conexión (código ${ev.code}${ev.reason ? ", " + ev.reason : ""}) tras ${count} reportes.`));
    ais.addEventListener("error", () => fail("Error en la conexión con AISStream."));
    server.addEventListener("close", () => { try { ais.close(); } catch (e) {} });
    return new Response(null, { status: 101, webSocket: client });
  }
};
