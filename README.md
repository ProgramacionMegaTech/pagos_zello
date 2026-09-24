# BeMobil – Links de pago

Genera links de pago con BeMovil y verifica su estado mediante el webhook `confirmUrl`.

- `client/` – React + Vite (JavaScript). Formulario name / label / description / price y botón **Realizar pago**.
- `server/` – Express + PostgreSQL (ambos en Docker con `docker-compose.yml`).
- `logs/webhook.log` – una línea JSON por cada webhook recibido (auditoría).

## Requisitos

- Node.js 20+ y npm
- Docker y Docker Compose

## Configuración (común)

```bash
cp .env.example .env
```

| Variable | Descripción |
|---|---|
| `BEMOVIL_TOKEN` | Bearer token de la API de BeMovil |
| `BEMOVIL_SECRET_KEY` | secretKey para validar `Authorization` y `X-Signature` del webhook |
| `PUBLIC_URL` | URL pública del backend, sin `/` final (ej. `https://api.midominio.com`). Se envía como `confirmUrl` = `PUBLIC_URL/api/webhooks/bemovil` |
| `CLIENT_URL` | Origen del cliente (CORS y `redirectUrl`) |

> Sin `PUBLIC_URL` los links se generan igual, pero BeMovil no podrá notificar y el estado quedará en `PENDING`.

## Desarrollo

1. Levantar backend y base de datos:
   ```bash
   docker compose up -d --build
   ```
   API en http://localhost:4000. Tras cambiar `.env` o el código del servidor, repetir el comando.
2. Levantar el cliente:
   ```bash
   cd client
   npm install
   npm run dev
   ```
   Abrir http://localhost:5173. El cliente usa `http://localhost:4000` por defecto (o `VITE_API_URL`).
3. Para recibir el webhook en local, exponer el backend con un túnel HTTPS y ponerlo en `PUBLIC_URL`:
   ```bash
   ngrok http 4000
   # PUBLIC_URL=https://xxxx.ngrok-free.app  → docker compose up -d --build
   ```

Ver los webhooks en vivo: `tail -f logs/webhook.log`.
Ver logs del servidor: `docker compose logs -f server`.

## Producción (pagos.zello.com.co)

Arquitectura: nginx (ya instalado en el servidor) sirve el cliente estático en `https://pagos.zello.com.co` y enruta `/api/` al backend, que corre en Docker y solo escucha en `127.0.0.1:4000`. Postgres no se expone fuera de Docker.

### Primer despliegue

Requisitos en el servidor: Docker + Compose, Node.js 20+, git, nginx y certbot.

1. **DNS:** registro `A` de `pagos.zello.com.co` apuntando a la IP del servidor.
2. **Código:** clonar el repositorio en el servidor (por ejemplo en `/root/pagos_zello`):
   ```bash
   sudo git clone <URL_DEL_REPO> /root/pagos_zello
   sudo chown -R $USER /root/pagos_zello
   cd /root/pagos_zello
   ```
3. **Variables de entorno:**
   ```bash
   cp .env.example .env
   nano .env
   ```
   ```
   BEMOVIL_TOKEN=<token de producción>
   BEMOVIL_SECRET_KEY=<secretKey del webhook>
   PUBLIC_URL=https://pagos.zello.com.co
   CLIENT_URL=https://pagos.zello.com.co
   ```
4. **Contraseña de Postgres:** cambiar `POSTGRES_PASSWORD` y la misma clave en `DATABASE_URL` en `docker-compose.yml` antes del primer arranque (después de crear el volumen, cambiarla requiere `ALTER USER` dentro de Postgres).
5. **Backend + base de datos y cliente:**
   ```bash
   ./deploy.sh
   ```
   (Falla en el `git pull` si el clon no tiene remoto; en ese caso comenta esa línea.)
6. **nginx:**
   ```bash
   sudo cp deploy/nginx.conf /etc/nginx/conf.d/pagos.zello.com.co.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
   Si tu nginx usa `sites-available`, copia el archivo allí y enlázalo en `sites-enabled`.
7. **HTTPS (Let's Encrypt):**
   ```bash
   sudo certbot --nginx -d pagos.zello.com.co
   ```
   Certbot edita la configuración para añadir el bloque 443 y la redirección. BeMovil necesita HTTPS público para el webhook.
8. **Verificar:**
   ```bash
   curl -i https://pagos.zello.com.co/api/payments/1   # 404 JSON = el API responde
   docker compose ps
   ```
   Abre https://pagos.zello.com.co, genera un pago de prueba y revisa `tail -f logs/webhook.log`.

El webhook queda en `https://pagos.zello.com.co/api/webhooks/bemovil` (se envía solo como `confirmUrl` gracias a `PUBLIC_URL`).

### Subir cambios (flujo habitual)

1. En local: desarrollar y probar, luego `git commit` y `git push`.
2. En el servidor:
   ```bash
   cd /root/pagos_zello
   ./deploy.sh
   ```
   El script hace `git pull`, reconstruye y reinicia backend y base de datos (`docker compose up -d --build`), compila el cliente y lo publica en `/var/www/pagos/dist`.

Casos particulares:
- **Solo cambió el cliente:** `cd client && npm ci --include=dev && npm run build && sudo rsync -a --delete dist/ /var/www/pagos/dist/`
- **Solo cambió el backend o `.env`:** `docker compose up -d --build`
- **Cambió `deploy/nginx.conf`:** copiarlo de nuevo a `/etc/nginx/conf.d/`, ejecutar `sudo nginx -t && sudo systemctl reload nginx` y revisar que certbot no haya añadido bloques que se pierdan al sobrescribir (mejor editar el archivo instalado a mano).
- **Ver logs:** `docker compose logs -f server` y `tail -f logs/webhook.log`.
- **Volver atrás:** `git checkout <commit_anterior>` y `./deploy.sh` (comentando el `git pull`).

Los datos de Postgres persisten en el volumen `pgdata` (un `deploy.sh` no los borra) y los logs del webhook en `./logs`. Nunca uses `docker compose down -v`: elimina la base de datos.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/payments` | Crea el link en BeMovil y lo guarda. Body: `name`, `label`, `description`, `price`. Devuelve `checkout_url` (`https://plataforma.bepay.com.co/checkout/{resourceKey}`) |
| GET | `/api/payments/:id` | Estado del pago (actualizado por el webhook) |
| POST | `/api/payments/ref/:ref/check` | Consulta en BeMovil (`/api/v1/transactions/find` con `_id` = ref) el estado de la transacción y lo guarda. La usa la página `/resultado` |
| POST | `/api/webhooks/bemovil` | Webhook de BeMovil. Valida `Authorization: Bearer {secretKey}` y `X-Signature` = HMAC-SHA256(`{id}.{reference}.{Amount.amount}`). Responde `{"ok":true}` |

## Notas

- El webhook es idempotente: una notificación repetida solo vuelve a escribir el mismo estado.
- El webhook se asocia al pago solo por `_id`: al crear el link se envía `_id` (y `meta.ref`) con un UUID propio y BeMovil lo devuelve en cada notificación. Sin `_id` la notificación no se asocia (`matchedPayment: false` en `logs/webhook.log`).
- Un pago `PENDING` cuyo link venció (15 min) se muestra como `EXPIRADO`, y una transacción `APROBADA` no se sobrescribe con notificaciones de otros intentos.
- No subas `.env` a git (ya está en `.gitignore`).
