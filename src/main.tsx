import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { Loading, Toasts } from './components/ui';
import { applyPrefs } from './lib/game';
import Home from './pages/Home';
import Join from './pages/Join';

const Play = lazy(() => import('./pages/Play'));
const Host = lazy(() => import('./pages/Host'));
const Screen = lazy(() => import('./pages/Screen'));

applyPrefs();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Toasts />
      <Suspense fallback={<Loading text="Loading…" />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/join" element={<Join />} />
          <Route path="/play" element={<Play />} />
          <Route path="/host" element={<Host />} />
          <Route path="/screen/:token" element={<Screen />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>,
);
