// toast.js (v0.7.2) simple toast + status
export function toast(msg, kind='info', ttl=3200){
  const host = document.getElementById('toastHost'); if(!host) return;
  const div = document.createElement('div');
  div.style.cssText='font:12px/1.3 system-ui,sans-serif;background:#162132;border:1px solid #253349;color:#e5ecf5;padding:6px 10px;border-radius:8px;box-shadow:0 4px 16px -4px rgba(0,0,0,.55);opacity:0;transform:translateY(-4px);transition:.3s;max-width:240px';
  if(kind==='error') div.style.background='#7f1d1d', div.style.borderColor='#dc2626', div.style.color='#fee2e2';
  else if(kind==='success') div.style.background='#064e3b', div.style.borderColor='#059669', div.style.color='#d1fae5';
  else if(kind==='warn') div.style.background='#78350f', div.style.borderColor='#d97706', div.style.color='#fde68a';
  div.textContent = msg;
  host.appendChild(div);
  requestAnimationFrame(()=> { div.style.opacity='1'; div.style.transform='translateY(0)'; });
  setTimeout(()=> { div.style.opacity='0'; div.style.transform='translateY(-4px)'; setTimeout(()=> div.remove(), 350); }, ttl);
}

let statusTimer=null;
export function setStatus(msg, kind='info', ttl=3500){
  const el = document.getElementById('statusBanner'); if(!el) return;
  if(!msg){ el.style.display='none'; return; }
  el.textContent = msg;
  el.style.display='block';
  if(kind==='error') el.style.background='#7f1d1d', el.style.borderColor='#dc2626', el.style.color='#fee2e2';
  else if(kind==='success') el.style.background='#064e3b', el.style.borderColor='#059669', el.style.color='#d1fae5';
  else if(kind==='warn') el.style.background='#78350f', el.style.borderColor='#d97706', el.style.color='#fde68a';
  else el.style.background='#162132', el.style.borderColor='#253349', el.style.color='#e5ecf5';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(()=> { el.style.display='none'; }, ttl);
}

// convenience wrapper for fetch error surfaces
export function safeAsync(fn){ return async (...args)=> { try { return await fn(...args); } catch(e){ toast((e&&e.message)||'Error','error'); throw e; } }; }
