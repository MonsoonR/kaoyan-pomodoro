import * as React from 'react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './task8.css';
import './design-system.css';
import './editorial.css';
import './one-thing.css';
import { PwaUpdatePrompt } from './pwa/PwaUpdatePrompt';

globalThis.React = React;
const { default: App } = await import('./App.jsx');

createRoot(document.getElementById('root')).render(<StrictMode><App /><PwaUpdatePrompt /></StrictMode>);
