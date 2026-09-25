import { useCallback, useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const INTERVALO_MS = 3000;

// BeMovil informa estados en español (p. ej. PENDIENTE); todo lo pendiente/en proceso no es definitivo
const esPendiente = (status) => /PEND|PROCES/.test(status);

const texto = {
  APROBADA: ['Pago aprobado', 'ok'],
  PENDING: ['Pago en proceso', 'wait'],
  PENDIENTE: ['Pago pendiente', 'wait'],
  RECHAZADA: ['Pago rechazado', 'fail'],
  EXPIRADO: ['El link de pago expiró', 'fail'],
};

export default function Resultado() {
  const ref = new URLSearchParams(window.location.search).get('ref');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(ref ? '' : 'Falta la referencia del pago.');
  const [checking, setChecking] = useState(false);
  const [confirmado, setConfirmado] = useState(false); // Nequi: el usuario ya confirmó, se consulta sin parar
  const [recibidoEn, setRecibidoEn] = useState(0); // cuándo llegó la última respuesta (para el reloj local)
  const [ahora, setAhora] = useState(() => Date.now());
  const noEncontrado = useRef(false);
  const timer = useRef();
  const activo = useRef(true);

  // Consulta el estado de la transacción en BeMovil
  const consultar = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API}/api/payments/ref/${encodeURIComponent(ref)}/check`, { method: 'POST' });
      noEncontrado.current = r.status === 404;
      if (!r.ok) throw new Error(r.status === 404 ? 'No se encontró el pago.' : 'No se pudo consultar el estado.');
      const data = await r.json();
      setError('');
      setPayment(data);
      setRecibidoEn(Date.now());
      return data;
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, [ref]);

  // Consulta cada 3 s hasta que el estado deje de ser pendiente (el link vence a los 15 min, y entonces
  // pasa a EXPIRADO). Un fallo de red se reintenta. En la carga inicial, Nequi Push
  // (requiresManualCheck) espera a que el usuario confirme con "Ya realicé el pago".
  const ciclo = useCallback(async (confirmado = false) => {
    clearTimeout(timer.current);
    const data = await consultar();
    if (!activo.current || noEncontrado.current) return;
    if (data) {
      if (!esPendiente(data.status)) return;
      if (data.requiresManualCheck && !confirmado) return;
    }
    timer.current = setTimeout(() => ciclo(confirmado), INTERVALO_MS);
  }, [consultar]);

  useEffect(() => {
    if (!ref) return;
    activo.current = true;
    ciclo();
    return () => {
      activo.current = false;
      clearTimeout(timer.current);
    };
  }, [ref, ciclo]);

  // Intentos y tiempo los lleva el servidor; el reloj avanza localmente hasta recibir el estado definitivo
  const corriendo = payment && !payment.resolved;
  useEffect(() => {
    if (!corriendo) return;
    const id = setInterval(() => setAhora(Date.now()), 100);
    return () => clearInterval(id);
  }, [corriendo]);

  const segundos = payment
    ? (Math.max(0, payment.elapsed_ms + (corriendo ? ahora - recibidoEn : 0)) / 1000).toFixed(1)
    : 0;

  const [titulo, clase] = payment ? texto[payment.status] ?? [`Estado: ${payment.status}`, 'info'] : [];

  return (
    <main className="app">
      <h1>Resultado del pago</h1>
      {error && <p className="error">{error}</p>}
      {!payment && !error && <p>Consultando…</p>}
      {payment && (
        <section className={`resultado ${clase}`}>
          <h2>{titulo}</h2>
          <p>{payment.name}{payment.description ? ` – ${payment.description}` : ''}</p>
          <p>{Number(payment.price).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })}</p>
          {payment.requiresManualCheck && (
            <>
              {confirmado ? (
                <p>Consultando el estado hasta recibir la respuesta…</p>
              ) : (
                <>
                  <p>Aprueba el pago en tu celular (Nequi) y, cuando lo hayas hecho, confirma aquí.</p>
                  <button onClick={() => { setConfirmado(true); ciclo(true); }} disabled={checking}>
                    Ya realicé el pago
                  </button>
                </>
              )}
            </>
          )}
          {esPendiente(payment.status) && !payment.requiresManualCheck && <p>Estamos esperando la confirmación de tu pago…</p>}
        </section>
      )}
      {payment && (
        <p className="metricas">
          Intentos: <strong>{payment.attempts}</strong> · Tiempo transcurrido: <strong>{segundos} s</strong>
          {payment.resolved ? ' (estado recibido)' : ''}
        </p>
      )}
      <p><a href="/">Volver al inicio</a></p>
    </main>
  );
}
