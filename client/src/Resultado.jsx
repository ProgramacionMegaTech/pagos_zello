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
  const intentos = useRef(0);
  const timer = useRef();

  // Consulta el estado de la transacción en BeMovil
  const consultar = useCallback(async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API}/api/payments/ref/${encodeURIComponent(ref)}/check`, { method: 'POST' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No se encontró el pago.' : 'No se pudo consultar el estado.');
      const data = await r.json();
      setError('');
      setPayment(data);
      return data;
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }, [ref]);

  useEffect(() => {
    if (!ref) return;
    let activo = true;
    // Al cargar: consulta y, si sigue pendiente, reintenta solo (Nequi Push espera confirmación manual)
    const ciclo = async () => {
      const data = await consultar();
      if (!activo || !data || data.requiresManualCheck) return;
      if (data.status === 'PENDING' && ++intentos.current < MAX_INTENTOS) timer.current = setTimeout(ciclo, 3000);
    };
    ciclo();
    return () => {
      activo = false;
      clearTimeout(timer.current);
    };
  }, [ref, consultar]);

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
              <p>Aprueba el pago en tu celular (Nequi) y, cuando lo hayas hecho, confirma aquí.</p>
              <button onClick={consultar} disabled={checking}>
                {checking ? 'Consultando…' : 'Ya realicé el pago'}
              </button>
            </>
          )}
          {payment.status === 'PENDING' && !payment.requiresManualCheck && <p>Estamos esperando la confirmación de tu pago…</p>}
        </section>
      )}
      <p><a href="/">Volver al inicio</a></p>
    </main>
  );
}
