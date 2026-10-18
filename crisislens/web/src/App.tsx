import { lazy, Suspense } from 'react';
import { Workspace } from './workspace/Workspace';
const Legacy = lazy(()=>import('./LegacyApp').then(m=>({default:m.LegacyApp})));
export function App() {
  return new URLSearchParams(location.search).has('demo')?<Suspense fallback={<p>正在加载演示…</p>}><Legacy/></Suspense>:<Workspace/>;
}
