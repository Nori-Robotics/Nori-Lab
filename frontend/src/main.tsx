import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { initLocalAuth } from './lib/localAuth'

// Pick up ?token= (local API auth) and scrub it from the URL before anything
// renders or fetches — see lib/localAuth.ts.
initLocalAuth();

createRoot(document.getElementById("root")!).render(<App />);
