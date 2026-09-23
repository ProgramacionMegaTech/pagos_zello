import { useEffect, useRef, useState } from 'react';
import './App.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const empty = { name: '', label: '', description: '', price: '' };

export default function App() {
  const [form, setForm] = useState(empty);
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const timer = useRef();

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    // Se abre la pestaña en el click (antes del await) para que el navegador no la bloquee
    const tab = window.open('', '_blank');
    try {
      const r = await fetch(`${API}/api/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, price: Number(form.price) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error');
      setPayment(data);
      if (tab) tab.location.href = data.checkout_url;
      else window.location.href = data.checkout_url;
    } catch (err) {
      tab?.close();
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Consulta el estado cada 5s mientras esté pendiente
  useEffect(() => {
    if (!payment || payment.status !== 'PENDING') return;
    timer.current = setInterval(async () => {
      const r = await fetch(`${API}/api/payments/${payment.id}`);
      if (r.ok) setPayment(await r.json());
    }, 5000);
    return () => clearInterval(timer.current);
  }, [payment]);

  return (
    <main className="app">
      <h1>Generar link de pago</h1>
      <form onSubmit={submit}>
        <input placeholder="Name" value={form.name} onChange={set('name')} required />
        <input placeholder="Label" value={form.label} onChange={set('label')} required />
        <textarea placeholder="Description" value={form.description} onChange={set('description')} />
        <input type="number" min="1" placeholder="Price" value={form.price} onChange={set('price')} required />
        <button disabled={loading}>{loading ? 'Generando…' : 'Generar link'}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {payment && (
        <section className="result">
          <p>Estado: <strong>{payment.status}</strong></p>
          <button onClick={() => window.open(payment.checkout_url, '_blank', 'noopener')}>
            Realizar pago
          </button>
        </section>
      )}
    </main>
  );
}
