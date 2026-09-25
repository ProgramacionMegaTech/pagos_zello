import { useState } from 'react';
import './App.css';
import Resultado from './Resultado.jsx';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const empty = { name: '', label: '', description: '', price: '' };

export default function App() {
  if (window.location.pathname === '/resultado') return <Resultado />;
  return <Home />;
}

function Home() {
  const [form, setForm] = useState(empty);
  const [payments, setPayments] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [querying, setQuerying] = useState(false);

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
      console.log('Respuesta de BeMovil:', data.bemovil);
      setForm(empty);
      if (tab) tab.location.href = data.checkout_url;
      else window.location.href = data.checkout_url;
    } catch (err) {
      tab?.close();
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function consultar() {
    setQuerying(true);
    setError('');
    try {
      const r = await fetch(`${API}/api/payments`);
      if (!r.ok) throw new Error('No se pudo consultar');
      setPayments(await r.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setQuerying(false);
    }
  }

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

      <section className="result">
        <button onClick={consultar} disabled={querying}>
          {querying ? 'Consultando…' : 'Consultar últimas transacciones'}
        </button>
        {payments && (payments.length === 0 ? (
          <p>No hay transacciones.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Nombre</th><th>Descripción</th><th>Valor</th><th>Estado</th><th>Intentos</th><th>Tiempo</th></tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.description}</td>
                  <td>{Number(p.price).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })}</td>
                  <td>{p.status}</td>
                  <td>{p.attempts || '-'}</td>
                  <td>{p.resolved ? `${(Number(p.elapsed_ms) / 1000).toFixed(1)} s` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>
    </main>
  );
}
