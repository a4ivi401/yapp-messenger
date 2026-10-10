import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Паролі не збігаються');
    try {
      await register(username, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h1>Yapp</h1>
      <p className="muted">Створи акаунт і знайди когось цікавого.</p>
      <input
        placeholder="Імʼя користувача (3–20, латиниця/_/цифри)"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
        autoComplete="username"
      />
      <input
        type="password"
        placeholder="Пароль (від 6 символів)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
      />
      <input
        type="password"
        placeholder="Повтори пароль"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">Створити акаунт</button>
      <p className="muted">
        Вже є акаунт? <Link to="/login">Увійти</Link>
      </p>
    </form>
  );
}