# Casino Moroso

Casino cooperativo para jugar con amigos: compartís un banco y cada día tenéis 5 minutos para llegar al objetivo del Tiburón.

## Publicarlo gratis en Render

1. **GitHub.** Entra en github.com (crea una cuenta si no tienes) → botón **New** → nombre `casino-moroso` → **Create repository**. En la página del repositorio vacío pulsa **uploading an existing file** y arrastra **todo el contenido** de esta carpeta, incluida la carpeta `public`. Pulsa **Commit changes**.
2. **Render.** Entra en render.com → **Get Started** → regístrate con tu cuenta de GitHub.
3. Pulsa **New +** → **Blueprint** → elige el repositorio `casino-moroso` → **Apply**. Render lee `render.yaml` y crea el servicio gratis.
   - Si no ves Blueprint: **New +** → **Web Service** → elige el repositorio → Build command `npm install`, Start command `node server.js`, Instance type **Free** → **Create Web Service**.
4. Espera 2 o 3 minutos hasta que ponga **Live**. Tu enlace será algo como `https://casino-moroso-xxxx.onrender.com`.

## Jugar con amigos

1. Abre tu enlace, elige apodo y pulsa **Crear sala nueva**.
2. Pulsa el código de la sala (arriba a la derecha): se copia un enlace de invitación tipo `…onrender.com/?sala=ABCD`.
3. Pásaselo a tus amigos. Al abrirlo eligen apodo y pulsan **Unirse**. No necesitan cuenta.

## A tener en cuenta

- El plan gratis de Render **se duerme tras 15 minutos sin visitas**. La primera vez que lo abras después tardará hasta un minuto en cargar.
- Al dormirse o reiniciarse, **las salas se borran**. Una partida completa dura alrededor de una hora, así que jugadla de una sentada.
- Para cambiar algo del juego, sustituye `public/index.html` en GitHub y Render lo vuelve a publicar solo.

## Probarlo en tu ordenador (opcional)

Con Node.js 18 o superior:

```
npm install
npm start
```

Y abre http://localhost:3000
