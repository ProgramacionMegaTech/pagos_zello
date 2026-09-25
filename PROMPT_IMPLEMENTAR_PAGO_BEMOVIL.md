
## 0. Rol y objetivo

Implementa el flujo de pago con **BeMovil** (pasarela colombiana, checkout alojado en `plataforma.bepay.com.co`) para que el botón "Pagar" ya existente:

1. Pida al backend crear un **link de pago** en BeMovil.
2. Abra el checkout de BeMovil en la misma pestaña.
3. Al terminar, BeMovil redirige al usuario a una **página de resultado** en nuestra app, que consulta el estado real de la transacción.
4. Además, BeMovil notifica a un **webhook** en nuestro backend (fuente de verdad secundaria, firmada).

**No** construyas ningún formulario de captura de campos (name/label/description/price). Los datos del pago (nombre del producto, descripción, monto) vienen de lo que la app ya conoce en el momento de pagar (carrito, plan, pedido, etc.). Conecta esos valores al botón existente.

### Antes de escribir código

Ubica en la app existente: el botón "Pagar", de dónde salen monto y descripción, y el router del cliente para añadir `/resultado`. Si algo es ambiguo, pregunta antes de asumir.

---

## 1. Visión general del flujo

```
[Botón Pagar] ──POST /api/payments──▶ [Backend] ──POST links/create──▶ [BeMovil]
      │                                   │  guarda pago (ref, estado PENDING)      │
      │◀──── checkout_url ────────────────┘◀──── resourceKey ───────────────────────┘
      │
      ├─ abre checkout_url en otra pestaña (usuario paga en BeMovil)
      │
      │        BeMovil ──POST webhook (firmado)──▶ [Backend] actualiza estado por _id
      │
      └─ BeMovil redirige a  {CLIENT_URL}/resultado?ref={ref}
             │
             └─ [Página Resultado] ──POST /api/payments/ref/:ref/check──▶ [Backend]
                                                     │ ──POST transactions/find (_id=ref)──▶ [BeMovil]
                                                     └─ guarda estado y lo devuelve
                    (reintenta cada 3 s mientras esté PENDING; caso especial Nequi Push)
```

Idea clave: **`ref`** es un UUID que generamos nosotros al crear el link. Se envía a BeMovil como `_id` (y `meta.ref`) y también dentro del `redirectUrl`. BeMovil lo devuelve tal cual en el webhook (`data._id`) y permite consultar la transacción con `find({_id: ref})`. Así identificamos el pago sin depender de nada más.

---

## 2. Variables de entorno (backend)

| Variable | Descripción |
|---|---|
| `BEMOVIL_BASE_URL` | Por defecto `https://apiv2.bemovil.net` |
| `BEMOVIL_TOKEN` | Bearer token de la API de BeMovil (secreto) |
| `BEMOVIL_SECRET_KEY` | secretKey para validar el webhook (secreto) |
| `CHECKOUT_HOST` | Por defecto `https://plataforma.bepay.com.co/checkout` |
| `PUBLIC_URL` | URL pública **HTTPS** del backend, sin `/` final. Se usa como `confirmUrl` = `PUBLIC_URL/api/webhooks/bemovil`. Sin ella el link se genera pero BeMovil no puede notificar |
| `CLIENT_URL` | Origen público del cliente (CORS y `redirectUrl`) |

**URL pública de la app en producción: `https://www.zello.com.co`.** En producción configura:

```
PUBLIC_URL=https://www.zello.com.co
CLIENT_URL=https://www.zello.com.co
```

De ahí salen: `confirmUrl` = `https://www.zello.com.co/api/webhooks/bemovil` y `redirectUrl` = `https://www.zello.com.co/resultado?ref={ref}`. Esto asume que el backend responde bajo ese mismo dominio con el prefijo `/api`; si en esta app la API vive en otra ruta o subdominio, ajusta `PUBLIC_URL` y la ruta del webhook para que apunten al backend real (y `confirmUrl` siga siendo público por HTTPS).

Nunca subas estos valores a git; añade las claves vacías al archivo de ejemplo de variables que use la app. Para recibir el webhook en local hace falta una URL pública HTTPS hacia el backend (túnel) en `PUBLIC_URL`.

---

## 3. Contrato con BeMovil (API externa)

Todas las llamadas: `Content-Type: application/json`, `Authorization: Bearer ${BEMOVIL_TOKEN}`, y el cuerpo va envuelto en `{ "data": { ... } }`.

### 3.1 Crear link de pago

`POST {BEMOVIL_BASE_URL}/api/v1/transactions/checkout/links/create`

```jsonc
{
  "data": {
    "isDefault": false,
    "isUniquePayment": true,          // el link solo se paga una vez
    "name": "<nombre del producto/servicio>",
    "label": "<etiqueta corta>",
    "image": "",
    "description": "<descripción o cadena vacía>",
    "price": 50000,                   // number, en COP, > 0
    "expiresAt": "<ISO-8601, ahora + 15 min>",
    "redirectUrl": "{CLIENT_URL}/resultado?ref={ref}",
    "confirmUrl": "{PUBLIC_URL}/api/webhooks/bemovil",   // '' si no hay PUBLIC_URL
    "_id": "{ref}",                   // UUID propio; BeMovil lo devuelve en el webhook y en find
    "meta": { "ref": "{ref}" },
    "additionalData": []
  }
}
```

Respuesta relevante: `body.data.Resource` con `resourceKey`, `id` y `expiresAt`. Si `!response.ok` o no hay `resourceKey`, responde 502 al cliente con el mensaje de BeMovil.

URL del checkout que se abre al usuario: `${CHECKOUT_HOST}/${resourceKey}`.

### 3.2 Consultar transacción

`POST {BEMOVIL_BASE_URL}/api/v1/transactions/find` con `{ "data": { "_id": "<ref>" } }`

Respuesta relevante: `body.data.Transaction` con:
- `id` (id de la transacción)
- `TransactionStatus.name` → estado (ver §5)
- `paymentMethodId` o `PaymentMethod.id` → método de pago (`11` = **Nequi Push**)

Si no hay `Transaction` y `body.errorCode === 'transaction.notFound'`, **es normal**: el usuario aún no ha usado el link. Cualquier otro caso sin transacción es error real (502).

### 3.3 Webhook entrante (`confirmUrl`)

BeMovil hace `POST` a nuestro endpoint con headers `Authorization: Bearer {secretKey}` y `X-Signature`. Cuerpo: `{ "data": { "id", "reference", "_id", "Amount": { "amount" }, "TransactionStatus": { "name" }, ... } }`.

**Validación (ambas obligatorias):**
1. `Authorization === "Bearer " + BEMOVIL_SECRET_KEY`.
2. `X-Signature === HMAC-SHA256(key = BEMOVIL_SECRET_KEY, msg = "{data.id}.{data.reference ?? ''}.{data.Amount.amount}")` en hex, comparado en tiempo constante (comprobando longitudes antes). BeMovil firma con la referencia **vacía** si no viene.

Si es inválido → `401 {ok:false}`. Si es válido pero no hay pago asociado a `data._id` → `404 {ok:false}`. Si todo bien → `200 {ok:true}`.

El HMAC se calcula con campos del JSON ya parseado (no con el body crudo); guardar el body crudo solo sirve para auditoría.

---

## 4. Backend: qué implementar

### 4.1 Persistencia

Guarda por cada intento de pago (en la entidad "orden/pedido" existente o en una nueva si no hay una adecuada):

| Campo | Notas |
|---|---|
| `ref` | TEXT **UNIQUE**, el UUID que generas; clave de asociación |
| `resource_key` | UNIQUE, de BeMovil |
| `bemovil_id` | `Resource.id` |
| `name`, `description`, `price` | lo que se cobró |
| `checkout_url` | `${CHECKOUT_HOST}/${resourceKey}` |
| `status` | TEXT, default `'PENDING'` |
| `transaction_id` | id de la transacción de BeMovil (asignado al recibir estado) |
| `matched_by` | `'find'` o `'ref'` (webhook), para auditoría |
| `expires_at` | de `Resource.expiresAt` (o `expiresAt` enviado) |
| `last_webhook` | JSON del último webhook (opcional, auditoría) |
| `created_at`, `updated_at` | |

Opcional pero recomendado: tabla `webhook_logs (payload, signature_valid, received_at)` y un log en archivo (una línea JSON por webhook: headers **sin** `authorization`, rawBody, payload, `signatureValid`, `matchedPayment`) para depurar.

### 4.2 Endpoints

**`POST /api/payments`** — crea el link.
- Entrada: los datos del pago que la app conoce (`name`, `label`, `description`, `price`, y el identificador de la orden de la app si aplica). **Recalcula/valida el monto en el servidor** desde tu propia fuente (no confíes ciegamente en el precio que envía el cliente si viene de un carrito/plan).
- Valida `price` numérico finito > 0 (400 si no).
- Genera `ref` = un UUID v4 nuevo, arma el payload de §3.1, llama a BeMovil, guarda el registro y responde `201` con al menos `{ checkout_url, ref }`.
- Errores de BeMovil → 502 con `error` y `details`; excepciones → 500.

**`POST /api/payments/ref/:ref/check`** — consulta y sincroniza el estado (la usa la página de resultado).
- Busca el pago por `ref` (404 si no existe).
- Llama a `transactions/find` con `_id = ref`.
  - Con `Transaction`: `status = TransactionStatus.name.toUpperCase()` (`'UNKNOWN'` si falta) y aplica con `applyStatus(..., matchedBy='find')`; guarda `paymentMethodId`.
  - Sin `Transaction` y `errorCode === 'transaction.notFound'`: no hacer nada (sigue PENDING).
  - Otro error o excepción: `502 { error: 'No se pudo consultar el estado' }`.
- Responde con `{ name, description, price, status, updated_at, paymentMethodId, requiresManualCheck }` donde
  `requiresManualCheck = paymentMethodId === 11 && /PEND|PROCES/.test(status)` (Nequi Push: el usuario aprueba en su celular y debe confirmar manualmente en la UI).

**`GET /api/payments/:id`** — estado local (opcional, útil para que otras partes de la app lean el resultado).

**`POST /api/webhooks/bemovil`** — webhook, según §3.3.
- Valida autenticidad **antes** de tocar datos.
- `status = String(d.TransactionStatus?.name ?? 'UNKNOWN').toUpperCase()`.
- Asocia el pago **solo por `d._id`** (= ref). Sin `_id` no se asocia.
- Aplica el estado con `applyStatus` y guarda `last_webhook`.
- Debe ser **idempotente**: BeMovil puede reenviar; repetir la misma notificación solo reescribe el mismo estado.

### 4.3 Reglas de estado (importante, no las omitas)

```
// Una transacción APROBADA no se pisa con otra transacción distinta
// (p. ej. un rechazo tardío de otro intento sobre el mismo link);
// repetir la misma transacción sí es válido.
aplicarEstado(pago, estado, transactionId, matchedBy):
  bloqueado = pago.status == 'APROBADA' AND pago.transaction_id != transactionId
  si NO bloqueado: guardar status, transaction_id, matched_by, updated_at = ahora
  devolver bloqueado
```

**Expiración calculada al leer**: un pago `PENDING` cuyo `expires_at` (o `created_at + 15 min` si es null) ya pasó se expone como `EXPIRADO`. Se calcula al consultar el pago, sin job en segundo plano:

```
estadoVisible = (status == 'PENDING' AND (expires_at ?? created_at + 15 min) < ahora) ? 'EXPIRADO' : status
```

Aplica esta regla en **todo** lugar que devuelva el estado al cliente.

### 4.4 Otros requisitos del backend

- El webhook debe ser accesible públicamente por HTTPS y **sin** la autenticación de sesión de la app (se autentica con el Bearer + firma); exclúyelo de cualquier middleware de auth/CSRF global.
- Permite el origen del cliente (`CLIENT_URL`) si aplica CORS.
- No loguees `BEMOVIL_TOKEN` ni la secretKey.

---

## 5. Estados de transacción

Valores normalizados a mayúsculas (los que la UI conoce hoy):

| Estado | Significado | UI |
|---|---|---|
| `APROBADA` | Pago exitoso | "Pago aprobado" (éxito) |
| `PENDING` | En proceso / sin resolver | "Pago en proceso" (espera) |
| `RECHAZADA` | Rechazado | "Pago rechazado" (error) |
| `EXPIRADO` | Link vencido (calculado localmente) | "El link de pago expiró" (error) |
| otro | Cualquier otro valor de BeMovil | Mostrar `Estado: {status}` (neutral) |

Al confirmar con BeMovil los nombres exactos que devuelve en tu cuenta (p. ej. variantes de "pendiente/en proceso"), ajusta el regex `/PEND|PROCES/` y el mapa de textos. Cuando el estado sea `APROBADA`, **ejecuta aquí la lógica de negocio propia de tu app** (activar el plan, marcar el pedido pagado, enviar correo, etc.) de forma idempotente, tanto desde el webhook como desde `check`, cuidando que no se dispare dos veces.

---

## 6. Cliente: qué implementar

### 6.1 Botón "Pagar" (ya existe; solo conecta la lógica)

Comportamiento a replicar:

```
al hacer click en "Pagar":
  loading = true; error = ''
  // Abrir la pestaña EN EL CLICK, antes de cualquier espera asíncrona, para que el navegador no la bloquee como popup
  pestaña = abrirNuevaPestaña('')
  intentar:
    respuesta = POST {API}/api/payments  (JSON con los datos del pago que ya tiene la app: name, label, description, price, orderId...)
    si respuesta no es OK: lanzar error(respuesta.error || 'Error')
    si pestaña: pestaña.url = respuesta.checkout_url   // redirige la pestaña ya abierta
    si no:      ventanaActual.url = respuesta.checkout_url  // fallback si el popup fue bloqueado
  si falla:
    pestaña?.cerrar()   // no dejar una pestaña en blanco
    error = mensaje
  siempre: loading = false
```

- Deshabilita el botón y muestra estado de carga mientras dura la petición.
- `API` es la base URL del backend según la convención de la app.

### 6.2 Página `/resultado?ref=...`

Ruta nueva en el router de la app (asegúrate de que la ruta se sirva también al entrar directo por URL). BeMovil redirige aquí al terminar el pago.

Lógica (replicar tal cual):

- Lee `ref` del query string de la URL. Si falta → mensaje "Falta la referencia del pago."
- `consultar()`: `POST {API}/api/payments/ref/{encodeURIComponent(ref)}/check`; 404 → "No se encontró el pago."; otro error → "No se pudo consultar el estado."; en éxito guarda el pago y limpia el error.
- `ciclo(confirmado = false)`: 
  - cancela el timer previo; si `confirmado`, reinicia el contador de intentos;
  - llama `consultar()`; si no hay datos o el componente se desmontó, termina;
  - si `data.requiresManualCheck && !confirmado` → **no reintenta** (espera al usuario);
  - si `data.status === 'PENDING'` y `++intentos < MAX_INTENTOS (20)` → reprograma `ciclo(confirmado)` a los 3000 ms (≈ 1 minuto de sondeo automático).
- Al montar la página ejecuta `ciclo()`; al desmontarla marca `activo=false` y cancela el temporizador pendiente (cuidado si el framework monta dos veces en desarrollo).
- UI: título y estilo según §5; muestra nombre, descripción y precio formateado `toLocaleString('es-CO', {style:'currency', currency:'COP', maximumFractionDigits:0})`.
  - Si `requiresManualCheck`: texto "Aprueba el pago en tu celular (Nequi) y, cuando lo hayas hecho, confirma aquí…" + botón **"Ya realicé el pago"** que llama `ciclo(true)` (deshabilitado mientras consulta).
  - Si `PENDING` sin requerir confirmación manual: "Estamos esperando la confirmación de tu pago…".
  - Enlace para volver a la app.
- Tras `APROBADA`, redirige o muestra el siguiente paso propio de la app.

---

## 7. Casos límite que ya se resolvieron (mantenlos)

- **Popup bloqueado:** abrir la pestaña síncronamente en el click; fallback a redirección en la misma ventana.
- **Usuario vuelve sin haber pagado:** `find` responde `transaction.notFound` → sigue `PENDING`, no es error.
- **Nequi Push (`paymentMethodId === 11`):** el estado queda pendiente hasta que el usuario aprueba en el celular; no sondear automáticamente en la carga inicial, solo tras "Ya realicé el pago".
- **Reintentos del usuario sobre el mismo link:** un rechazo posterior no debe pisar una `APROBADA` (regla `applyStatus`).
- **Webhook y `check` compiten:** ambos escriben con el mismo `applyStatus`; el resultado es consistente e idempotente.
- **Link vencido a los 15 min:** se muestra `EXPIRADO` si seguía `PENDING`.
- **Webhook sin `_id` o `_id` desconocido:** 404 y log; nunca crear pagos desde el webhook.

---

## 8. Criterios de aceptación / cómo probar

1. `POST /api/payments` con datos válidos devuelve `201` y un `checkout_url` que abre el checkout de BeMovil; con precio inválido, `400`.
2. Pagar en el checkout redirige a `/resultado?ref=<uuid>` y la página muestra el estado correcto (`APROBADA`, `RECHAZADA`, `PENDING`).
3. Un pago no realizado permanece `PENDING` y pasa a `EXPIRADO` tras 15 min.
4. El webhook con firma o Bearer incorrectos responde `401` y no cambia ningún estado; con firma válida actualiza el pago por `_id` y responde `200`. Probar con un cálculo HMAC manual.
5. Reenviar el mismo webhook no altera nada (idempotencia); un webhook `RECHAZADA` de otra transacción no pisa una `APROBADA`.
6. Nequi Push: la página muestra el botón "Ya realicé el pago" y solo tras pulsarlo sondea cada 3 s.
7. Ningún secreto (`BEMOVIL_TOKEN`, `BEMOVIL_SECRET_KEY`) aparece en el bundle del cliente, en logs ni en git.


## 9. Entregables

- Endpoints, migración/esquema y lógica de estado del backend.
- Conexión del botón "Pagar" existente y nueva ruta/página `/resultado`.
- Variables documentadas en el archivo de ejemplo de entorno y una nota breve de cómo probar.
- Un resumen final con las decisiones que tomaste (entidad de pedido usada, acción al aprobarse).
