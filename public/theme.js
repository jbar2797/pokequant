// theme.js (v0.7.2)
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
let dark = localStorage.getItem('pq_dark') ? localStorage.getItem('pq_dark')==='1' : prefersDark;
function apply(){
  if(dark){ document.documentElement.classList.add('dark'); document.body.classList.remove('light'); }
  else { document.documentElement.classList.remove('dark'); document.body.classList.add('light'); }
  const btn = document.getElementById('themeToggle'); if(btn) btn.textContent = dark?'🌙':'☀️';
}
export function toggleTheme(){ dark=!dark; localStorage.setItem('pq_dark', dark?'1':'0'); apply(); }
export function initTheme(){ apply(); document.getElementById('themeToggle')?.addEventListener('click', toggleTheme); }
initTheme();
