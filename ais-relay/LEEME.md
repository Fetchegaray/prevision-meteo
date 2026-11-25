# Relevo AIS (Cloudflare Worker)

AISStream.io no permite conexiones directas desde páginas web, para que la clave no quede expuesta.
Este relevo guarda tu clave en Cloudflare y le pasa a la app solo los buques de la zona que estás mirando.
Es gratis dentro del plan gratuito de Cloudflare Workers.

## 1. Clave de AISStream
1. Entrá a https://aisstream.io e iniciá sesión (con GitHub, por ejemplo).
2. En **API Keys** creá una clave y copiala.

## 2. Crear el Worker
1. Entrá a https://dash.cloudflare.com (creá la cuenta si no la tenés).
2. **Workers & Pages → Create → Create Worker**. Ponele un nombre, por ejemplo `ais-relay`, y tocá **Deploy**.
3. **Edit code**: borrá el contenido, pegá el archivo `worker.js` de esta carpeta y tocá **Deploy**.

## 3. Configurar la clave
En el Worker: **Settings → Variables and Secrets → Add**:
- `AISSTREAM_KEY` (tipo **Secret**): la clave de AISStream.
- `ALLOWED_ORIGINS` (tipo Text, opcional): `https://fetchegaray.github.io` (es el valor por defecto).
  Si también querés usar la app como archivo local, agregá `,null` al final.

Guardá y volvé a desplegar.

## 4. Probar el relevo
Abrí en el navegador `https://ais-relay.TU-USUARIO.workers.dev/test`. En unos 15 segundos te dice si la clave está cargada, si AISStream acepta la conexión y cuántos reportes recibió (de todo el mundo). Si dice «Reportes recibidos: 0» o muestra un error, el problema está entre el relevo y AISStream, no en la app.

## 5. Conectar la app
La dirección del Worker es algo como `https://ais-relay.TU-USUARIO.workers.dev`.
En la app, abrí **AIS · buques en tiempo real**, pegá esa dirección cambiando `https://` por `wss://` y tocá **Conectar**.
