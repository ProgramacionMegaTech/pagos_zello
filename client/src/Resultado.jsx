import { useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const MAX_INTENTOS = 20; // ~1 min esperando el webhook

const texto = {
  APROBADA: ['Pago aprobado', 'ok'],
  PENDING: ['Pago en proceso', 'wait'],
};

export default function Resultado() {
  const ref = new URLSearchParams(window.location.search).get('ref');
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ref) return setError('Falta la referencia del pago.');
    let intentos = 0;
    let timer;
    const cargar = async () => {
      try {
        const r = await fetch(`${API}/api/payments/ref/${encodeURIComponent(ref)}`);
        if (!r.ok) throw new Error('No se encontró el pago.');
        const data = await r.json();
        setPayment(data);
        // El webhook puede tardar: seguir consultando mientras esté pendiente
        if (data.status === 'PENDING' && ++intentos < MAX_INTENTOS) timer = setTimeout(cargar, 3000);
      } catch (err) {
        setError(err.message);
      }
    };
    cargar();
    return () => clearTimeout(timer);
  }, [ref]);

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
          {payment.status === 'PENDING' && <p>Estamos esperando la confirmación de tu pago…</p>}
        </section>
      )}
      <p><a href="/">Volver al inicio</a></p>
    </main>
  );
}
