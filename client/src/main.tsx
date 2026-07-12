import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DialogHost from './dialog';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <DialogHost />
  </React.StrictMode>
);
