// Relevo AIS para la app «Previsión meteorológica».
// Recibe la suscripción de la app (zona del mapa), le agrega tu clave de AISStream
// (guardada como secreto en Cloudflare) y reenvía los reportes de buques a la app.
export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Relevo AIS activo. Conectate por WebSocket (wss://).", { status: 200 });
    }
    // Solo se aceptan conexiones desde la app publicada (y desde archivo local si se habilita).
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://fetchegaray.github.io").split(",").map(s => s.trim());
    if (!allowed.includes(origin)) return new Response("Origen no autorizado", { status: 403 });
    if (!env.AISSTREAM_KEY) return new Response("Falta configurar AISSTREAM_KEY", { status: 500 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const up = await fetch("https://stream.aisstream.io/v0/stream", { headers: { Upgrade: "websocket" } });
    const ais = up.webSocket;
    if (!ais) { server.close(1011, "No se pudo conectar con AISStream"); return new Response(null, { status: 101, webSocket: client }); }
    ais.accept();

    let last = 0;
    server.addEventListener("message", ev => {
      // AISStream admite como máximo 1 actualización de suscripción por segundo.
      const now = Date.now(); if (now - last < 1100) return; last = now;
      try {
        const m = JSON.parse(ev.data);
        ais.send(JSON.stringify({
          APIKey: env.AISSTREAM_KEY,
          BoundingBoxes: m.BoundingBoxes,
          FilterMessageTypes: m.FilterMessageTypes || ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]
        }));
      } catch (e) { /* mensaje inválido: se ignora */ }
    });
    ais.addEventListener("message", ev => {
      try { server.send(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); } catch (e) {}
    });
    const close = () => { try { ais.close(); } catch (e) {} try { server.close(); } catch (e) {} };
    ais.addEventListener("close", close); ais.addEventListener("error", close);
    server.addEventListener("close", close); server.addEventListener("error", close);
    return new Response(null, { status: 101, webSocket: client });
  }
};
