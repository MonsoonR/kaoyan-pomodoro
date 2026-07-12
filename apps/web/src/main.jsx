import * as React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

globalThis.React = React;
const { default: App } = await import('./App.jsx');

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
