import { useCallback, useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const MAX_INTENTOS = 20; // ~1 min de consulta automática

const texto = {
  APROBADA: ['Pago aprobado', 'ok'],
  PENDING: ['Pago en proceso', 'wait'],
  RECHAZADA: ['Pago rechazado', 'fail'],
  EXPIRADO: ['El link de pago expiró', 'fail'],
};

export default function Resultado() {
  const ref = new URLSearchParams(window.location.search).get('ref');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(ref ? '' : 'Falta la referencia del pago.');
  const [checking, setChecking] = useState(false);
  const [recibidoEn, setRecibidoEn] = useState(0); // cuándo llegó la última respuesta (para el reloj local)
  const [ahora, setAhora] = useState(() => Date.now());
  const intentos = useRef(0);
  const timer = useRef();
  const activo = useRef(true);

  // Consulta el estado de la transacción en BeMovil
  const consultar = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API}/api/payments/ref/${encodeURIComponent(ref)}/check`, { method: 'POST' });
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

  // Consulta y reintenta cada 3 s (~1 min) mientras siga pendiente.
  // En la carga inicial, Nequi Push (requiresManualCheck) espera a que el usuario confirme;
  // con "Ya realicé el pago" (confirmado = true) sí se reintenta solo.
  const ciclo = useCallback(async (confirmado = false) => {
    clearTimeout(timer.current);
    if (confirmado) intentos.current = 0;
    const data = await consultar();
    if (!data || !activo.current) return;
    if (data.requiresManualCheck && !confirmado) return;
    if (data.status === 'PENDING' && ++intentos.current < MAX_INTENTOS) {
      timer.current = setTimeout(() => ciclo(confirmado), 3000);
    }
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
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [corriendo]);

  const segundos = payment
    ? Math.max(0, Math.round((payment.elapsed_ms + (corriendo ? ahora - recibidoEn : 0)) / 1000))
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
              <p>Aprueba el pago en tu celular (Nequi) y, cuando lo hayas hecho, confirma aquí. Consultaremos el estado cada pocos segundos.</p>
              <button onClick={() => ciclo(true)} disabled={checking}>
                {checking ? 'Consultando…' : 'Ya realicé el pago'}
              </button>
            </>
          )}
          {payment.status === 'PENDING' && !payment.requiresManualCheck && <p>Estamos esperando la confirmación de tu pago…</p>}
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
