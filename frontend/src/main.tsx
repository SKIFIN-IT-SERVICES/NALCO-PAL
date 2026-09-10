import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its dev-only double-invoke of effects (mount, cleanup,
// mount again) was joining, then immediately leaving mid-connection, then
// rejoining the Daily call within milliseconds — producing exactly the
// "stuck connecting" / leave-loop behavior seen in local testing. Doesn't
// affect production builds, which never double-invoke effects anyway.
createRoot(document.getElementById('root')!).render(<App />)
