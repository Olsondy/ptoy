import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { InvitePrototype } from './InvitePrototype';
import '../../styles.css';
import './prototype.css';

createRoot(document.getElementById('root')!).render(<StrictMode><InvitePrototype /></StrictMode>);
