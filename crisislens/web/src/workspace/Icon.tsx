const paths:Record<string,string>={
  plus:'M12 5v14M5 12h14',search:'m21 21-4.5-4.5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15',
  arrow:'M12 19V5m-6 6 6-6 6 6',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z',
  doc:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 12h8M8 16h6',
  menu:'M4 6h16M4 12h16M4 18h16',panel:'M4 3h16v18H4V3Zm10 0v18',close:'m6 6 12 12M6 18 18 6',
  check:'m5 12 4 4L19 6',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  stop:'M6 6h12v12H6V6Z',download:'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',copy:'M9 9h12v12H9V9ZM5 15H3V3h12v2',
  spark:'m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z',
};
export function Icon({name,size=18}:{name:string;size?:number}) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.doc}/></svg>; }
