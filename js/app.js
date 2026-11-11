'use strict';
/* ============================================================
   KNS TEKNIK — Sales Performance · Frontend (js/app.js)
   Di-host di GitHub Pages; backend = Google Apps Script REST API.
   ------------------------------------------------------------
   • Komunikasi: fetch POST text/plain → tanpa CORS preflight
   • Login: email + kata sandi (atau Google, opsional) → token sesi
   • SPA: semua halaman ada di DOM, navigasi = tampil/sembunyi (0 ms)
   • Buka ulang instan: data terakhir di-cache di perangkat lalu
     diperbarui di latar belakang (stale-while-revalidate)
   • Filter, pencarian, ringkasan, grafik: dihitung LOKAL (instan)
   • Optimistic UI + Outbox localStorage untuk kunjungan & omset
     (tetap tersimpan walau sinyal lapangan putus, dikirim ulang otomatis)
   • Tidak ada ?page= di URL; navigasi murni JavaScript
   ============================================================ */

// ════════════════════════════════════════════════════════════
// BAGIAN 1 — KONSTANTA, STATE & UTILITAS
// ════════════════════════════════════════════════════════════
const R = { MGR: 'Manajer', ADM: 'Admin', SLS: 'Salesman' };

const NAV = {
  dashboard:  { label: 'Dashboard Overview',    icon: 'bi-grid-1x2',        roles: [R.MGR, R.ADM, R.SLS] },
  kunjungan:  { label: 'Check-in Kunjungan',    icon: 'bi-geo-alt',         roles: [R.SLS, R.MGR] },
  omset:      { label: 'Catat Omset Harian',    icon: 'bi-cash-coin',       roles: [R.SLS, R.MGR] },
  riwayat:    { label: 'Riwayat Saya',          icon: 'bi-clock-history',   roles: [R.SLS] },
  kinerja:    { label: 'Ringkasan Kinerja',     icon: 'bi-bar-chart-line',  roles: [R.MGR, R.ADM] },
  piutangJT:  { label: 'Piutang Jatuh Tempo',   icon: 'bi-calendar2-x',     roles: [R.MGR, R.ADM], badge: true },
  toko:       { label: 'Data Toko Mitra',       icon: 'bi-shop',            roles: [R.MGR, R.ADM] },
  piutang:    { label: 'Data Piutang & Faktur', icon: 'bi-receipt',         roles: [R.MGR, R.ADM] },
  salesman:   { label: 'Data Salesman',         icon: 'bi-person-badge',    roles: [R.MGR], tag: 'MGR' },
  notifikasi: { label: 'Notifikasi Otomatis',   icon: 'bi-bell',            roles: [R.MGR] },
  detailSales:{ label: 'Detail Kunjungan',      icon: 'bi-person-lines-fill', roles: [R.MGR, R.ADM], hidden: true }
};
const BOTTOM = {
  Salesman: [['dashboard', 'bi-house', 'Beranda'], ['riwayat', 'bi-clock-history', 'Riwayat'],
    ['kunjungan', 'bi-geo-alt-fill', 'Check-in', true], ['omset', 'bi-cash-coin', 'Omset'], ['_menu', 'bi-list', 'Menu']],
  Other: [['dashboard', 'bi-house', 'Beranda'], ['kinerja', 'bi-bar-chart-line', 'Kinerja'],
    ['piutangJT', 'bi-calendar2-x', 'Jatuh Tempo'], ['toko', 'bi-shop', 'Toko'], ['_menu', 'bi-list', 'Menu']]
};

const S = {
  user: null, role: '', settings: {}, lists: {}, appUrl: '', loaded: {},
  toko: [], salesman: [], kunjungan: [], omset: [], piutang: [], pembayaran: [], pengguna: [],
  page: null, params: {}, outbox: [], obBusy: false, syncing: false, lastSync: 0
};
const IDX = { toko: new Map(), sales: new Map() };
const F = {};            // state filter per halaman (bertahan saat pindah menu)
const CHARTS = {};       // instance Chart.js
const MAPS = {};         // instance Leaflet
const PHOTO = new Map(); // cache foto (fileId → dataURL)

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = v => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = new Intl.NumberFormat('id-ID');
const rp = n => 'Rp ' + NF.format(Math.round(Number(n) || 0));
const rpShort = n => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e9) return 'Rp ' + (n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + ' M';
  if (Math.abs(n) >= 1e6) return 'Rp ' + (n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' Jt';
  return rp(n);
};
const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : 0;
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f ? f(x) : x) || 0), 0);
const BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const fmtDate = s => { if (!s) return '-'; const p = String(s).slice(0, 10).split('-'); return p.length < 3 ? s : `${p[2]} ${BLN[+p[1] - 1]} ${p[0]}`; };
const fmtDM = s => { const p = String(s).split('-'); return `${+p[2]} ${BLN[+p[1] - 1]}`; };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
const nowTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).format(new Date());
const nowHour = () => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(new Date());
const toMs = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const addDays = (s, n) => new Date(toMs(s) + n * 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / 864e5);
const monthStart = s => s.slice(0, 8) + '01';
const monthEnd = s => { const d = new Date(toMs(monthStart(s))); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const prevMonth = s => addDays(monthStart(s), -1);
const dayName = s => HARI[new Date(toMs(s)).getUTCDay()];
const topDays = t => String(t) === 'Tunai' ? 0 : (parseInt(t, 10) || 0);
const topLabel = t => String(t) === 'Tunai' ? 'Tunai' : `${t} Hari`;
const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const rid = p => `${p}-${today().replace(/-/g, '')}-${(Math.random().toString(36).slice(2) + 'XXXXXX').slice(0, 6).toUpperCase()}`;
const tokoOf = id => IDX.toko.get(id) || { nama: id || '-', kota: '', provinsi: '' };
const salesOf = id => IDX.sales.get(id) || { nama: id || '-', wilayah: '' };
const isMgr = () => S.role === R.MGR;
const isSales = () => S.role === R.SLS;
const lsKey = k => `kns_${k}_${S.user ? S.user.email : ''}`;
const parseRp = v => Number(String(v || '').replace(/[^\d]/g, '')) || 0;

function haversine(a, b, c, d) {
  const r = Math.PI / 180, R0 = 6371000;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return Math.round(2 * R0 * Math.asin(Math.sqrt(x)));
}
function waLink(kontak, text) {
  let d = String(kontak || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(text || '')}` : '';
}

// ── Pemanggil REST API GAS (fetch, anti-CORS) ──
const CFG = window.APP_CONFIG || {};
const AUTH = { token: null, email: null };
/**
 * Panggil aksi backend. Body dikirim sebagai text/plain (WAJIB untuk GAS)
 * agar browser tidak mengirim preflight OPTIONS yang ditolak Apps Script.
 * Error dilempar sebagai { type: 'network' | 'server' | 'auth', message }.
 */
async function api(fn, ...args) {
  if (!CFG.GAS_URL || /XXXX/.test(CFG.GAS_URL)) throw { type: 'server', message: 'GAS_URL belum diisi di js/config.js.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), fn === 'saveKunjungan' ? 120000 : 45000);
  let res;
  try {
    res = await fetch(CFG.GAS_URL, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: fn, token: AUTH.token, args })
    });
  } catch (e) {
    throw { type: 'network', message: e.name === 'AbortError' ? 'Server terlalu lama merespons.' : 'Koneksi ke server gagal. Periksa internet Anda.' };
  } finally { clearTimeout(timer); }
  let out;
  try { out = await res.json(); }
  catch (e) { throw { type: 'network', message: `Respons server tidak valid (HTTP ${res.status}). Pastikan Web App di-deploy dengan akses "Anyone".` }; }
  if (out && out.success) return out.data;
  const msg = String((out && out.message) || 'Terjadi kesalahan.');
  if (/^AUTH:/.test(msg)) { if (fn !== 'login' && fn !== 'loginPassword') onAuthLost(msg); throw { type: 'auth', message: msg.replace(/^AUTH:\s*/, '') }; }
  throw { type: 'server', message: msg.replace(/^SETUP:\s*/, '') };
}

// ── Pemuat pustaka secara malas (Chart.js / Leaflet hanya dimuat saat dibutuhkan) ──
const _scripts = {};
function loadScript(src) {
  if (!_scripts[src]) {
    _scripts[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res; s.onerror = () => { delete _scripts[src]; rej(new Error('Gagal memuat ' + src)); };
      document.head.appendChild(s);
    });
  }
  return _scripts[src];
}
function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l);
}
const ensureChart = () => window.Chart ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js');
const ensureLeaflet = () => {
  loadCss('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css');
  return window.L ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js');
};

// ════════════════════════════════════════════════════════════
// BAGIAN 2 — UI UTILITAS (toast, modal, konfirmasi, tombol loading)
// ════════════════════════════════════════════════════════════
function toast(msg, type = 'info', title) {
  const icon = { ok: 'bi-check-circle-fill text-ok', bad: 'bi-x-circle-fill text-bad', warn: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill text-primary-x' }[type];
  const el = document.createElement('div');
  el.className = `toast-x ${type}`;
  el.setAttribute('role', type === 'bad' ? 'alert' : 'status');
  el.innerHTML = `<i class="bi ${icon}"></i><div>${title ? `<div class="t">${esc(title)}</div>` : ''}<div>${esc(msg)}</div></div>
    <button aria-label="Tutup" onclick="this.parentNode.remove()"><i class="bi bi-x"></i></button>`;
  $('#toastZone').appendChild(el);
  setTimeout(() => el.remove(), type === 'bad' ? 7000 : 3800);
}

function confirmBox({ title = 'Konfirmasi', msg = '', ok = 'Ya, Lanjutkan', icon = 'bi-exclamation-triangle' } = {}) {
  return new Promise(resolve => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    $('#confirmOk').textContent = ok;
    $('#confirmIcon').innerHTML = `<i class="bi ${icon}"></i>`;
    const el = $('#confirmModal');
    const m = bootstrap.Modal.getOrCreateInstance(el);
    let done = false;
    $('#confirmOk').onclick = () => { done = true; m.hide(); resolve(true); };
    el.addEventListener('hidden.bs.modal', () => { if (!done) resolve(false); }, { once: true });
    m.show();
  });
}

function openModal({ title, sub = '', body = '', footer = '', size = 'modal-lg', fs = true, onShown }) {
  const dlg = $('#appModalDialog');
  dlg.className = `modal-dialog modal-dialog-centered modal-dialog-scrollable ${size} ${fs ? 'modal-fs-mobile' : ''}`;
  $('#appModalContent').innerHTML = `
    <div class="modal-header">
      <div><h2 class="modal-title h6 fw-semibold mb-0">${title}</h2>${sub ? `<div class="small text-primary-x fw-semibold">${sub}</div>` : ''}</div>
      <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Tutup"></button>
    </div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
  const el = $('#appModal');
  const m = bootstrap.Modal.getOrCreateInstance(el);
  if (onShown) el.addEventListener('shown.bs.modal', onShown, { once: true });
  m.show();
  return m;
}
const closeModal = () => { const m = bootstrap.Modal.getInstance($('#appModal')); if (m) m.hide(); };

/** Tombol loading: kembalikan fungsi untuk memulihkan tombol. */
function busy(btn, label = 'Menyimpan…') {
  if (!btn) return () => {};
  const html = btn.innerHTML; btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border" role="status" aria-hidden="true"></span> ${label}`;
  return () => { btn.disabled = false; btn.innerHTML = html; };
}

function emptyState(icon, msg) { return `<div class="empty"><i class="bi ${icon}"></i>${esc(msg)}</div>`; }
function pill(text, kind = 'neu', dot) { return `<span class="pill pill-${kind}">${dot ? '<span class="d"></span>' : ''}${esc(text)}</span>`; }
function lateBadge(d) { return d > 30 ? pill(`Telat ${d} hari`, 'bad') : d > 0 ? pill(`Telat ${d} hari`, 'warn') : d === 0 ? pill('Hari ini', 'warn') : pill(`${-d} hari lagi`, 'neu'); }
function gpsPill(g) { return g === 'Terverifikasi' ? pill('GPS Terverifikasi', 'ok', 1) : g === 'Di luar radius' ? pill('Di luar radius', 'warn') : pill(g || 'GPS', 'neu'); }
function hasilPill(h) {
  if (!h) return '';
  return String(h).startsWith('Order') ? pill(h, 'ok', 1) : /Piutang|Penagihan/.test(h) ? pill(h, 'warn', 1) : pill(h, 'neu');
}
function pagerHtml(total, page, per, fnName) {
  const pages = Math.ceil(total / per) || 1;
  if (pages <= 1) return '';
  const btn = (p, label, dis, act) => `<button class="btn btn-sm ${act ? 'btn-primary' : 'btn-outline'}" ${dis ? 'disabled' : ''} onclick="${fnName}(${p})">${label}</button>`;
  let h = btn(page - 1, '<i class="bi bi-chevron-left"></i>', page <= 1);
  const show = new Set([1, pages, page - 1, page, page + 1].filter(p => p >= 1 && p <= pages));
  let last = 0;
  [...show].sort((a, b) => a - b).forEach(p => { if (p - last > 1) h += '<span class="px-1 text-2">…</span>'; h += btn(p, p, false, p === page); last = p; });
  return `<div class="d-flex gap-1 align-items-center flex-wrap">${h + btn(page + 1, '<i class="bi bi-chevron-right"></i>', page >= pages)}</div>`;
}
function selectOptions(list, val, placeholder) {
  return (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
}
function downloadCsv(name, rows) {
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c === null || c === undefined ? '' : c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('File ' + name + ' diunduh.', 'ok');
}
function bindRpInput(input, onChange) {
  input.addEventListener('input', () => {
    const n = parseRp(input.value);
    input.value = n ? NF.format(n) : '';
    if (onChange) onChange(n);
  });
}

// ════════════════════════════════════════════════════════════
// BAGIAN 3 — INISIALISASI, DATA & NAVIGASI SPA
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', initApp);

// ── Sesi & cache data di perangkat ──
function loadAuth() { try { return JSON.parse(localStorage.getItem('kns_auth') || 'null'); } catch (e) { return null; } }
function saveAuth(a) { try { localStorage.setItem('kns_auth', JSON.stringify(a)); } catch (e) { /* abaikan */ } }
function loadBootCache(email) { try { return JSON.parse(localStorage.getItem(`kns_boot_${email}`) || 'null'); } catch (e) { return null; } }
/** Simpan potret data terakhir agar aplikasi terbuka instan berikutnya. */
function saveBootCache() {
  if (!S.user || S.loggingOut) return;
  const clean = arr => arr.filter(r => !r._pending).map(r => { const o = Object.assign({}, r); delete o._local; return o; });
  const snap = { user: S.user, settings: S.settings, lists: S.lists, appUrl: S.appUrl, loaded: S.loaded, today: today(),
    toko: S.toko, salesman: S.salesman, kunjungan: clean(S.kunjungan), omset: clean(S.omset),
    piutang: S.piutang, pembayaran: S.pembayaran.filter(b => !String(b.id).startsWith('tmp-')), pengguna: S.pengguna, _at: Date.now() };
  try {
    const txt = JSON.stringify(snap);
    if (txt.length < 2.5e6) localStorage.setItem(`kns_boot_${S.user.email}`, txt);
  } catch (e) { /* kuota penuh: lewati cache */ }
}

function initApp() {
  syncThemeIcon();
  const auth = loadAuth();
  if (!auth || !auth.token) return showLogin();
  AUTH.token = auth.token; AUTH.email = auth.email;
  const cached = loadBootCache(auth.email);
  if (cached && cached.user) {
    startApp(cached);                 // tampil instan dari cache perangkat…
    syncNow(true);                    // …lalu diperbarui dari server
  } else {
    $('#splashMsg').textContent = 'Memuat data dari server…';
    api('getBootData').then(d => { startApp(d); saveBootCache(); })
      .catch(e => { if (e.type !== 'auth') { showGate(e.message); } });
  }
}

/** Mulai aplikasi dengan paket data (dari login, cache, atau server). */
function startApp(d) {
  hydrate(d);
  obLoad();
  mergeOutbox();
  buildShell();
  $('#login').classList.add('d-none');
  const last = (() => { try { return localStorage.getItem(lsKey('page')); } catch (e) { return null; } })();
  navigateTo(last && canSee(last) && !NAV[last].hidden ? last : 'dashboard');
  hideSplash();
  if (S.outbox.length) setTimeout(processOutbox, 800);
  if (S.started) return;
  S.started = true;
  // Sinkronisasi latar belakang: tiap 5 menit saat tab aktif, dan saat kembali online
  setInterval(() => { if (document.visibilityState === 'visible' && AUTH.token) syncNow(true); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveBootCache();
    else if (AUTH.token && Date.now() - S.lastSync > 60000) syncNow(true);
  });
  window.addEventListener('online', () => { toast('Koneksi kembali. Mengirim data tertunda…', 'info'); processOutbox(); });
  window.addEventListener('offline', () => setSyncPill('offline'));
  window.addEventListener('beforeunload', e => { saveBootCache(); if (S.outbox.length && !S.obPersisted) { e.preventDefault(); e.returnValue = ''; } });
}

// ── Login: email + kata sandi (utama) & Google (opsional) ──
let _gsiReady = false;
const googleEnabled = () => !!CFG.GOOGLE_CLIENT_ID && !/XXXX/.test(CFG.GOOGLE_CLIENT_ID);
function togglePw(btn) {
  const inp = btn.parentNode.querySelector('input');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.innerHTML = `<i class="bi ${inp.type === 'password' ? 'bi-eye' : 'bi-eye-slash'}"></i>`;
}
function showLogin(msg, info) {
  hideSplash();
  $('#login').classList.remove('d-none');
  const m = $('#loginMsg'); m.textContent = msg || ''; m.className = 'login-msg' + (info ? ' info' : '');
  const last = (() => { try { return localStorage.getItem('kns_last_email') || ''; } catch (e) { return ''; } })();
  if (!$('#lgEmail').value) $('#lgEmail').value = AUTH.email || last;
  $('#lgPass').value = '';
  setTimeout(() => ($('#lgEmail').value ? $('#lgPass') : $('#lgEmail')).focus(), 50);
  $('#loginForm').onsubmit = submitLogin;
  if (!googleEnabled()) return;
  $('#gsiArea').classList.remove('d-none');
  loadScript('https://accounts.google.com/gsi/client').then(() => {
    if (!_gsiReady) {
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onGoogleCredential, auto_select: false, cancel_on_tap_outside: true });
      _gsiReady = true;
    }
    $('#gsiBtn').innerHTML = '';
    google.accounts.id.renderButton($('#gsiBtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with',
      locale: 'id', width: Math.min(320, $('#gsiBtn').clientWidth || 320) });
  }).catch(() => { $('#gsiArea').classList.add('d-none'); });
}
async function submitLogin(ev) {
  ev.preventDefault();
  const email = $('#lgEmail').value.trim().toLowerCase(), pw = $('#lgPass').value;
  const m = $('#loginMsg');
  $('#lgEmail').classList.toggle('is-invalid', !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  $('#lgPass').classList.toggle('is-invalid', !pw);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !pw) { m.className = 'login-msg'; m.textContent = 'Isi email dan kata sandi dengan benar.'; return; }
  const done = busy($('#lgBtn'), 'Memeriksa…');
  m.textContent = '';
  try {
    const r = await api('loginPassword', email, pw);
    try { localStorage.setItem('kns_last_email', email); } catch (e) { /* abaikan */ }
    done();
    if (r.mustChange) return showSetPassword(r, pw);
    finishLogin(r);
  } catch (e) {
    done(); m.className = 'login-msg'; m.textContent = e.message; $('#lgPass').select();
  }
}
async function onGoogleCredential(resp) {
  const m = $('#loginMsg');
  m.className = 'login-msg info'; m.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Memverifikasi akun…';
  try { finishLogin(await api('login', resp.credential)); }
  catch (e) { m.className = 'login-msg'; m.textContent = e.message; }
}
function finishLogin(r) {
  const prevEmail = AUTH.email;
  AUTH.token = r.token; AUTH.email = r.boot.user.email;
  saveAuth({ token: r.token, email: r.boot.user.email });
  if (S.started && prevEmail && prevEmail !== AUTH.email) return location.reload();   // ganti akun → mulai bersih
  restoreLoginStep();
  startApp(r.boot); saveBootCache();
  toast(`Selamat datang, ${r.boot.user.nama}.`, 'ok');
}
function restoreLoginStep() { const st = $('#loginStep'); if (st && st.dataset.orig) { st.innerHTML = st.dataset.orig; delete st.dataset.orig; } }

/** Indikator kekuatan kata sandi sederhana. */
function pwScore(pw) {
  let sc = 0;
  if (pw.length >= 8) sc++; if (pw.length >= 12) sc++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) sc++; if (/\d/.test(pw)) sc++; if (/[^A-Za-z0-9]/.test(pw)) sc++;
  return sc;
}
function pwFields(prefix) {
  return `<label class="form-label" for="${prefix}New">Kata sandi baru</label>
    <div class="pw-wrap"><input type="password" class="form-control" id="${prefix}New" autocomplete="new-password" minlength="8" required>
      <button type="button" class="pw-eye" onclick="togglePw(this)" aria-label="Tampilkan kata sandi"><i class="bi bi-eye"></i></button></div>
    <div class="pw-meter"><span id="${prefix}Meter"></span></div>
    <div class="form-text mb-3">Minimal 8 karakter, berisi huruf dan angka.</div>
    <label class="form-label" for="${prefix}Conf">Ulangi kata sandi baru</label>
    <input type="password" class="form-control" id="${prefix}Conf" autocomplete="new-password" required>`;
}
function bindPwMeter(prefix) {
  $('#' + prefix + 'New').addEventListener('input', e => {
    const sc = pwScore(e.target.value), m = $('#' + prefix + 'Meter');
    m.style.width = (sc / 5 * 100) + '%';
    m.style.backgroundColor = sc <= 2 ? 'var(--bad)' : sc === 3 ? 'var(--warn)' : 'var(--ok)';
  });
}
function validateNewPw(prefix, oldPw) {
  const a = $('#' + prefix + 'New').value, b = $('#' + prefix + 'Conf').value;
  if (a.length < 8) return 'Kata sandi minimal 8 karakter.';
  if (!/[A-Za-z]/.test(a) || !/\d/.test(a)) return 'Kata sandi harus berisi huruf dan angka.';
  if (a !== b) return 'Ulangan kata sandi tidak sama.';
  if (oldPw && a === oldPw) return 'Kata sandi baru harus berbeda dari kata sandi sementara.';
  return '';
}
/** Login pertama dengan sandi sementara → wajib membuat sandi sendiri sebelum masuk. */
function showSetPassword(r, tempPw) {
  const st = $('#loginStep');
  if (!st.dataset.orig) st.dataset.orig = st.innerHTML;
  AUTH.token = r.token; AUTH.email = r.boot.user.email;           // sementara di memori saja
  st.innerHTML = `<h2 class="h4 fw-semibold mb-1">Buat kata sandi baru</h2>
    <p class="text-2 mb-4">Halo <b>${esc(r.boot.user.nama)}</b>, Anda masuk dengan kata sandi sementara. Buat kata sandi pribadi untuk melanjutkan.</p>
    <form id="setPwForm" novalidate>${pwFields('sp')}
      <button type="submit" class="btn btn-primary w-100 mt-3" id="spBtn"><i class="bi bi-check2-circle"></i> Simpan & Masuk</button></form>
    <button class="btn btn-ghost w-100 mt-2" onclick="restoreLoginStep();AUTH.token=null;showLogin()">Batal</button>`;
  bindPwMeter('sp');
  $('#spNew').focus();
  $('#setPwForm').onsubmit = async ev => {
    ev.preventDefault();
    const err = validateNewPw('sp', tempPw), m = $('#loginMsg');
    m.className = 'login-msg'; m.textContent = err;
    if (err) return;
    const done = busy($('#spBtn'));
    try {
      const x = await api('changePassword', tempPw, $('#spNew').value);
      r.token = x.token; finishLogin(r);
      toast('Kata sandi baru tersimpan. Gunakan untuk login berikutnya.', 'ok');
    } catch (e) { done(); m.textContent = e.message; }
  };
}
/** Ubah kata sandi dari dalam aplikasi. */
function openChangePassword() {
  closeDrawer();
  const hasPw = S.user && S.user.hasPassword !== false;
  openModal({
    title: 'Ubah Kata Sandi', sub: esc(S.user.email), size: '', fs: false,
    body: `<form id="cpForm" novalidate>
      ${hasPw ? `<label class="form-label" for="cpOld">Kata sandi saat ini</label>
      <div class="pw-wrap mb-3"><input type="password" class="form-control" id="cpOld" autocomplete="current-password" required>
        <button type="button" class="pw-eye" onclick="togglePw(this)" aria-label="Tampilkan kata sandi"><i class="bi bi-eye"></i></button></div>` : ''}
      ${pwFields('cp')}<div id="cpErr" class="invalid-msg mt-2"></div></form>
      <div class="form-text mt-3">Setelah diganti, perangkat lain yang masih login akan diminta login ulang.</div>`,
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="cpSave"><i class="bi bi-check2-circle"></i> Simpan</button>`
  });
  bindPwMeter('cp');
  $('#cpSave').onclick = async () => {
    const old = hasPw ? $('#cpOld').value : '';
    const err = (hasPw && !old) ? 'Isi kata sandi saat ini.' : validateNewPw('cp');
    $('#cpErr').textContent = err; if (err) return;
    const done = busy($('#cpSave'));
    try {
      const x = await api('changePassword', old, $('#cpNew').value);
      AUTH.token = x.token; saveAuth({ token: x.token, email: AUTH.email }); S.user.hasPassword = true;
      closeModal(); toast('Kata sandi berhasil diubah.', 'ok');
    } catch (e) { done(); $('#cpErr').textContent = e.message; }
  };
}
/** Tampilkan kredensial login untuk diteruskan ke pengguna (sekali tampil). */
function showCredentials(email, pw, nama) {
  const url = (S.settings.frontendUrl || location.origin + location.pathname);
  const text = `Login Sales Performance KNS Teknik\nAlamat: ${url}\nEmail: ${email}\nKata sandi sementara: ${pw}\n(Wajib diganti saat login pertama)`;
  openModal({
    title: 'Kata Sandi Sementara', sub: esc(nama || email), size: '', fs: false,
    body: `<p class="small text-2">Berikan data ini ke pengguna. Kata sandi hanya ditampilkan <b>sekali</b> dan wajib diganti saat login pertama.</p>
      <div class="cred-box mb-3"><div class="small text-2">Email</div><div class="fw-semibold mb-2">${esc(email)}</div>
        <div class="small text-2">Kata sandi sementara</div><div class="pw num">${esc(pw)}</div></div>
      <div class="small text-2">Alamat aplikasi: <span class="text-primary-x">${esc(url)}</span></div>`,
    footer: `<button class="btn btn-outline" id="credCopy"><i class="bi bi-clipboard"></i> Salin</button>
      <a class="btn btn-ok-soft" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}"><i class="bi bi-whatsapp"></i> Kirim via WA</a>
      <button class="btn btn-primary" data-bs-dismiss="modal">Selesai</button>`
  });
  $('#credCopy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Tersalin.', 'ok')).catch(() => toast('Salin manual: ' + pw, 'info'));
}
async function resetUserPassword(email) {
  const u = S.pengguna.find(x => x.email === email);
  if (!await confirmBox({ title: 'Reset kata sandi?', msg: `${u.nama} akan mendapat kata sandi sementara baru. Kata sandi lama & semua sesi loginnya langsung tidak berlaku.`, ok: 'Reset', icon: 'bi-key' })) return;
  try {
    const r = await api('resetPassword', email);
    u.punyaSandi = true; renderPage(false);
    showCredentials(r.email, r.tempPassword, u.nama);
  } catch (e) { e.type !== 'auth' && toast(e.message, 'bad', 'Gagal reset'); }
}

/** Sesi kedaluwarsa/dicabut: minta login ulang tanpa membuang data tertunda. */
function onAuthLost(msg) {
  AUTH.token = null;
  saveAuth({ token: null, email: AUTH.email });
  showLogin(msg.replace(/^AUTH:\s*/, '') + (S.outbox && S.outbox.length ? ' Data tertunda Anda tetap aman dan akan dikirim setelah login.' : ''));
}
async function logout(force) {
  if (!force && S.outbox.length && !await confirmBox({ title: 'Masih ada data belum terkirim', msg: `${S.outbox.length} data belum tersinkron. Jika keluar sekarang, data itu tetap tersimpan di perangkat ini dan dikirim saat Anda login lagi.`, ok: 'Tetap Keluar', icon: 'bi-cloud-arrow-up' })) return;
  S.loggingOut = true;
  try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* abaikan */ }
  try { localStorage.removeItem('kns_auth'); if (AUTH.email) localStorage.removeItem(`kns_boot_${AUTH.email}`); } catch (e) { /* abaikan */ }
  location.reload();
}

function hideSplash() {
  const s = $('#splash'); if (!s) return;
  s.style.opacity = '0'; setTimeout(() => s.remove(), 260);
}
function showGate(message) {
  const m = String(message || '');
  $('#gateTitle').textContent = m.startsWith('SETUP:') ? 'Aplikasi Belum Disiapkan' : m.startsWith('AUTH:') ? 'Akses Ditolak' : 'Gagal Memuat Aplikasi';
  $('#gateMsg').textContent = m.replace(/^(AUTH|SETUP):\s*/, '');
  $('#gate').classList.remove('d-none');
  hideSplash();
}

function hydrate(d) {
  S.user = d.user; S.role = d.user.peran; S.settings = d.settings || {}; S.lists = d.lists || {};
  S.appUrl = d.appUrl || ''; S.loaded = d.loaded;
  ['toko', 'salesman', 'kunjungan', 'omset', 'piutang', 'pembayaran'].forEach(k => { S[k] = d[k] || []; });
  if (d.pengguna) S.pengguna = d.pengguna;
  reindex();
  S.lastSync = d._at || Date.now();
}
function reindex() {
  IDX.toko = new Map(S.toko.map(t => [t.id, t]));
  IDX.sales = new Map(S.salesman.map(s => [s.id, s]));
}
const canSee = p => !!NAV[p] && NAV[p].roles.includes(S.role);

/** Piutang + turunan (hari keterlambatan & status) — dihitung lokal. */
function piutangRows() {
  const t = today();
  return S.piutang.map(p => {
    const late = diffDays(p.jatuhTempo, t);
    const sisa = Number(p.sisa) || 0;
    const tk = tokoOf(p.idToko);
    return Object.assign({}, p, {
      _late: late, _sisa: sisa, _toko: tk, _sales: salesOf(tk.idSalesman),
      _status: sisa <= 0 ? 'Lunas' : late > 0 ? 'Jatuh Tempo' : 'Belum Lunas'
    });
  });
}
const overdueRows = () => piutangRows().filter(p => p._sisa > 0 && p._late > 0);

function buildShell() {
  $('#app').classList.remove('d-none');
  $('#meName').textContent = S.user.nama;
  $('#meRole').textContent = S.role === R.MGR ? 'Manajer Penjualan' : S.role === R.ADM ? 'Admin' : 'Salesman';
  $('#meAvatar').textContent = initials(S.user.nama);
  const d = today();
  $('#todayLabel').textContent = `${dayName(d)}, ${fmtDate(d)}`;
  renderNav();
}
function renderNav() {
  const jt = isSales() ? 0 : new Set(overdueRows().map(p => p.id)).size;
  $('#sideNav').innerHTML = Object.entries(NAV).filter(([k, v]) => !v.hidden && canSee(k)).map(([k, v]) => `
    <button class="side-link" data-page="${k}" onclick="navigateTo('${k}')" title="${esc(v.label)}">
      <i class="bi ${v.icon}"></i><span class="lbl">${esc(v.label)}</span>
      ${v.badge && jt ? `<span class="side-badge">${jt}</span>` : ''}${v.tag ? `<span class="side-tag">${v.tag}</span>` : ''}
    </button>`).join('');
  const items = BOTTOM[isSales() ? 'Salesman' : 'Other'];
  const pend = S.outbox.length;
  $('#bottomNav').innerHTML = items.map(([k, ic, lb, fab]) => `
    <button class="bn-item ${fab ? 'fab' : ''}" data-page="${k}" onclick="${k === '_menu' ? 'openDrawer()' : `navigateTo('${k}')`}">
      <i class="bi ${ic}"></i><span>${lb}</span>
      ${k === 'piutangJT' && jt ? `<span class="bn-badge">${jt}</span>` : ''}
      ${k === 'riwayat' && pend ? `<span class="bn-badge">${pend}</span>` : ''}
    </button>`).join('');
  renderBell();
  markActiveNav();
}
function markActiveNav() {
  const p = S.page === 'detailSales' ? 'kinerja' : S.page;
  $$('[data-page]').forEach(b => { b.classList.toggle('active', b.dataset.page === p); b.setAttribute('aria-current', b.dataset.page === p ? 'page' : 'false'); });
}
function renderBell() {
  const items = [];
  if (isSales()) {
    const pend = S.outbox.filter(o => o.status !== 'failed').length, fail = S.outbox.filter(o => o.status === 'failed').length;
    if (pend) items.push(['bi-cloud-arrow-up text-primary-x', `${pend} data sedang dikirim`, 'riwayat']);
    if (fail) items.push(['bi-exclamation-triangle text-bad', `${fail} data gagal terkirim — ketuk untuk coba lagi`, 'riwayat']);
    if (!S.kunjungan.some(k => k.tanggal === today())) items.push(['bi-geo-alt text-primary-x', 'Belum ada kunjungan hari ini', 'kunjungan']);
  } else {
    const od = overdueRows(), krit = od.filter(p => p._late > 30);
    const hariIni = piutangRows().filter(p => p._sisa > 0 && p._late === 0);
    if (od.length) items.push(['bi-calendar2-x text-bad', `${od.length} faktur lewat jatuh tempo (${rpShort(sum(od, p => p._sisa))})`, 'piutangJT']);
    if (krit.length) items.push(['bi-exclamation-octagon text-bad', `${krit.length} faktur kritis > 30 hari`, 'piutangJT']);
    if (hariIni.length) items.push(['bi-hourglass-split text-primary-x', `${hariIni.length} faktur jatuh tempo hari ini`, 'piutang']);
  }
  $('#bellDot').classList.toggle('d-none', !items.length);
  $('#notifMenu').innerHTML = `<div class="px-2 py-1 small fw-semibold text-2">NOTIFIKASI</div>` + (items.length
    ? items.map(([ic, t, pg]) => `<div class="notif-item" onclick="navigateTo('${pg}')"><i class="bi ${ic}"></i><div class="small">${esc(t)}</div></div>`).join('')
    : `<div class="notif-item"><i class="bi bi-check2-circle text-ok"></i><div class="small">Semua aman. Tidak ada notifikasi baru.</div></div>`);
}

/** NAVIGASI SPA — satu-satunya cara berpindah halaman. */
function navigateTo(page, params = {}) {
  if (!canSee(page)) page = 'dashboard';
  if (S.page === 'kunjungan' && page !== 'kunjungan') stopGps();
  S.page = page; S.params = params;
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  $('#pageTitle').textContent = NAV[page].label;
  document.title = NAV[page].label + ' · KNS Teknik';
  markActiveNav();
  closeDrawer();
  renderPage(true);
  window.scrollTo(0, 0);
  try { if (!NAV[page].hidden) localStorage.setItem(lsKey('page'), page); } catch (e) { /* abaikan */ }
}
/** Render halaman aktif. fresh=true → bangun ulang kerangka. */
function renderPage(fresh) {
  const el = $('#page-' + S.page);
  if (!el) return;
  try { PAGES[S.page](el, S.params, fresh); }
  catch (e) { console.error(e); el.innerHTML = `<div class="card-x card-pad">${emptyState('bi-bug', 'Terjadi kesalahan saat menampilkan halaman: ' + e.message)}</div>`; }
}
function openDrawer() { $('#sidebar').classList.add('open'); $('#drawerBackdrop').classList.add('show'); }
function closeDrawer() { $('#sidebar').classList.remove('open'); $('#drawerBackdrop').classList.remove('show'); }

// ── Tema ──
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('kns_theme', next); } catch (e) { /* abaikan */ }
  syncThemeIcon();
  if (!['kunjungan', 'omset'].includes(S.page)) renderPage(false); // warna grafik ikut tema
}
function syncThemeIcon() {
  $('#themeIcon').className = 'bi ' + (document.documentElement.getAttribute('data-theme') === 'dark' ? 'bi-sun' : 'bi-moon-stars');
}

// ── Sinkronisasi data (manual / otomatis) ──
function setSyncPill(state, text) {
  const p = $('#syncPill');
  p.className = 'sync-pill ' + (state === 'ok' ? '' : state);
  const pend = S.outbox.length;
  p.querySelector('.txt').textContent = text || ({ ok: pend ? `${pend} tertunda` : 'Tersinkron', busy: 'Menyinkron…', pending: `${pend} tertunda`, offline: 'Offline' }[state]);
  if (state === 'ok' && pend) p.classList.add('pending');
}
async function syncNow(silent) {
  if (S.syncing) return;
  if (S.outbox.length) await processOutbox();
  S.syncing = true; setSyncPill('busy');
  try {
    const from = S.loaded.from < monthStart(addDays(today(), -62)) ? S.loaded.from : undefined;
    const d = await api('getBootData', from, today());
    hydrate(d); mergeOutbox();
    renderNav(); saveBootCache();
    $$('.page').forEach(p => { p.dataset.mounted = ''; });
    if (!['kunjungan', 'omset'].includes(S.page)) renderPage(true);
    setSyncPill('ok');
    if (!silent) toast('Data terbaru berhasil dimuat.', 'ok');
  } catch (e) {
    setSyncPill(e.type === 'network' ? 'offline' : 'ok');
    if (!silent && e.type !== 'auth') toast(e.message, 'bad', 'Sinkronisasi gagal');
  } finally { S.syncing = false; }
}

// ════════════════════════════════════════════════════════════
// BAGIAN 4 — OUTBOX (Optimistic UI + localStorage + background sync)
// ════════════════════════════════════════════════════════════
function obLoad() { try { S.outbox = JSON.parse(localStorage.getItem(lsKey('outbox')) || '[]'); } catch (e) { S.outbox = []; } }
function obSave() {
  try { localStorage.setItem(lsKey('outbox'), JSON.stringify(S.outbox)); S.obPersisted = true; }
  catch (e) {
    S.obPersisted = false;
    toast('Memori perangkat penuh. Jangan tutup aplikasi sampai data terkirim.', 'warn', 'Perhatian');
  }
}
/** Masukkan record tertunda ke state agar tetap tampil setelah sinkron/muat ulang. */
function mergeOutbox() {
  S.outbox.forEach(o => {
    const arr = S[o.kind];
    const local = o.kind === 'kunjungan' ? (o.payload.fotos || []).map(f => f.data) : undefined;
    if (!arr.some(r => r.id === o.rec.id)) arr.push(Object.assign({}, o.rec, { _pending: true, _failed: o.status === 'failed', _local: local }));
  });
}
function obAdd(kind, rec, payload) {
  const clean = Object.assign({}, rec); delete clean._local;          // foto cukup disimpan sekali (di payload)
  S.outbox.push({ kind, rec: clean, payload, status: 'pending', tries: 0, at: Date.now() });
  S[kind].push(Object.assign({}, rec, { _pending: true }));
  obSave(); renderNav(); setSyncPill('ok');
  processOutbox();
}
async function processOutbox() {
  if (S.obBusy || !S.outbox.length || !AUTH.token) return;
  S.obBusy = true; setSyncPill('busy', 'Mengirim…');
  let halted = false;
  try {
    for (const item of [...S.outbox]) {
      const fn = item.kind === 'kunjungan' ? 'saveKunjungan' : 'saveOmset';
      try {
        const saved = await api(fn, item.payload);
        const arr = S[item.kind], i = arr.findIndex(r => r.id === item.rec.id);
        if (i >= 0) arr[i] = saved; else arr.push(saved);
        S.outbox = S.outbox.filter(o => o !== item); obSave();
        toast(item.kind === 'kunjungan' ? `Kunjungan ${tokoOf(saved.idToko).nama} tersimpan di server.` : `Omset ${rp(saved.nilai)} tersimpan.`, 'ok');
      } catch (e) {
        if (e.type === 'auth') { halted = true; break; }  // sesi habis → simpan, kirim setelah login ulang
        if (e.type === 'server') {          // ditolak validasi server → batalkan (rollback)
          S[item.kind] = S[item.kind].filter(r => r.id !== item.rec.id);
          S.outbox = S.outbox.filter(o => o !== item); obSave();
          e.type !== 'auth' && toast(e.message, 'bad', item.kind === 'kunjungan' ? 'Kunjungan ditolak server' : 'Omset ditolak server');
        } else {                            // jaringan → simpan, coba lagi nanti
          item.status = 'failed'; item.tries++; item.error = e.message; obSave();
          const r = S[item.kind].find(x => x.id === item.rec.id); if (r) r._failed = true;
          setTimeout(processOutbox, Math.min(120000, 15000 * item.tries));
          halted = true; break;
        }
      }
    }
  } finally {
    S.obBusy = false;
    setSyncPill(navigator.onLine === false ? 'offline' : 'ok');
    renderNav();
    if (['riwayat', 'dashboard', 'omset'].includes(S.page)) renderPage(false);
    // Data yang ditambahkan selama pengiriman berlangsung → langsung lanjut dikirim
    if (!halted && S.outbox.some(o => o.status === 'pending')) setTimeout(processOutbox, 50);
  }
}
function retryOutbox() {
  S.outbox.forEach(o => { o.status = 'pending'; });
  S.kunjungan.concat(S.omset).forEach(r => { if (r._pending) r._failed = false; });
  processOutbox();
}

// ════════════════════════════════════════════════════════════
// BAGIAN 5 — GRAFIK & PETA (helper)
// ════════════════════════════════════════════════════════════
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function mkChart(key, canvasId, cfg) {
  ensureChart().then(() => {
    const cv = document.getElementById(canvasId);
    if (!cv) return;
    if (CHARTS[key]) CHARTS[key].destroy();
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = cssVar('--text-2');
    Chart.defaults.borderColor = cssVar('--border');
    CHARTS[key] = new Chart(cv, cfg);
  }).catch(() => { const cv = document.getElementById(canvasId); if (cv) cv.parentNode.innerHTML = emptyState('bi-wifi-off', 'Grafik tidak dapat dimuat (periksa koneksi).'); });
}
const tooltipRp = { callbacks: { label: c => `${c.dataset.label || c.label}: ${rp(c.parsed.y !== undefined && c.parsed.y !== null ? c.parsed.y : c.parsed)}` } };
function trendChart(key, canvasId, from, to, omsetList) {
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const by = (jenis) => days.map(d => sum(omsetList.filter(o => o.tanggal === d && (!jenis || o.jenis === jenis)), o => o.nilai));
  const pri = cssVar('--primary'), fur = cssVar('--furn');
  mkChart(key, canvasId, {
    type: 'line',
    data: {
      labels: days.map(fmtDM),
      datasets: [
        { label: 'Part Teknik', data: by('Part Teknik'), borderColor: pri, backgroundColor: pri + '22', fill: true, tension: .35, pointRadius: days.length > 20 ? 0 : 3, borderWidth: 2.5 },
        { label: 'Part Furniture', data: by('Part Furniture'), borderColor: fur, backgroundColor: fur + '18', fill: true, tension: .35, pointRadius: days.length > 20 ? 0 : 3, borderWidth: 2, borderDash: [6, 4] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipRp },
      scales: { y: { beginAtZero: true, ticks: { callback: v => v >= 1e6 ? (v / 1e6) + 'Jt' : v } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } } }
    }
  });
}
function destroyMap(key) { if (MAPS[key]) { MAPS[key].remove(); delete MAPS[key]; } }
function mkMap(key, elId, lat, lng, zoom) {
  return ensureLeaflet().then(() => {
    destroyMap(key);
    const el = document.getElementById(elId);
    if (!el) return null;
    const m = L.map(el, { zoomControl: true, attributionControl: true }).setView([lat, lng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    MAPS[key] = m;
    setTimeout(() => m.invalidateSize(), 200);
    return m;
  }).catch(() => { const el = document.getElementById(elId); if (el) el.innerHTML = emptyState('bi-map', 'Peta tidak dapat dimuat.'); return null; });
}
const pinIcon = (color) => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
  html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>` });

// ════════════════════════════════════════════════════════════
// BAGIAN 6 — PERHITUNGAN KINERJA (lokal, instan)
// ════════════════════════════════════════════════════════════
const activeSales = () => S.salesman.filter(s => s.status !== 'Nonaktif');
const targetOf = s => Number(s.targetOmset) || Number(S.settings.targetOmset) || 0;
const targetKjOf = s => Number(s.targetKunjungan) || Number(S.settings.targetKunjungan) || 0;
/** Faktor target untuk rentang tanggal (bulan berjalan dihitung penuh). */
function targetFactor(from, to) {
  let f = 0, cur = monthStart(from);
  const t = today();
  while (cur <= to) {
    const me = monthEnd(cur), a = from > cur ? from : cur;
    let b = to < me ? to : me;
    if (a === cur && to >= t && me >= t && cur <= t) b = me;
    f += (diffDays(a, b) + 1) / (diffDays(cur, me) + 1);
    cur = addDays(me, 1);
  }
  return f;
}
function salesStats(from, to, opt = {}) {
  const tf = targetFactor(from, to);
  const okToko = id => !opt.prov || tokoOf(id).provinsi === opt.prov;
  const kj = S.kunjungan.filter(k => k.tanggal >= from && k.tanggal <= to && okToko(k.idToko));
  const om = S.omset.filter(o => o.tanggal >= from && o.tanggal <= to && okToko(o.idToko) && (!opt.jenis || o.jenis === opt.jenis));
  const list = (opt.sales ? S.salesman.filter(s => s.id === opt.sales) : S.salesman.filter(s => s.status !== 'Nonaktif' || kj.some(k => k.idSalesman === s.id)))
    .map(s => {
      const k = kj.filter(x => x.idSalesman === s.id), o = om.filter(x => x.idSalesman === s.id);
      const total = sum(o, x => x.nilai), target = Math.round(targetOf(s) * tf);
      return {
        s, kunjungan: k.length, tokoUnik: new Set(k.map(x => x.idToko)).size, omset: total,
        teknik: sum(o.filter(x => x.jenis === 'Part Teknik'), x => x.nilai),
        furniture: sum(o.filter(x => x.jenis === 'Part Furniture'), x => x.nilai),
        target, pct: pct(total, target), targetKj: Math.round(targetKjOf(s) * tf),
        gpsOk: k.filter(x => x.gps === 'Terverifikasi').length
      };
    }).sort((a, b) => b.omset - a.omset);
  return { list, kj, om, tf };
}

// ════════════════════════════════════════════════════════════
// BAGIAN 7 — HALAMAN
// ════════════════════════════════════════════════════════════
const PAGES = {};

function pageHead(eyebrow, title, sub, actions = '') {
  return `<div class="page-head"><div>${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
    <h1 class="page-title">${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}</div>`;
}
function kpi({ label, value, meta = '', badge = '', icon = '', bar = null, cls = '', barCls = '' }) {
  return `<div class="kpi ${cls}"><div class="kpi-top"><div class="kpi-label">${label}</div>${badge}${icon ? `<div class="kpi-icon"><i class="bi ${icon}"></i></div>` : ''}</div>
    <div class="kpi-value num">${value}</div>
    ${bar !== null ? `<div class="bar ${barCls}"><span style="width:${Math.min(100, Math.max(0, bar))}%"></span></div>` : ''}
    ${meta ? `<div class="kpi-meta">${meta}</div>` : ''}</div>`;
}

// ── 7.1 DASHBOARD ──────────────────────────────────────────
PAGES.dashboard = (el) => isSales() ? dashSales(el) : dashMgr(el);

function dashMgr(el) {
  const t = today(), y = addDays(t, -1), ms = monthStart(t);
  const omT = sum(S.omset.filter(o => o.tanggal === t), o => o.nilai);
  const omY = sum(S.omset.filter(o => o.tanggal === y), o => o.nilai);
  const st = salesStats(ms, t);
  const omM = sum(st.om, o => o.nilai), tgtM = sum(st.list, r => r.target);
  const kjT = S.kunjungan.filter(k => k.tanggal === t);
  const kjTok = kjT.filter(k => k.gps === 'Terverifikasi').length;
  const fieldSales = new Set(kjT.map(k => k.idSalesman)).size;
  const od = overdueRows(), krit = od.filter(p => p._late > 30);
  const delta = omY ? Math.round((omT - omY) / omY * 100) : 0;
  const dim = diffDays(ms, monthEnd(t)) + 1, dNow = diffDays(ms, t) + 1;
  const tgtHarian = Number(S.settings.targetHarian) || 0;

  el.innerHTML = pageHead(`<i class="bi bi-circle-fill" style="font-size:6px"></i> Executive overview • ${esc(BULAN[+t.slice(5, 7) - 1])} ${t.slice(0, 4)}`,
    S.role === R.MGR ? 'Dashboard Eksekutif' : 'Dashboard Operasional',
    'Pantau kinerja penjualan part teknik & part furniture serta mitigasi risiko piutang toko hari ini.',
    `<button class="btn btn-outline" onclick="syncNow()"><i class="bi bi-arrow-repeat"></i> Muat Ulang</button>
     <button class="btn btn-primary" onclick="navigateTo('kinerja')"><i class="bi bi-bar-chart-line"></i> Ringkasan Kinerja</button>`) + `
  <div class="row g-3 mb-4">
    <div class="col-6 col-xl-3">${kpi({ label: 'Omset Hari Ini', value: rp(omT),
      badge: omY ? pill(`${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs kemarin`, delta >= 0 ? 'ok' : 'bad') : '',
      meta: tgtHarian ? `<i class="bi bi-flag"></i> Target harian tim: <b>${rp(tgtHarian)}</b>` : '', bar: tgtHarian ? pct(omT, tgtHarian) : null, barCls: omT >= tgtHarian ? 'ok' : '' })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: `Omset Bulan Ini`, value: rp(omM), badge: pill(`${pct(omM, tgtM)}% Target`, 'pri'),
      bar: pct(omM, tgtM), meta: `Target: <b>${rp(tgtM)}</b> • sisa ${dim - dNow} hari` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Kunjungan Hari Ini', value: `${kjT.length} <small>kunjungan</small>`, badge: pill('LIVE', 'ok', 1),
      bar: kjT.length ? pct(kjTok, kjT.length) : 0, barCls: 'ok',
      meta: `${pct(kjTok, kjT.length)}% GPS terverifikasi • <b>${fieldSales}</b> dari ${activeSales().length} salesman di lapangan` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Piutang Jatuh Tempo', value: `<span class="text-bad">${rp(sum(od, p => p._sisa))}</span>`,
      badge: pill(`${od.length} Faktur`, 'pri'), meta: krit.length
        ? `<span class="text-bad fw-semibold"><i class="bi bi-exclamation-triangle"></i> ${krit.length} faktur > 30 hari (${rp(sum(krit, p => p._sisa))})</span>`
        : 'Tidak ada faktur kritis > 30 hari.' })}</div>
  </div>
  <div class="row g-3 mb-4">
    <div class="col-xl-8"><div class="card-x h-100">
      <div class="card-head"><div><h2 class="card-title">Tren Omset Harian (1 - ${fmtDM(t)})</h2>
        <p class="card-sub">Pergerakan transaksi part teknik vs part furniture bulan berjalan</p></div>
        <div class="legend"><span><i style="background:var(--primary)"></i>Part Teknik ${rpShort(sum(st.om.filter(o => o.jenis === 'Part Teknik'), o => o.nilai))}</span>
        <span><i style="background:var(--furn)"></i>Part Furniture ${rpShort(sum(st.om.filter(o => o.jenis === 'Part Furniture'), o => o.nilai))}</span></div></div>
      <div class="card-pad pt-3"><div class="chart-box"><canvas id="cvDashTrend" aria-label="Grafik tren omset harian"></canvas></div></div>
      <div class="card-foot"><span><i class="bi bi-graph-up"></i> Rata-rata omset harian: <b class="num">${rp(omM / dNow)}</b> / hari</span>
        <button class="btn btn-ghost btn-sm" onclick="navigateTo('kinerja')">Lihat detail <i class="bi bi-arrow-right"></i></button></div>
    </div></div>
    <div class="col-xl-4"><div class="card-x h-100">
      <div class="card-head"><div><h2 class="card-title">Omset per Salesman</h2><p class="card-sub">Peringkat pencapaian target bulan ini</p></div></div>
      <div class="card-pad pt-3 d-flex flex-column gap-2">${st.list.length ? st.list.map((r, i) => `
        <div class="rank" role="button" onclick="navigateTo('detailSales',{id:'${esc(r.s.id)}'})">
          <div class="rank-no ${i === 0 ? 'top' : ''}">${i + 1}</div>
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex justify-content-between gap-2"><b class="text-truncate">${esc(r.s.nama)}</b><b class="num">${rp(r.omset)}</b></div>
            <div class="d-flex justify-content-between gap-2 small text-2 mb-1"><span class="text-truncate">${r.kunjungan} kunjungan • ${esc(r.s.wilayah)}</span>
              <span class="${r.pct >= 90 ? 'text-ok' : r.pct < 60 ? 'text-bad' : ''} fw-semibold">${r.pct}%</span></div>
            <div class="bar ${r.pct >= 100 ? 'ok' : ''}"><span style="width:${Math.min(100, r.pct)}%"></span></div>
          </div></div>`).join('') : emptyState('bi-people', 'Belum ada salesman aktif.')}
      </div>
      <div class="card-foot"><span>Total <b>${st.kj.length}</b> kunjungan • <b>${new Set(st.kj.map(k => k.idToko)).size}</b> toko unik</span>
        <b class="text-primary-x num">${pct(omM, tgtM)}%</b></div>
    </div></div>
  </div>
  <div class="mb-4">${insightBox(st, od, krit, omM, tgtM, dNow, dim, kjT)}</div>
  <div class="row g-3">
    <div class="col-xl-7"><div class="card-x h-100">
      <div class="card-head"><div><h2 class="card-title"><i class="bi bi-circle-fill text-ok" style="font-size:9px;vertical-align:3px"></i> Kunjungan Lapangan Terbaru</h2>
        <p class="card-sub">Verifikasi lokasi GPS & foto bukti dari aplikasi salesman</p></div>${pill('Real-time', 'pri')}</div>
      <div class="tbl-wrap mt-3">${recentVisitsTable()}</div>
    </div></div>
    <div class="col-xl-5"><div class="card-x h-100">
      <div class="card-head"><div><h2 class="card-title">Piutang Jatuh Tempo Kritis</h2><p class="card-sub">Tagihan terlambat terlama yang perlu eskalasi</p></div>${pill('Prioritas', 'bad')}</div>
      <div class="mt-2">${od.slice().sort((a, b) => b._late - a._late).slice(0, 5).map(p => `
        <div class="list-item" onclick="openBayar('${esc(p.id)}')">
          <div class="li-main"><div class="li-title">${esc(p._toko.nama)} ${lateBadge(p._late)}</div>
            <div class="li-meta"><span><i class="bi bi-geo-alt"></i> ${esc(p._toko.kota)}</span><span>${esc(p.noFaktur)}</span><span>${topLabel(p._toko.top)}</span></div></div>
          <div class="text-end"><div class="fw-bold text-bad num">${rp(p._sisa)}</div>
            ${waLink(p._toko.kontak) ? `<a class="btn btn-sm btn-ok-soft mt-1" target="_blank" rel="noopener" onclick="event.stopPropagation()" href="${esc(waLink(p._toko.kontak, `Halo ${p._toko.pic || ''}, kami dari KNS Teknik ingin mengingatkan faktur ${p.noFaktur} senilai ${rp(p._sisa)} telah jatuh tempo. Terima kasih.`))}"><i class="bi bi-whatsapp"></i> Hubungi</a>` : ''}
          </div></div>`).join('') || emptyState('bi-check2-circle', 'Tidak ada piutang jatuh tempo.')}</div>
      ${od.length ? `<div class="card-foot" style="background:var(--bad-bg);color:var(--bad-text)"><b class="num">Total jatuh tempo: ${rp(sum(od, p => p._sisa))}</b>
        <button class="btn btn-sm btn-ghost" onclick="navigateTo('piutangJT')">Buka (${od.length}) <i class="bi bi-arrow-right"></i></button></div>` : ''}
    </div></div>
  </div>`;
  trendChart('dashTrend', 'cvDashTrend', ms, t, st.om);
}

function recentVisitsTable() {
  const rows = S.kunjungan.slice().sort((a, b) => (b.tanggal + b.waktu).localeCompare(a.tanggal + a.waktu)).slice(0, 6);
  if (!rows.length) return emptyState('bi-geo-alt', 'Belum ada kunjungan tercatat.');
  return `<table class="tbl"><thead><tr><th>Salesman</th><th>Toko & Kota</th><th>Waktu</th><th>Bukti</th><th>Hasil</th></tr></thead><tbody>
    ${rows.map(k => { const tk = tokoOf(k.idToko); const nf = String(k.fotoIds || '').split(',').filter(Boolean).length;
      return `<tr class="clickable" onclick="showVisit('${esc(k.id)}')">
      <td><div class="cell-main">${esc(salesOf(k.idSalesman).nama)}</div></td>
      <td><div class="cell-main">${esc(tk.nama)}</div><div class="cell-sub">${esc(tk.kota)}</div></td>
      <td class="num text-nowrap"><div>${esc(k.waktu)} WIB</div><div class="cell-sub">${fmtDate(k.tanggal)}</div></td>
      <td>${gpsPill(k.gps)}<div class="cell-sub mt-1"><i class="bi bi-images"></i> ${nf} foto</div></td>
      <td>${hasilPill(k.hasil)}</td></tr>`; }).join('')}</tbody></table>`;
}

/** Panel "Analisis Otomatis" — insight teks dari data. */
function insightBox(st, od, krit, omM, tgtM, dNow, dim, kjT) {
  const L = [];
  const proj = dNow ? omM / dNow * dim : 0;
  L.push(`Omset bulan ini <b>${rp(omM)}</b> (${pct(omM, tgtM)}% target). Dengan laju saat ini, proyeksi akhir bulan <b>${rpShort(proj)}</b> — ${proj >= tgtM ? '<b>diperkirakan mencapai target</b>.' : `kurang <b>${rpShort(tgtM - proj)}</b> dari target.`}`);
  if (st.list.length) {
    const top = st.list[0], low = st.list[st.list.length - 1];
    L.push(`<b>${esc(top.s.nama)}</b> memimpin dengan ${top.pct}% target${st.list.length > 1 ? `; <b>${esc(low.s.nama)}</b> paling rendah (${low.pct}%) — perlu pendampingan atau evaluasi rute.` : '.'}`);
  }
  const tek = sum(st.om.filter(o => o.jenis === 'Part Teknik'), o => o.nilai);
  if (omM) L.push(`Komposisi produk: Part Teknik <b>${pct(tek, omM)}%</b>, Part Furniture <b>${pct(omM - tek, omM)}%</b>.`);
  const idle = activeSales().filter(s => !kjT.some(k => k.idSalesman === s.id));
  if (idle.length && nowHour() >= 11) L.push(`Belum ada kunjungan hari ini dari: <b>${idle.map(s => esc(s.nama)).join(', ')}</b>.`);
  const out = st.kj.filter(k => k.gps === 'Di luar radius').length;
  if (out) L.push(`<b>${out}</b> kunjungan bulan ini tercatat di luar radius ${S.settings.radius || 150} m dari pin toko — cek kemungkinan pin toko keliru atau kunjungan tidak valid.`);
  if (krit.length) {
    const bySales = {}; krit.forEach(p => { const n = p._sales.nama; bySales[n] = (bySales[n] || 0) + p._sisa; });
    const worst = Object.entries(bySales).sort((a, b) => b[1] - a[1])[0];
    L.push(`<b>${krit.length} faktur kritis > 30 hari</b> senilai ${rp(sum(krit, p => p._sisa))}; terbesar di wilayah <b>${esc(worst[0])}</b> (${rpShort(worst[1])}). Wajib SP-1 & kunjungan penagihan.`);
  } else if (od.length) L.push(`${od.length} faktur lewat jatuh tempo, belum ada yang kritis > 30 hari.`);
  return `<div class="insight"><h3><i class="bi bi-stars"></i> Analisis Otomatis</h3><ul>${L.map(x => `<li>${x}</li>`).join('')}</ul></div>`;
}

function dashSales(el) {
  const t = today(), ms = monthStart(t), me = S.salesman[0] || { nama: S.user.nama };
  const myK = S.kunjungan.filter(k => isSales() ? k.idSalesman === S.user.idSalesman : true);
  const myO = S.omset.filter(o => isSales() ? o.idSalesman === S.user.idSalesman : true);
  const kT = myK.filter(k => k.tanggal === t), oT = myO.filter(o => o.tanggal === t);
  const kM = myK.filter(k => k.tanggal >= ms), oM = myO.filter(o => o.tanggal >= ms);
  const omM = sum(oM, o => o.nilai), tgt = targetOf(me), tgtK = targetKjOf(me);
  const sisaHari = diffDays(t, monthEnd(t)) + 1;
  const need = Math.max(0, tgt - omM);
  const h = nowHour(), salam = h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
  const fails = S.outbox.filter(o => o.status === 'failed').length;
  const todayList = kT.map(k => ({ t: k.waktu, html: `${hasilPill(k.hasil)}`, title: tokoOf(k.idToko).nama, k })).concat(
    oT.map(o => ({ t: (o.dibuat || '').slice(11, 16) || '', title: tokoOf(o.idToko).nama, o }))).sort((a, b) => String(b.t).localeCompare(String(a.t)));

  el.innerHTML = pageHead(`${dayName(t)}, ${fmtDate(t)}`, `Selamat ${salam}, ${esc(String(S.user.nama).split(' ')[0])}`,
    `Wilayah tugas: <b>${esc(me.wilayah || '-')}</b>. Catat setiap kunjungan & omset langsung dari lapangan.`) + `
  ${S.outbox.length ? `<div class="callout mb-3" style="background:var(--warn-bg);color:var(--warn-text)"><i class="bi bi-cloud-arrow-up" style="color:inherit"></i>
    <div class="flex-grow-1"><b>${S.outbox.length} data menunggu terkirim.</b> ${fails ? 'Koneksi bermasalah — data aman tersimpan di perangkat.' : 'Sedang dikirim di latar belakang…'}</div>
    ${fails ? `<button class="btn btn-sm btn-outline" onclick="retryOutbox()">Coba lagi</button>` : ''}</div>` : ''}
  <div class="row g-3 mb-3">
    <div class="col-12 col-md-6"><button class="quick q1" onclick="navigateTo('kunjungan')"><i class="bi bi-geo-alt-fill"></i>
      <div><div class="t">Check-in Kunjungan</div><div class="s">Foto toko + pin lokasi GPS otomatis</div></div><i class="bi bi-chevron-right ms-auto fs-5"></i></button></div>
    <div class="col-12 col-md-6"><button class="quick q2" onclick="navigateTo('omset')"><i class="bi bi-cash-coin"></i>
      <div><div class="t">Catat Omset</div><div class="s">Part Teknik / Part Furniture</div></div><i class="bi bi-chevron-right ms-auto fs-5"></i></button></div>
  </div>
  <div class="row g-3 mb-4">
    <div class="col-6 col-xl-3">${kpi({ label: 'Kunjungan Hari Ini', value: `${kT.length} <small>toko</small>`, icon: 'bi-shop', meta: `${kT.filter(k => k.gps === 'Terverifikasi').length} GPS terverifikasi` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Omset Hari Ini', value: rp(sum(oT, o => o.nilai)), icon: 'bi-cash-stack', meta: `${oT.length} transaksi` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Omset Bulan Ini', value: rp(omM), bar: pct(omM, tgt), barCls: omM >= tgt ? 'ok' : '', meta: `${pct(omM, tgt)}% dari target ${rpShort(tgt)}` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Kunjungan Bulan Ini', value: `${kM.length} <small>/ ${tgtK}</small>`, bar: pct(kM.length, tgtK), barCls: 'ok', meta: `${new Set(kM.map(k => k.idToko)).size} toko unik` })}</div>
  </div>
  <div class="row g-3">
    <div class="col-lg-7"><div class="card-x">
      <div class="card-head"><div><h2 class="card-title">Aktivitas Hari Ini</h2><p class="card-sub">Kunjungan & omset yang tercatat hari ini</p></div>
        <button class="btn btn-ghost btn-sm" onclick="navigateTo('riwayat')">Riwayat <i class="bi bi-arrow-right"></i></button></div>
      <div class="mt-2">${todayList.length ? todayList.map(x => x.k ? visitListItem(x.k) : omsetListItem(x.o)).join('') : emptyState('bi-calendar-check', 'Belum ada aktivitas hari ini. Mulai dengan Check-in Kunjungan.')}</div>
    </div></div>
    <div class="col-lg-5"><div class="insight"><h3><i class="bi bi-stars"></i> Target Anda</h3><ul>
      <li>${need > 0 ? `Butuh <b>${rp(need)}</b> lagi untuk mencapai target bulan ini.` : '<b>Target bulan ini sudah tercapai.</b> Pertahankan!'}</li>
      ${need > 0 ? `<li>Rata-rata yang dibutuhkan: <b>${rp(need / sisaHari)}</b> per hari selama ${sisaHari} hari tersisa.</li>` : ''}
      <li>Kunjungan bulan ini ${kM.length} dari target ${tgtK} (${pct(kM.length, tgtK)}%).</li>
      ${S.toko.filter(tk => tk.idSalesman === S.user.idSalesman && !kM.some(k => k.idToko === tk.id)).length
        ? `<li>${S.toko.filter(tk => tk.idSalesman === S.user.idSalesman && !kM.some(k => k.idToko === tk.id)).length} toko binaan belum dikunjungi bulan ini.</li>` : ''}
    </ul></div></div>
  </div>`;
}

function visitListItem(k, sel) {
  const tk = tokoOf(k.idToko);
  const nf = k._pending ? '' : `<span><i class="bi bi-images"></i> ${String(k.fotoIds || '').split(',').filter(Boolean).length} foto</span>`;
  const st = k._pending ? (k._failed ? pill('Gagal kirim — tertunda', 'bad') : pill('Mengunggah…', 'pri')) : gpsPill(k.gps);
  return `<div class="list-item ${sel ? 'sel' : ''} ${k._pending ? 'pending' : ''}" onclick="showVisit('${esc(k.id)}')">
    <div class="li-main"><div class="li-title">${esc(tk.nama)} <span class="code">${esc(k.idToko)}</span></div>
      <div class="li-meta"><span><i class="bi bi-geo-alt"></i> ${esc(tk.kota)}</span>${nf}<span>${st}</span>${k.hasil ? `<span>${hasilPill(k.hasil)}</span>` : ''}</div></div>
    <div class="text-end small text-2 num"><div class="fw-semibold" style="color:var(--text)">${esc(k.waktu)}</div><div>${fmtDM(k.tanggal)}</div></div></div>`;
}
function omsetListItem(o, canDel) {
  const tk = tokoOf(o.idToko);
  return `<div class="list-item ${o._pending ? 'pending' : ''}" style="cursor:default">
    <div class="li-main"><div class="li-title">${esc(tk.nama)} ${pill(o.jenis, o.jenis === 'Part Teknik' ? 'pri' : 'warn')}</div>
      <div class="li-meta"><span>${fmtDate(o.tanggal)}</span>${o.catatan ? `<span>${esc(o.catatan)}</span>` : ''}
      ${o._pending ? `<span>${o._failed ? pill('Gagal kirim — tertunda', 'bad') : pill('Mengirim…', 'pri')}</span>` : ''}</div></div>
    <div class="text-end"><div class="fw-bold num">${rp(o.nilai)}</div>
      ${canDel && !o._pending ? `<button class="btn btn-sm btn-ghost text-bad" onclick="deleteItem('omset','${esc(o.id)}')"><i class="bi bi-trash"></i></button>` : ''}</div></div>`;
}

// ── 7.2 FORM KUNJUNGAN (GPS + foto) ─────────────────────────
const K = { lat: null, lng: null, acc: null, state: 'idle', err: '', fotos: [], watch: null };

PAGES.kunjungan = (el, params, fresh) => {
  if (!fresh && el.dataset.mounted) return;
  el.dataset.mounted = '1';
  Object.assign(K, { lat: null, lng: null, acc: null, state: 'idle', err: '', fotos: [] });
  const tokoList = S.toko.filter(t => t.status !== 'Nonaktif');
  el.innerHTML = pageHead('<i class="bi bi-geo-alt"></i> Bukti kunjungan lapangan', 'Check-in Kunjungan Toko',
    'Lokasi GPS diambil otomatis dari perangkat. Minimal 1 foto wajib diambil langsung dari kamera.') + `
  <div class="row g-3"><div class="col-lg-7">
    <form id="formKj" class="card-x card-pad" novalidate onsubmit="submitKunjungan(event)">
      <div id="gpsBox" class="mb-3"></div>
      ${isMgr() ? `<div class="mb-3"><label class="form-label" for="kjSales">Salesman <span class="req">*</span></label>
        <select class="form-select" id="kjSales" required>${selectOptions(activeSales().map(s => [s.id, s.nama]), '', 'Pilih salesman…')}</select></div>` : ''}
      <div class="mb-3">
        <label class="form-label" for="kjToko">Toko yang dikunjungi <span class="req">*</span></label>
        <div class="input-icon mb-2"><i class="bi bi-search"></i><input class="form-control" id="kjCari" placeholder="Cari nama toko / kota…" autocomplete="off"></div>
        <select class="form-select" id="kjToko" required>${kjTokoOptions(tokoList, '')}</select>
        <div id="kjTokoInfo" class="form-text mt-2"></div>
      </div>
      <div class="mb-3">
        <label class="form-label">Foto bukti kunjungan <span class="req">*</span> <span class="text-2 fw-normal">(1–3 foto)</span></label>
        <div class="photo-grid" id="kjFotoGrid"></div>
        <input type="file" id="kjFile" accept="image/*" capture="environment" class="d-none">
        <div class="form-text">Foto otomatis dikompres & diberi cap waktu + koordinat GPS.</div>
      </div>
      <div class="mb-3">
        <label class="form-label">Hasil kunjungan <span class="req">*</span></label>
        <div class="choice-grid">${(S.lists.hasil || []).map((h, i) => `<label class="choice"><input type="radio" name="kjHasil" value="${esc(h)}" required><div class="t small">${esc(h)}</div></label>`).join('')}</div>
      </div>
      <div class="mb-4">
        <label class="form-label" for="kjCatatan">Catatan lapangan</label>
        <textarea class="form-control" id="kjCatatan" rows="3" maxlength="1000" placeholder="Contoh: Bertemu Pak Hendra (owner), repeat order baut M12, janji transfer cicilan Rabu."></textarea>
      </div>
      <div id="kjErr" class="invalid-msg mb-2"></div>
      <button type="submit" class="btn btn-primary btn-xl w-100" id="kjSubmit"><i class="bi bi-check2-circle"></i> Kirim Kunjungan</button>
    </form>
  </div>
  <div class="col-lg-5">
    <div class="card-x"><div class="card-head"><div><h2 class="card-title">Peta Lokasi</h2><p class="card-sub">Posisi Anda (biru) & pin toko (hijau)</p></div></div>
      <div class="card-pad pt-3"><div id="kjMap" class="map-box"></div></div></div>
    <div class="callout mt-3"><i class="bi bi-shield-check"></i><div>Tanggal & jam kunjungan dicatat oleh <b>server</b>, bukan perangkat, sehingga tidak dapat diubah. Radius verifikasi: <b>${S.settings.radius || 150} m</b> dari pin toko.</div></div>
  </div></div>`;

  const cari = $('#kjCari'), sel = $('#kjToko');
  cari.addEventListener('input', debounce(() => {
    const q = cari.value.toLowerCase().trim(), cur = sel.value;
    sel.innerHTML = kjTokoOptions(tokoList.filter(t => !q || (t.nama + ' ' + t.kota + ' ' + t.id).toLowerCase().includes(q)), cur);
    if (!sel.value && sel.options.length > 1 && q) sel.selectedIndex = 1;
    updateKjInfo();
  }, 120));
  sel.addEventListener('change', updateKjInfo);
  $('#kjFile').addEventListener('change', onKjFoto);
  $('#formKj').addEventListener('change', () => { $('#kjErr').innerHTML = ''; $('#kjToko').classList.remove('is-invalid'); });
  if (params.idToko) sel.value = params.idToko;
  renderKjFotos(); renderGps(); startGps();
};

function kjTokoOptions(list, cur) {
  const withD = list.map(t => ({ t, d: K.lat !== null && t.lat !== '' ? haversine(K.lat, K.lng, +t.lat, +t.lng) : null }));
  withD.sort((a, b) => (a.d === null ? 1e12 : a.d) - (b.d === null ? 1e12 : b.d) || a.t.nama.localeCompare(b.t.nama));
  return `<option value="">Pilih toko…</option>` + withD.map(({ t, d }) =>
    `<option value="${esc(t.id)}" ${t.id === cur ? 'selected' : ''}>${esc(t.nama)} — ${esc(t.kota)}${d !== null ? ` (${d < 1000 ? d + ' m' : (d / 1000).toFixed(1) + ' km'})` : ''}</option>`).join('');
}
function updateKjInfo() {
  const t = IDX.toko.get($('#kjToko') ? $('#kjToko').value : '');
  const info = $('#kjTokoInfo'); if (!info) return;
  if (!t) { info.innerHTML = ''; drawKjMap(); return; }
  const d = K.lat !== null && t.lat !== '' ? haversine(K.lat, K.lng, +t.lat, +t.lng) : null;
  const r = S.settings.radius || 150;
  info.innerHTML = `<i class="bi bi-geo"></i> ${esc(t.alamat || '')}, ${esc(t.kota)} • PIC ${esc(t.pic || '-')} • TOP ${topLabel(t.top)}<br>` +
    (t.lat === '' ? pill('Toko belum punya pin peta', 'neu') : d === null ? pill('Menunggu GPS…', 'neu') :
      d <= r ? pill(`Dalam radius — ${d} m dari pin toko`, 'ok', 1) : pill(`Di luar radius — ${d < 1000 ? d + ' m' : (d / 1000).toFixed(1) + ' km'} dari pin toko`, 'warn'));
  drawKjMap();
}
function startGps() {
  stopGps();
  if (!navigator.geolocation) { K.state = 'err'; K.err = 'Perangkat tidak mendukung GPS.'; return renderGps(); }
  K.state = 'locating'; K.acc = null; renderGps();
  let first = true;
  const ok = pos => {
    const c = pos.coords;
    if (K.acc !== null && c.accuracy > K.acc && K.state === 'ok') return;   // simpan yang paling akurat
    Object.assign(K, { lat: +c.latitude.toFixed(7), lng: +c.longitude.toFixed(7), acc: Math.round(c.accuracy), state: 'ok', err: '' });
    renderGps();
    const sel = $('#kjToko');
    if (sel && first) {               // urutkan toko berdasarkan jarak terdekat
      first = false;
      const cur = sel.value, tl = S.toko.filter(t => t.status !== 'Nonaktif');
      sel.innerHTML = kjTokoOptions(tl, cur);
      if (!cur) { const near = tl.filter(t => t.lat !== '').map(t => [t, haversine(K.lat, K.lng, +t.lat, +t.lng)]).sort((a, b) => a[1] - b[1])[0];
        if (near && near[1] <= (S.settings.radius || 150)) { sel.value = near[0].id; toast(`Toko terdekat terdeteksi: ${near[0].nama}`, 'info'); } }
    }
    updateKjInfo();
    if (K.acc <= 15) stopGps();
  };
  const fail = e => {
    if (K.state === 'ok') return;
    K.state = 'err';
    K.err = e.code === 1 ? 'Izin lokasi ditolak. Aktifkan izin lokasi untuk browser lalu tekan "Coba Lagi".' : e.code === 3 ? 'GPS terlalu lama merespons. Pastikan GPS aktif & coba di area terbuka.' : 'Lokasi tidak tersedia. Aktifkan GPS perangkat.';
    renderGps();
  };
  const wid = K.watch = navigator.geolocation.watchPosition(ok, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  setTimeout(() => { if (K.watch === wid) stopGps(); }, 45000);   // hemat baterai
}
function stopGps() { if (K.watch !== null && navigator.geolocation) { navigator.geolocation.clearWatch(K.watch); K.watch = null; } }
function renderGps() {
  const box = $('#gpsBox'); if (!box) return;
  if (K.state === 'ok') {
    box.innerHTML = `<div class="gps-card ok"><div class="ico"><i class="bi bi-crosshair"></i></div><div class="flex-grow-1">
      <div class="fw-semibold">Lokasi GPS terkunci</div><div class="small num">${K.lat}, ${K.lng} • akurasi ±${K.acc} m</div></div>
      <button type="button" class="btn btn-sm btn-outline" onclick="startGps()" aria-label="Perbarui lokasi"><i class="bi bi-arrow-repeat"></i></button></div>`;
  } else if (K.state === 'err') {
    box.innerHTML = `<div class="gps-card bad"><div class="ico"><i class="bi bi-geo-alt"></i></div><div class="flex-grow-1">
      <div class="fw-semibold">Lokasi belum aktif — kunjungan tidak bisa dikirim</div><div class="small">${esc(K.err)}</div></div>
      <button type="button" class="btn btn-sm btn-outline" onclick="startGps()">Coba Lagi</button></div>`;
  } else {
    box.innerHTML = `<div class="gps-card warn"><div class="ico"><span class="spinner-border spinner-border-sm"></span></div>
      <div><div class="fw-semibold">Mengambil lokasi GPS…</div><div class="small">Izinkan akses lokasi jika diminta browser.</div></div></div>`;
  }
}
function drawKjMap() {
  if (K.lat === null && !($('#kjToko') && $('#kjToko').value)) { const m = $('#kjMap'); if (m && !MAPS.kj) m.innerHTML = emptyState('bi-map', 'Peta tampil setelah lokasi GPS didapat.'); return; }
  const t = IDX.toko.get($('#kjToko') ? $('#kjToko').value : '');
  const center = K.lat !== null ? [K.lat, K.lng] : [+t.lat || -6.2, +t.lng || 106.8];
  const draw = m => {
    if (!m) return;
    if (m._lyr) m._lyr.clearLayers(); else m._lyr = L.layerGroup().addTo(m);
    const pts = [];
    if (K.lat !== null) { L.marker([K.lat, K.lng], { icon: pinIcon('#4F46E5') }).bindTooltip('Posisi Anda').addTo(m._lyr); L.circle([K.lat, K.lng], { radius: K.acc || 10, color: '#4F46E5', weight: 1, fillOpacity: .08 }).addTo(m._lyr); pts.push([K.lat, K.lng]); }
    if (t && t.lat !== '') { L.marker([+t.lat, +t.lng], { icon: pinIcon('#10B981') }).bindTooltip(t.nama).addTo(m._lyr); L.circle([+t.lat, +t.lng], { radius: S.settings.radius || 150, color: '#10B981', weight: 1, fillOpacity: .06 }).addTo(m._lyr); pts.push([+t.lat, +t.lng]); }
    if (pts.length > 1) m.fitBounds(pts, { padding: [40, 40], maxZoom: 17 }); else if (pts.length) m.setView(pts[0], 16);
  };
  if (MAPS.kj && document.getElementById('kjMap').contains(MAPS.kj.getContainer())) draw(MAPS.kj);
  else { const m = $('#kjMap'); if (m) m.innerHTML = ''; mkMap('kj', 'kjMap', center[0], center[1], 16).then(draw); }
}
function renderKjFotos() {
  const g = $('#kjFotoGrid'); if (!g) return;
  let h = K.fotos.map((f, i) => `<div class="photo-slot"><img src="${f.data}" alt="Foto ${i + 1}">
    <button type="button" class="rm" onclick="removeKjFoto(${i})" aria-label="Hapus foto ${i + 1}"><i class="bi bi-x"></i></button></div>`).join('');
  if (K.fotos.length < 3) h += `<button type="button" class="photo-slot" onclick="$('#kjFile').click()"><i class="bi bi-camera"></i>${K.fotos.length ? 'Tambah' : 'Ambil Foto'}</button>`;
  for (let i = K.fotos.length + 1; i < 3; i++) h += `<div class="photo-slot" style="opacity:.4;cursor:default"><i class="bi bi-image"></i></div>`;
  g.innerHTML = h;
}
function removeKjFoto(i) { K.fotos.splice(i, 1); renderKjFotos(); }
async function onKjFoto(e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('File harus berupa gambar.', 'warn');
  try {
    const t = IDX.toko.get($('#kjToko').value);
    const stamp = [`${fmtDate(today())} ${nowTime()} WIB`, K.lat !== null ? `${K.lat}, ${K.lng} (±${K.acc}m)` : 'GPS belum terkunci', t ? `${t.nama} • ${S.user.nama}` : S.user.nama];
    const data = await compressImage(file, 1280, 0.72, stamp);
    K.fotos.push({ data, mime: 'image/jpeg' });
    renderKjFotos();
  } catch (err) { toast(err.message, 'bad', 'Foto gagal diproses'); }
}
/** Kompres foto di perangkat (hemat kuota & Drive) + cap waktu/GPS. */
function compressImage(file, max, q, stampLines) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, c.width, c.height);
      if (stampLines) {
        const fs = Math.max(14, Math.round(c.width / 48)), pad = fs * .6, lh = fs * 1.35;
        const h = stampLines.length * lh + pad * 2;
        x.fillStyle = 'rgba(15,23,42,.62)'; x.fillRect(0, c.height - h, c.width, h);
        x.fillStyle = '#fff'; x.font = `600 ${fs}px Inter, Arial, sans-serif`; x.textBaseline = 'top';
        stampLines.forEach((l, i) => x.fillText(l, pad, c.height - h + pad + i * lh));
      }
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gambar tidak dapat dibaca.')); };
    img.src = url;
  });
}
function submitKunjungan(ev) {
  ev.preventDefault();
  const err = [];
  const idToko = $('#kjToko').value, hasil = ($('input[name="kjHasil"]:checked') || {}).value;
  const idSales = isMgr() ? $('#kjSales').value : S.user.idSalesman;
  if (K.state !== 'ok') err.push('Lokasi GPS belum aktif.');
  if (isMgr() && !idSales) err.push('Pilih salesman.');
  if (!idToko) err.push('Pilih toko.');
  if (!K.fotos.length) err.push('Ambil minimal 1 foto kunjungan.');
  if (!hasil) err.push('Pilih hasil kunjungan.');
  $('#kjToko').classList.toggle('is-invalid', !idToko);
  $('#kjErr').innerHTML = err.map(e => `<div><i class="bi bi-exclamation-circle"></i> ${esc(e)}</div>`).join('');
  if (err.length) return;

  const t = IDX.toko.get(idToko), r = S.settings.radius || 150;
  const jarak = t.lat !== '' ? haversine(K.lat, K.lng, +t.lat, +t.lng) : '';
  const id = rid('KJ');
  const catatan = $('#kjCatatan').value.trim();
  const rec = { id, tanggal: today(), waktu: nowTime(), idSalesman: idSales, idToko, lat: K.lat, lng: K.lng, akurasi: K.acc,
    jarak, gps: jarak === '' ? 'Pin toko belum ada' : jarak <= r ? 'Terverifikasi' : 'Di luar radius',
    fotoIds: '', catatan, hasil, _local: K.fotos.map(f => f.data) };
  const payload = { id, idToko, idSalesman: idSales, lat: K.lat, lng: K.lng, akurasi: K.acc, hasil, catatan, fotos: K.fotos.slice() };
  stopGps();
  obAdd('kunjungan', rec, payload);                      // ← UI langsung terupdate
  toast(`Kunjungan ${t.nama} tercatat. Foto dikirim di latar belakang.`, 'ok', 'Check-in berhasil');
  if (String(hasil).startsWith('Order')) navigateTo('omset', { idToko, jenis: hasil === 'Order Part Furniture' ? 'Part Furniture' : 'Part Teknik', idSales });
  else navigateTo(isSales() ? 'riwayat' : 'dashboard');
}

// ── 7.3 FORM OMSET HARIAN ──────────────────────────────────
PAGES.omset = (el, params, fresh) => {
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    const t = today();
    const lastVisit = S.kunjungan.filter(k => k.tanggal === t && (!isSales() || k.idSalesman === S.user.idSalesman)).sort((a, b) => b.waktu.localeCompare(a.waktu))[0];
    const defToko = params.idToko || (lastVisit ? lastVisit.idToko : '');
    const tl = S.toko.filter(x => x.status !== 'Nonaktif').sort((a, b) => a.nama.localeCompare(b.nama));
    el.innerHTML = pageHead('<i class="bi bi-cash-coin"></i> Pencatatan penjualan', 'Catat Omset Harian',
      'Catat nilai order per toko & jenis produk. Data langsung masuk ke ringkasan kinerja.') + `
    <div class="row g-3"><div class="col-lg-6">
      <form id="formOm" class="card-x card-pad" novalidate onsubmit="submitOmset(event)">
        ${params.idToko ? `<div class="callout mb-3"><i class="bi bi-check2-circle"></i><div>Kunjungan ke <b>${esc(tokoOf(params.idToko).nama)}</b> tercatat. Lanjutkan dengan mencatat nilai order.</div></div>` : ''}
        ${isMgr() ? `<div class="mb-3"><label class="form-label" for="omSales">Salesman <span class="req">*</span></label>
          <select class="form-select" id="omSales" required>${selectOptions(activeSales().map(s => [s.id, s.nama]), params.idSales || '', 'Pilih salesman…')}</select></div>` : ''}
        <div class="row g-3 mb-3">
          <div class="col-sm-5"><label class="form-label" for="omTgl">Tanggal <span class="req">*</span></label>
            <input type="date" class="form-control" id="omTgl" value="${t}" max="${t}" ${isSales() ? `min="${addDays(t, -7)}"` : ''} required></div>
          <div class="col-sm-7"><label class="form-label" for="omToko">Toko <span class="req">*</span></label>
            <select class="form-select" id="omToko" required>${selectOptions(tl.map(x => [x.id, `${x.nama} — ${x.kota}`]), defToko, 'Pilih toko…')}</select></div>
        </div>
        <div class="mb-3"><label class="form-label">Jenis produk <span class="req">*</span></label>
          <div class="choice-grid">${(S.lists.jenis || []).map(j => `<label class="choice"><input type="radio" name="omJenis" value="${esc(j)}" ${j === (params.jenis || 'Part Teknik') ? 'checked' : ''}>
            <div class="t"><i class="bi ${j === 'Part Teknik' ? 'bi-gear' : 'bi-lamp'} me-1"></i>${esc(j)}</div></label>`).join('')}</div></div>
        <div class="mb-3"><label class="form-label" for="omNilai">Nilai omset <span class="req">*</span></label>
          <div class="input-rp"><span>Rp</span><input class="form-control num" id="omNilai" inputmode="numeric" autocomplete="off" placeholder="0" required></div>
          <div class="chips mt-2">${[500000, 1000000, 2500000, 5000000].map(v => `<button type="button" class="chip" onclick="addOmNilai(${v})">+${rpShort(v).replace('Rp ', '')}</button>`).join('')}</div></div>
        <div class="mb-4"><label class="form-label" for="omCatatan">Catatan</label>
          <input class="form-control" id="omCatatan" maxlength="500" placeholder="Contoh: SPK #9921, baut M12 50 box"></div>
        <div id="omErr" class="invalid-msg mb-2"></div>
        <button type="submit" class="btn btn-primary btn-xl w-100"><i class="bi bi-save"></i> Simpan Omset</button>
      </form>
    </div>
    <div class="col-lg-6"><div class="card-x" id="omToday"></div></div></div>`;
    bindRpInput($('#omNilai'));
  }
  renderOmToday();
};
function addOmNilai(v) { const i = $('#omNilai'); i.value = NF.format(parseRp(i.value) + v); i.focus(); }
function renderOmToday() {
  const box = $('#omToday'); if (!box) return;
  const t = today();
  const list = S.omset.filter(o => o.tanggal === t && (!isSales() || o.idSalesman === S.user.idSalesman)).sort((a, b) => String(b.dibuat || 'z').localeCompare(String(a.dibuat || 'z')));
  box.innerHTML = `<div class="card-head"><div><h2 class="card-title">Omset Hari Ini</h2><p class="card-sub">${fmtDate(t)}</p></div>
    <div class="text-end"><div class="kpi-label">Total</div><div class="fw-bold fs-5 num">${rp(sum(list, o => o.nilai))}</div></div></div>
    <div class="mt-2">${list.length ? list.map(o => omsetListItem(o, false)).join('') : emptyState('bi-receipt', 'Belum ada omset tercatat hari ini.')}</div>`;
}
function submitOmset(ev) {
  ev.preventDefault();
  const err = [];
  const tanggal = $('#omTgl').value, idToko = $('#omToko').value, nilai = parseRp($('#omNilai').value);
  const jenis = ($('input[name="omJenis"]:checked') || {}).value, idSales = isMgr() ? $('#omSales').value : S.user.idSalesman;
  const t = today();
  if (isMgr() && !idSales) err.push('Pilih salesman.');
  if (!tanggal || tanggal > t) err.push('Tanggal tidak valid (tidak boleh di masa depan).');
  if (isSales() && tanggal < addDays(t, -7)) err.push('Maksimal 7 hari ke belakang.');
  if (!idToko) err.push('Pilih toko.');
  if (!jenis) err.push('Pilih jenis produk.');
  if (!(nilai > 0)) err.push('Nilai omset harus angka positif.');
  $('#omNilai').closest('.input-rp').classList.toggle('is-invalid', !(nilai > 0));
  $('#omErr').innerHTML = err.map(e => `<div><i class="bi bi-exclamation-circle"></i> ${esc(e)}</div>`).join('');
  if (err.length) return;
  const id = rid('OM'), catatan = $('#omCatatan').value.trim();
  const rec = { id, tanggal, idSalesman: idSales, idToko, nilai, jenis, catatan, dibuat: `${t} ${nowTime()}:00` };
  obAdd('omset', rec, { id, tanggal, idSalesman: idSales, idToko, nilai, jenis, catatan });   // ← instan
  toast(`${rp(nilai)} • ${tokoOf(idToko).nama}`, 'ok', 'Omset tersimpan');
  $('#omNilai').value = ''; $('#omCatatan').value = ''; $('#omNilai').focus();
  renderOmToday();
}

// ── 7.4 RIWAYAT SAYA (salesman) ────────────────────────────
PAGES.riwayat = (el, params, fresh) => {
  const f = F.riwayat = F.riwayat || { tab: 'kunjungan', preset: 'bulan', q: '' };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    el.innerHTML = pageHead('<i class="bi bi-clock-history"></i> Data milik Anda', 'Riwayat Saya', 'Daftar kunjungan & omset yang sudah Anda catat.') + `
    <div class="card-x">
      <div class="filters">
        <div class="chips" id="rwTabs"></div>
        <div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="rwQ" placeholder="Cari toko…" value="${esc(f.q)}"></div>
        <select class="form-select w-sel" id="rwPreset">${selectOptions([['hari', 'Hari ini'], ['7', '7 hari terakhir'], ['bulan', 'Bulan ini'], ['lalu', 'Bulan lalu']], f.preset)}</select>
      </div>
      <div id="rwSum" class="px-3 px-md-4 pb-2 small text-2"></div>
      <div id="rwList" class="border-top"></div>
    </div>`;
    $('#rwQ').addEventListener('input', debounce(e => { f.q = e.target.value; rwUpdate(); }, 150));
    $('#rwPreset').addEventListener('change', e => { f.preset = e.target.value; rwUpdate(); });
  }
  rwUpdate();
};
function presetRange(p) {
  const t = today();
  if (p === 'hari') return [t, t];
  if (p === '7') return [addDays(t, -6), t];
  if (p === 'lalu') { const e = prevMonth(t); return [monthStart(e), e]; }
  return [monthStart(t), t];
}
function rwUpdate() {
  const f = F.riwayat, [from, to] = presetRange(f.preset), q = f.q.toLowerCase();
  $('#rwTabs').innerHTML = [['kunjungan', 'Kunjungan'], ['omset', 'Omset']].map(([k, l]) => `<button class="chip ${f.tab === k ? 'active' : ''}" onclick="F.riwayat.tab='${k}';rwUpdate()">${l}</button>`).join('');
  const mine = r => r.tanggal >= from && r.tanggal <= to && (!q || (tokoOf(r.idToko).nama + ' ' + tokoOf(r.idToko).kota).toLowerCase().includes(q));
  const fails = S.outbox.filter(o => o.status === 'failed').length;
  if (f.tab === 'kunjungan') {
    const list = S.kunjungan.filter(mine).sort((a, b) => (b.tanggal + b.waktu).localeCompare(a.tanggal + a.waktu));
    $('#rwSum').innerHTML = `${list.length} kunjungan • ${new Set(list.map(k => k.idToko)).size} toko unik • ${fmtDate(from)} – ${fmtDate(to)}
      ${fails ? ` • <button class="btn btn-sm btn-danger-soft ms-1" onclick="retryOutbox()"><i class="bi bi-arrow-repeat"></i> Kirim ulang ${fails} data</button>` : ''}`;
    $('#rwList').innerHTML = list.length ? list.map(k => visitListItem(k)).join('') : emptyState('bi-geo-alt', 'Tidak ada kunjungan pada periode ini.');
  } else {
    const list = S.omset.filter(mine).sort((a, b) => b.tanggal.localeCompare(a.tanggal) || String(b.dibuat).localeCompare(String(a.dibuat)));
    $('#rwSum').innerHTML = `${list.length} transaksi • total <b class="num">${rp(sum(list, o => o.nilai))}</b> • ${fmtDate(from)} – ${fmtDate(to)}`;
    $('#rwList').innerHTML = list.length ? list.map(o => omsetListItem(o, false)).join('') : emptyState('bi-receipt', 'Tidak ada omset pada periode ini.');
  }
}

// ── Detail kunjungan (modal) — dipakai di banyak halaman ──
function visitDetailHtml(k, withDelete) {
  const tk = tokoOf(k.idToko), ids = String(k.fotoIds || '').split(',').filter(Boolean);
  const local = k._local || [];
  const thumbs = local.length ? local.map((d, i) => `<div class="thumb" onclick="previewPhoto('local:${esc(k.id)}:${i}')"><img src="${d}" alt="Foto ${i + 1}"></div>`).join('')
    : ids.length ? ids.map(id => `<div class="thumb" id="th-${esc(id)}" onclick="previewPhoto('${esc(id)}')">${PHOTO.has(id) ? `<img src="${PHOTO.get(id)}" alt="Foto kunjungan">` : '<span class="spinner-border spinner-border-sm"></span>'}</div>`).join('')
      : `<div class="small text-2">Tidak ada foto (data contoh/impor).</div>`;
  return `
    <div class="d-flex flex-wrap justify-content-between gap-2 mb-3">
      <div><div class="fw-semibold fs-6">${esc(tk.nama)} <span class="code">${esc(k.idToko)}</span></div>
        <div class="small text-2"><i class="bi bi-clock"></i> ${fmtDate(k.tanggal)} • ${esc(k.waktu)} WIB • ${esc(salesOf(k.idSalesman).nama)}</div></div>
      <div class="d-flex flex-wrap gap-1 align-items-start">${gpsPill(k.gps)} ${hasilPill(k.hasil)}</div></div>
    <div class="kpi-label mb-2">Foto verifikasi lapangan</div><div class="thumbs mb-3">${thumbs}</div>
    <div class="kpi-label mb-2 d-flex justify-content-between"><span>Validasi titik koordinat GPS</span>
      <span>${k.jarak !== '' && k.jarak !== undefined ? `Jarak ${k.jarak} m dari pin toko` : ''}</span></div>
    <div id="vdMap" class="map-box sm mb-2"></div>
    <div class="small text-2 mb-3 num">Lat ${esc(k.lat)}, Long ${esc(k.lng)} • akurasi ±${esc(k.akurasi || '-')} m</div>
    <div class="kpi-label mb-2">Catatan lapangan</div>
    <div class="note-box mb-3">${k.catatan ? esc(k.catatan) : '<span class="text-2">Tidak ada catatan.</span>'}</div>
    ${withDelete && !k._pending ? `<div class="danger-zone"><div class="fw-semibold"><i class="bi bi-shield-lock"></i> Area Khusus Manajer</div>
      <div class="small mb-2">Hapus log kunjungan hanya jika terbukti manipulasi data atau duplikasi laporan.</div>
      <button class="btn btn-sm btn-danger-soft w-100" style="background:var(--surface)" onclick="deleteItem('kunjungan','${esc(k.id)}')"><i class="bi bi-trash"></i> Hapus Data Kunjungan Ini</button></div>` : ''}`;
}
function loadVisitExtras(k) {
  String(k.fotoIds || '').split(',').filter(Boolean).forEach(id => {
    if (PHOTO.has(id)) return;
    api('getFoto', id).then(d => { PHOTO.set(id, d); const th = document.getElementById('th-' + id); if (th) th.innerHTML = `<img src="${d}" alt="Foto kunjungan">`; })
      .catch(() => { const th = document.getElementById('th-' + id); if (th) th.innerHTML = '<i class="bi bi-image-alt" title="Foto gagal dimuat"></i>'; });
  });
  const tk = tokoOf(k.idToko);
  if (k.lat === '' || k.lat === undefined) return;
  mkMap('vd', 'vdMap', +k.lat, +k.lng, 16).then(m => {
    if (!m) return;
    const pts = [[+k.lat, +k.lng]];
    L.marker(pts[0], { icon: pinIcon('#4F46E5') }).bindTooltip('Lokasi check-in').addTo(m);
    if (tk.lat !== '' && tk.lat !== undefined) {
      pts.push([+tk.lat, +tk.lng]);
      L.marker(pts[1], { icon: pinIcon('#10B981') }).bindTooltip('Pin toko').addTo(m);
      L.circle(pts[1], { radius: S.settings.radius || 150, color: '#10B981', weight: 1, fillOpacity: .06 }).addTo(m);
      m.fitBounds(pts, { padding: [30, 30], maxZoom: 17 });
    }
  });
}
function showVisit(id) {
  const k = S.kunjungan.find(x => x.id === id); if (!k) return;
  openModal({ title: 'Detail Kunjungan', sub: k.id, body: visitDetailHtml(k, isMgr()), size: 'modal-lg', onShown: () => loadVisitExtras(k) });
}
function previewPhoto(ref) {
  let src = '';
  if (ref.startsWith('local:')) { const [, id, i] = ref.split(':'); const k = S.kunjungan.find(x => x.id === id); src = k && k._local ? k._local[+i] : ''; }
  else src = PHOTO.get(ref) || '';
  if (!src) return toast('Foto masih dimuat…', 'info');
  $('#photoBody').innerHTML = `<img src="${src}" class="img-fluid rounded" alt="Foto kunjungan">`;
  $('#photoDownload').href = src;
  bootstrap.Modal.getOrCreateInstance($('#photoModal')).show();
}

// ── 7.5 PIUTANG JATUH TEMPO ────────────────────────────────
PAGES.piutangJT = (el, params, fresh) => {
  const f = F.pjt = F.pjt || { q: '', top: '', prov: '', sales: '', sort: 'desc' };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    const provs = [...new Set(S.toko.map(t => t.provinsi).filter(Boolean))].sort();
    el.innerHTML = pageHead(`${pill('Penagihan Kritis', 'bad', 1)}`, 'Daftar Piutang Jatuh Tempo',
      'Seluruh faktur toko yang melewati Term of Payment. Prioritaskan penagihan faktur dengan keterlambatan di atas 30 hari.',
      `<button class="btn btn-outline" onclick="exportPjt()"><i class="bi bi-download"></i> Ekspor CSV</button>
       ${isMgr() ? `<button class="btn btn-primary" onclick="runNotif(this)"><i class="bi bi-envelope-paper"></i> Kirim Email Pengingat</button>` : ''}`) + `
    <div class="row g-3 mb-4" id="pjtKpi"></div>
    <div class="card-x mb-4"><div class="filters">
      <div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="pjtQ" placeholder="Cari nama toko atau nomor faktur…" value="${esc(f.q)}"></div>
      <select class="form-select w-sel" id="pjtTop">${selectOptions((S.lists.top || []).map(t => [t, topLabel(t)]), f.top, 'Semua TOP')}</select>
      <select class="form-select w-sel" id="pjtProv">${selectOptions(provs, f.prov, 'Semua Wilayah')}</select>
      <select class="form-select w-sel" id="pjtSales">${selectOptions(S.salesman.map(s => [s.id, s.nama]), f.sales, 'Semua Salesman')}</select>
      <button class="btn btn-outline" onclick="F.pjt={q:'',top:'',prov:'',sales:'',sort:'desc'};navigateTo('piutangJT')"><i class="bi bi-arrow-counterclockwise"></i> Reset</button>
    </div></div>
    <div class="card-x mb-4">
      <div class="card-head"><div class="d-flex gap-3"><div class="kpi-icon" style="background:var(--bad-bg);color:var(--bad-text)"><i class="bi bi-exclamation-triangle"></i></div>
        <div><h2 class="card-title">Matriks Faktur Kritis & Terlambat</h2><p class="card-sub">Urutkan berdasarkan hari keterlambatan</p></div></div>
        <button class="btn btn-sm btn-outline" id="pjtSort"></button></div>
      <div class="tbl-wrap mt-3" id="pjtTbl"></div>
    </div>
    <div class="callout"><i class="bi bi-info-circle"></i><div><b>SOP Penagihan KNS Teknik:</b> Faktur dengan keterlambatan &gt; 30 hari wajib dilampirkan Surat Peringatan Pertama (SP-1) melalui kunjungan langsung salesman lapangan. Ringkasan jatuh tempo dikirim otomatis ke email Manajer & Admin setiap pagi.</div></div>`;
    $('#pjtQ').addEventListener('input', debounce(e => { f.q = e.target.value; pjtUpdate(); }, 150));
    [['pjtTop', 'top'], ['pjtProv', 'prov'], ['pjtSales', 'sales']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => { f[k] = e.target.value; pjtUpdate(); }));
    $('#pjtSort').addEventListener('click', () => { f.sort = f.sort === 'desc' ? 'asc' : 'desc'; pjtUpdate(); });
  }
  pjtUpdate();
};
function pjtFiltered() {
  const f = F.pjt, q = f.q.toLowerCase();
  return overdueRows().filter(p => (!q || (p._toko.nama + ' ' + p.noFaktur + ' ' + p.idToko).toLowerCase().includes(q)) &&
    (!f.top || String(p._toko.top) === f.top) && (!f.prov || p._toko.provinsi === f.prov) && (!f.sales || p._toko.idSalesman === f.sales))
    .sort((a, b) => f.sort === 'desc' ? b._late - a._late : a._late - b._late);
}
function pjtUpdate() {
  const all = overdueRows(), list = pjtFiltered(), krit = all.filter(p => p._late > 30);
  const tot = sum(all, p => p._sisa), toko = new Set(all.map(p => p.idToko));
  const hariIni = piutangRows().filter(p => p._sisa > 0 && p._late === 0);
  $('#pjtKpi').innerHTML = `
    <div class="col-md-4">${kpi({ label: 'Total Piutang Jatuh Tempo', value: rp(tot), badge: pill('Perlu Tindakan', 'bad'),
      meta: `${all.length} faktur dari ${toko.size} toko${hariIni.length ? ` • ${hariIni.length} faktur jatuh tempo hari ini` : ''}`, bar: 100, barCls: 'bad' })}</div>
    <div class="col-md-4">${kpi({ label: 'Jumlah Toko Menunggak', value: `${toko.size} <small>toko offline</small>`,
      badge: pill(`${new Set(all.map(p => p._toko.provinsi)).size} provinsi`, 'pri'),
      meta: `Rata-rata keterlambatan: <b>${all.length ? (sum(all, p => p._late) / all.length).toFixed(1).replace('.', ',') : 0} hari</b>`, bar: pct(toko.size, S.toko.length) })}</div>
    <div class="col-md-4">${kpi({ label: 'Keterlambatan Kritis (> 30 Hari)', value: `${rp(sum(krit, p => p._sisa))} <small>(${krit.length} faktur)</small>`, cls: 'kpi-bad',
      badge: pill('Prioritas Tinggi', 'bad'), meta: `Wajib SP-1 • ${pct(sum(krit, p => p._sisa), tot)}% dari total overdue`, bar: pct(sum(krit, p => p._sisa), tot), barCls: 'bad' })}</div>`;
  $('#pjtSort').innerHTML = `<i class="bi bi-sort-${F.pjt.sort === 'desc' ? 'down' : 'up'}"></i> Keterlambatan ${F.pjt.sort === 'desc' ? 'terlama' : 'terbaru'}`;
  $('#pjtTbl').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Toko & ID</th><th>Kota / Daerah</th><th>Salesman PJ</th><th>No. Faktur</th>
    <th>Tgl Faktur</th><th>TOP</th><th>Jatuh Tempo</th><th class="n">Sisa Piutang</th><th>Keterlambatan</th><th class="text-end">Aksi</th></tr></thead><tbody>
    ${list.map(p => `<tr class="${p._late > 30 ? 'row-bad' : ''}">
      <td><div class="cell-main"><span style="color:${p._late > 30 ? 'var(--bad)' : 'var(--warn)'}">●</span> ${esc(p._toko.nama)}</div><div class="cell-sub">${esc(p.idToko)}</div></td>
      <td><div>${esc(p._toko.kota)}</div><div class="cell-sub">${esc(p._toko.provinsi)}</div></td>
      <td><i class="bi bi-person text-2"></i> ${esc(p._sales.nama)}</td>
      <td class="text-primary-x fw-semibold">${esc(p.noFaktur)}</td>
      <td class="num">${fmtDate(p.tglFaktur)}</td><td>${pill(topLabel(p._toko.top), p._toko.top === 'Tunai' ? 'ok' : 'pri')}</td>
      <td class="num ${p._late > 30 ? 'text-bad fw-semibold' : ''}">${fmtDate(p.jatuhTempo)}</td>
      <td class="n num ${p._late > 30 ? 'text-bad fw-bold' : 'fw-semibold'}">${rp(p._sisa)}</td><td>${lateBadge(p._late)}</td>
      <td class="text-end text-nowrap">${waLink(p._toko.kontak) ? `<a class="btn btn-sm btn-ok-soft" target="_blank" rel="noopener" aria-label="WhatsApp ${esc(p._toko.pic)}"
        href="${esc(waLink(p._toko.kontak, `Halo ${p._toko.pic || ''}, kami dari KNS Teknik ingin mengingatkan faktur ${p.noFaktur} senilai ${rp(p._sisa)} telah jatuh tempo sejak ${fmtDate(p.jatuhTempo)}. Mohon konfirmasi rencana pembayarannya. Terima kasih.`))}"><i class="bi bi-whatsapp"></i></a>` : ''}
        <button class="btn btn-sm btn-primary" onclick="openBayar('${esc(p.id)}')"><i class="bi bi-cash"></i> Bayar</button></td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="7">Menampilkan ${list.length} dari ${all.length} faktur jatuh tempo</td><td class="n num text-bad">${rp(sum(list, p => p._sisa))}</td><td colspan="2"></td></tr></tfoot></table>`
    : emptyState('bi-check2-circle', all.length ? 'Tidak ada faktur yang cocok dengan filter.' : 'Tidak ada piutang jatuh tempo. Semua tagihan dalam batas TOP.');
}
function exportPjt() {
  downloadCsv(`piutang-jatuh-tempo-${today()}.csv`, [['ID Toko', 'Toko', 'Kota', 'Provinsi', 'Salesman', 'No Faktur', 'Tgl Faktur', 'TOP', 'Jatuh Tempo', 'Sisa', 'Hari Terlambat']]
    .concat(pjtFiltered().map(p => [p.idToko, p._toko.nama, p._toko.kota, p._toko.provinsi, p._sales.nama, p.noFaktur, p.tglFaktur, topLabel(p._toko.top), p.jatuhTempo, p._sisa, p._late])));
}
async function runNotif(btn) {
  if (!await confirmBox({ title: 'Kirim email ringkasan sekarang?', msg: 'Email ringkasan piutang jatuh tempo akan dikirim ke semua penerima notifikasi.', ok: 'Kirim', icon: 'bi-envelope' })) return;
  const done = busy(btn, 'Mengirim…');
  try { const r = await api('runNotifikasiNow'); toast(r.message, r.sent ? 'ok' : 'info', r.sent ? 'Email terkirim' : 'Tidak ada yang dikirim'); }
  catch (e) { e.type !== 'auth' && toast(e.message, 'bad', 'Gagal mengirim'); } finally { done(); }
}

// ── 7.6 RINGKASAN KINERJA ──────────────────────────────────
PAGES.kinerja = (el, params, fresh) => {
  const t = today();
  const f = F.kin = F.kin || { from: monthStart(t), to: t, sales: '', jenis: '', prov: '', q: '' };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    const provs = [...new Set(S.toko.map(x => x.provinsi).filter(Boolean))].sort();
    el.innerHTML = pageHead(`${pill('Evaluasi Kinerja', 'pri')}`, 'Ringkasan Kinerja Tim Sales',
      'Analisis kunjungan lapangan, pencapaian target omset, dan perbandingan Part Teknik vs Part Furniture.',
      `<button class="btn btn-outline" onclick="exportKinerja()"><i class="bi bi-download"></i> Unduh CSV</button>
       <button class="btn btn-primary" onclick="window.print()"><i class="bi bi-printer"></i> Cetak PDF</button>`) + `
    <div class="card-x mb-4"><div class="filters">
      <div class="d-flex gap-2 align-items-center flex-wrap grow">
        <input type="date" class="form-control" style="max-width:160px" id="kinFrom" value="${f.from}" max="${t}" aria-label="Dari tanggal">
        <span class="text-2">s/d</span>
        <input type="date" class="form-control" style="max-width:160px" id="kinTo" value="${f.to}" max="${t}" aria-label="Sampai tanggal">
        <div class="chips">${[['hari', 'Hari ini'], ['7', '7 Hari'], ['bulan', 'Bulan Ini'], ['lalu', 'Bulan Lalu']].map(([k, l]) => `<button class="chip" onclick="kinPreset('${k}')">${l}</button>`).join('')}</div>
      </div>
      <select class="form-select w-sel" id="kinSales">${selectOptions(S.salesman.map(s => [s.id, s.nama]), f.sales, `Semua Salesman (${S.salesman.length})`)}</select>
      <select class="form-select w-sel" id="kinJenis">${selectOptions(S.lists.jenis || [], f.jenis, 'Semua Kategori')}</select>
      <select class="form-select w-sel" id="kinProv">${selectOptions(provs, f.prov, `Semua Wilayah (${provs.length})`)}</select>
    </div><div class="px-3 px-md-4 pb-3 small text-2" id="kinInfo"></div></div>
    <div id="kinBody"></div>`;
    const set = (k, v) => { f[k] = v; kinUpdate(); };
    $('#kinFrom').addEventListener('change', e => { if (e.target.value) set('from', e.target.value); });
    $('#kinTo').addEventListener('change', e => { if (e.target.value) set('to', e.target.value); });
    [['kinSales', 'sales'], ['kinJenis', 'jenis'], ['kinProv', 'prov']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => set(k, e.target.value)));
  }
  kinUpdate();
};
function kinPreset(p) { const [a, b] = presetRange(p); F.kin.from = a; F.kin.to = b; $('#kinFrom').value = a; $('#kinTo').value = b; kinUpdate(); }
/** Pastikan data rentang lama sudah dimuat; ambil dari server bila belum. */
async function ensureRange(from) {
  if (from >= S.loaded.from) return true;
  const end = addDays(S.loaded.from, -1);
  setSyncPill('busy', 'Memuat data lama…');
  try {
    const d = await api('fetchActivity', from, end);
    const add = (k, rows) => { const ids = new Set(S[k].map(r => r.id)); rows.forEach(r => { if (!ids.has(r.id)) S[k].push(r); }); };
    add('kunjungan', d.kunjungan); add('omset', d.omset);
    S.loaded.from = from; setSyncPill('ok'); return true;
  } catch (e) { setSyncPill('ok'); e.type !== 'auth' && toast(e.message, 'bad', 'Gagal memuat data periode lama'); return false; }
}
async function kinUpdate() {
  const f = F.kin;
  if (f.from > f.to) { const x = f.from; f.from = f.to; f.to = x; $('#kinFrom').value = f.from; $('#kinTo').value = f.to; }
  if (f.from < S.loaded.from) {
    $('#kinBody').innerHTML = `<div class="card-x card-pad"><div class="skel" style="height:240px"></div></div>`;
    if (!await ensureRange(f.from)) return;
  }
  const st = salesStats(f.from, f.to, f);
  const tot = sum(st.list, r => r.omset), tgt = sum(st.list, r => r.target);
  const tek = sum(st.list, r => r.teknik), fur = sum(st.list, r => r.furniture);
  $('#kinInfo').innerHTML = `<span class="pill pill-ok"><span class="d"></span>Data lokal</span> Periode <b>${fmtDate(f.from)} – ${fmtDate(f.to)}</b> (${diffDays(f.from, f.to) + 1} hari) • Sumber: Google Sheets DB KNS Teknik • Sinkron terakhir ${new Date(S.lastSync).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
  $('#kinBody').innerHTML = `
  <div class="row g-3 mb-4">
    <div class="col-xl-4"><div class="card-x card-pad h-100">
      <div class="d-flex justify-content-between"><div class="kpi-label">Komparasi Salesman</div>${pill(`${pct(tot, tgt)}% target tim`, 'pri')}</div>
      <h2 class="card-title mt-1">Total Omset per Salesman</h2><p class="card-sub mb-3">Benchmark terhadap target periode (${rpShort(tgt)})</p>
      <div class="d-flex flex-column gap-3">${st.list.map(r => `<div role="button" onclick="navigateTo('detailSales',{id:'${esc(r.s.id)}'})">
        <div class="d-flex justify-content-between small mb-1"><b>${esc(r.s.nama)}</b><span class="num"><b>${rp(r.omset)}</b> <span class="${r.pct >= 90 ? 'text-ok' : r.pct < 60 ? 'text-bad' : 'text-primary-x'}">(${r.pct}%)</span></span></div>
        <div class="bar ${r.pct >= 100 ? 'ok' : ''}" style="height:10px"><span style="width:${Math.min(100, r.pct)}%"></span></div></div>`).join('') || emptyState('bi-people', 'Tidak ada data.')}</div>
    </div></div>
    <div class="col-xl-5"><div class="card-x card-pad h-100">
      <div class="kpi-label">Trajektori Harian</div><h2 class="card-title mt-1">Tren Omset Harian Tim</h2>
      <p class="card-sub mb-2">Akumulasi <b class="num">${rp(tot)}</b> • rata-rata ${rpShort(tot / (diffDays(f.from, f.to) + 1))}/hari</p>
      <div class="legend mb-2"><span><i style="background:var(--primary)"></i>Part Teknik</span><span><i style="background:var(--furn)"></i>Part Furniture</span></div>
      <div class="chart-box sm"><canvas id="cvKinTrend" aria-label="Grafik tren omset"></canvas></div>
    </div></div>
    <div class="col-xl-3"><div class="card-x card-pad h-100">
      <div class="kpi-label">Mix Penjualan</div><h2 class="card-title mt-1">Proporsi Kategori</h2>
      <div class="chart-box sm my-2"><canvas id="cvKinMix" aria-label="Grafik proporsi kategori"></canvas></div>
      <div class="d-flex justify-content-between small"><span><i class="bi bi-square-fill text-primary-x"></i> Part Teknik (${pct(tek, tot)}%)</span><b class="num">${rpShort(tek)}</b></div>
      <div class="d-flex justify-content-between small mt-1"><span><i class="bi bi-square-fill" style="color:var(--furn)"></i> Part Furniture (${pct(fur, tot)}%)</span><b class="num">${rpShort(fur)}</b></div>
    </div></div>
  </div>
  <div class="card-x">
    <div class="filters"><div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="kinQ" placeholder="Cari nama salesman atau wilayah…" value="${esc(f.q)}"></div></div>
    <div class="tbl-wrap" id="kinTbl"></div>
  </div>`;
  const q = $('#kinQ');
  q.addEventListener('input', debounce(() => { f.q = q.value; kinTable(st); }, 120));
  kinTable(st);
  trendChart('kinTrend', 'cvKinTrend', f.from, f.to, st.om);
  mkChart('kinMix', 'cvKinMix', {
    type: 'doughnut',
    data: { labels: ['Part Teknik', 'Part Furniture'], datasets: [{ data: [tek, fur], backgroundColor: [cssVar('--primary'), cssVar('--furn')], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.label}: ${rp(c.parsed)}` } } } }
  });
}
function kinTable(st) {
  const q = (F.kin.q || '').toLowerCase();
  const list = st.list.filter(r => !q || (r.s.nama + ' ' + r.s.wilayah + ' ' + r.s.id).toLowerCase().includes(q));
  const T = k => sum(list, r => r[k]);
  $('#kinTbl').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>Salesman & ID</th><th>Wilayah Tugas</th><th class="n">Kunjungan</th><th class="n">Toko Unik</th>
    <th class="n">Total Omset</th><th class="n">Part Teknik</th><th class="n">Part Furniture</th><th class="n">% Target</th><th class="n">GPS Valid</th><th></th></tr></thead><tbody>
    ${list.map(r => `<tr class="clickable" onclick="navigateTo('detailSales',{id:'${esc(r.s.id)}'})">
      <td><div class="d-flex align-items-center gap-2"><div class="avatar">${esc(initials(r.s.nama))}</div><div><div class="cell-main">${esc(r.s.nama)}</div><div class="cell-sub">${esc(r.s.id)}</div></div></div></td>
      <td><i class="bi bi-cursor text-2"></i> ${esc(r.s.wilayah)}</td>
      <td class="n num">${r.kunjungan} <span class="cell-sub">/ ${r.targetKj}</span></td><td class="n num">${r.tokoUnik}</td>
      <td class="n num fw-bold">${rp(r.omset)}</td><td class="n num text-primary-x">${rp(r.teknik)}</td><td class="n num" style="color:var(--furn)">${rp(r.furniture)}</td>
      <td class="n">${pill(r.pct + '%', r.pct >= 90 ? 'ok' : r.pct >= 60 ? 'warn' : 'bad')}</td>
      <td class="n num">${pct(r.gpsOk, r.kunjungan)}%</td><td class="text-end"><i class="bi bi-chevron-right text-2"></i></td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2"><i class="bi bi-people"></i> TOTAL TIM (${list.length} SALESMAN)</td><td class="n num">${T('kunjungan')}</td>
      <td class="n num">${new Set(st.kj.filter(k => list.some(r => r.s.id === k.idSalesman)).map(k => k.idToko)).size}</td>
      <td class="n num text-primary-x">${rp(T('omset'))}</td><td class="n num">${rp(T('teknik'))}</td><td class="n num">${rp(T('furniture'))}</td>
      <td class="n">${pct(T('omset'), T('target'))}%</td><td class="n num">${pct(T('gpsOk'), T('kunjungan'))}%</td><td></td></tr></tfoot></table>`
    : emptyState('bi-search', 'Tidak ada salesman yang cocok.');
}
function exportKinerja() {
  const f = F.kin, st = salesStats(f.from, f.to, f);
  downloadCsv(`ringkasan-kinerja-${f.from}_${f.to}.csv`, [['ID', 'Salesman', 'Wilayah', 'Kunjungan', 'Toko Unik', 'Total Omset', 'Part Teknik', 'Part Furniture', 'Target', '% Target', 'GPS Valid']]
    .concat(st.list.map(r => [r.s.id, r.s.nama, r.s.wilayah, r.kunjungan, r.tokoUnik, r.omset, r.teknik, r.furniture, r.target, r.pct, r.gpsOk])));
}

// ── 7.7 DETAIL KUNJUNGAN SALESMAN ──────────────────────────
PAGES.detailSales = (el, params, fresh) => {
  const s = IDX.sales.get(params.id);
  if (!s) { el.innerHTML = emptyState('bi-person-x', 'Salesman tidak ditemukan.'); return; }
  const t = today();
  const f = F.ds = (F.ds && F.ds.id === s.id) ? F.ds : { id: s.id, from: (F.kin && F.kin.from) || monthStart(t), to: (F.kin && F.kin.to) || t, q: '', tab: 'kunjungan', page: 1, sel: null };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    el.innerHTML = `<button class="btn btn-ghost btn-sm mb-2 px-0" onclick="navigateTo('kinerja')"><i class="bi bi-arrow-left"></i> Kembali ke Ringkasan Kinerja</button>` +
      pageHead('', `Detail Log Kunjungan — ${esc(s.nama)}`,
        `${pill(s.status === 'Nonaktif' ? 'Nonaktif' : 'Aktif Lapangan', s.status === 'Nonaktif' ? 'neu' : 'pri')} &nbsp;ID: <b>${esc(s.id)}</b> • Wilayah: ${esc(s.wilayah)}`,
        `<button class="btn btn-primary" onclick="exportDs()"><i class="bi bi-download"></i> Ekspor Log (.CSV)</button>`) + `
      <div class="row g-3 mb-4" id="dsKpi"></div>
      <div class="row g-3"><div class="col-lg-7"><div class="card-x">
        <div class="filters">
          <div class="chips" id="dsTabs"></div>
          <div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="dsQ" placeholder="Cari toko, kode, kota…" value="${esc(f.q)}"></div>
          <input type="date" class="form-control" style="max-width:150px" id="dsFrom" value="${f.from}" aria-label="Dari">
          <input type="date" class="form-control" style="max-width:150px" id="dsTo" value="${f.to}" aria-label="Sampai">
        </div>
        <div id="dsList" class="border-top"></div>
        <div class="card-foot" id="dsFoot"></div>
      </div></div>
      <div class="col-lg-5"><div class="card-x card-pad" id="dsPanel"></div></div></div>`;
    $('#dsQ').addEventListener('input', debounce(e => { f.q = e.target.value; f.page = 1; dsUpdate(); }, 150));
    $('#dsFrom').addEventListener('change', async e => { f.from = e.target.value || f.from; f.page = 1; if (await ensureRange(f.from)) dsUpdate(); });
    $('#dsTo').addEventListener('change', e => { f.to = e.target.value || f.to; f.page = 1; dsUpdate(); });
  }
  dsUpdate();
};
function dsData() {
  const f = F.ds, q = f.q.toLowerCase();
  const m = r => r.idSalesman === f.id && r.tanggal >= f.from && r.tanggal <= f.to &&
    (!q || (tokoOf(r.idToko).nama + ' ' + r.idToko + ' ' + tokoOf(r.idToko).kota).toLowerCase().includes(q));
  return {
    kj: S.kunjungan.filter(m).sort((a, b) => (b.tanggal + b.waktu).localeCompare(a.tanggal + a.waktu)),
    om: S.omset.filter(m).sort((a, b) => b.tanggal.localeCompare(a.tanggal))
  };
}
function dsUpdate() {
  const f = F.ds, s = IDX.sales.get(f.id), { kj, om } = dsData();
  const tf = targetFactor(f.from, f.to), tK = Math.round(targetKjOf(s) * tf), totO = sum(om, o => o.nilai);
  const ok = kj.filter(k => k.gps === 'Terverifikasi').length;
  $('#dsKpi').innerHTML = `
    <div class="col-md-4">${kpi({ label: 'Total Kunjungan', value: `${kj.length} <small>toko</small>`, icon: 'bi-shop', bar: pct(kj.length, tK), meta: `Target: ${tK} kunjungan • <b class="text-primary-x">${pct(kj.length, tK)}% tercapai</b>` })}</div>
    <div class="col-md-4">${kpi({ label: 'Total Omset Tercatat', value: rp(totO), icon: 'bi-cash-stack', meta: `Rata-rata: <b>${rp(new Set(om.map(o => o.idToko)).size ? totO / new Set(om.map(o => o.idToko)).size : 0)}</b> / toko` })}</div>
    <div class="col-md-4">${kpi({ label: 'Integritas Geotagging GPS', value: `${pct(ok, kj.length)}% ${pct(ok, kj.length) >= 95 ? pill('VALID', 'ok') : ''}`, icon: 'bi-shield-check',
      meta: `Radius ≤ ${S.settings.radius || 150} m: <b class="text-ok">${ok} / ${kj.length}</b> kunjungan` })}</div>`;
  $('#dsTabs').innerHTML = [['kunjungan', `Kunjungan (${kj.length})`], ['omset', `Omset (${om.length})`]].map(([k, l]) =>
    `<button class="chip ${f.tab === k ? 'active' : ''}" onclick="F.ds.tab='${k}';F.ds.page=1;dsUpdate()">${l}</button>`).join('');
  const per = 8, list = f.tab === 'kunjungan' ? kj : om, pages = Math.ceil(list.length / per) || 1;
  f.page = Math.min(f.page, pages);
  const slice = list.slice((f.page - 1) * per, f.page * per);
  if (f.tab === 'kunjungan') {
    if (!f.sel || !kj.some(k => k.id === f.sel)) f.sel = kj[0] ? kj[0].id : null;
    $('#dsList').innerHTML = slice.length ? slice.map(k => visitListItem(k, k.id === f.sel).replace(`showVisit('${esc(k.id)}')`, `dsSelect('${esc(k.id)}')`)).join('') : emptyState('bi-geo-alt', 'Tidak ada kunjungan pada periode ini.');
  } else {
    $('#dsList').innerHTML = slice.length ? slice.map(o => omsetListItem(o, isMgr())).join('') : emptyState('bi-receipt', 'Tidak ada omset pada periode ini.');
  }
  $('#dsFoot').innerHTML = `<span>Menampilkan ${list.length ? (f.page - 1) * per + 1 : 0}–${Math.min(f.page * per, list.length)} dari ${list.length}</span>${pagerHtml(list.length, f.page, per, 'dsPage')}`;
  dsPanel();
}
function dsPage(p) { F.ds.page = p; dsUpdate(); }
function dsSelect(id) {
  F.ds.sel = id;
  $$('#dsList .list-item').forEach(x => x.classList.toggle('sel', x.getAttribute('onclick') === `dsSelect('${id}')`));
  dsPanel();
  if (window.innerWidth < 992) $('#dsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function dsPanel() {
  const p = $('#dsPanel'), k = S.kunjungan.find(x => x.id === F.ds.sel);
  if (!k) { p.innerHTML = emptyState('bi-hand-index', 'Pilih kunjungan untuk melihat foto, peta, dan catatan.'); destroyMap('vd'); return; }
  p.innerHTML = visitDetailHtml(k, isMgr());
  loadVisitExtras(k);
}
function exportDs() {
  const { kj } = dsData(), s = IDX.sales.get(F.ds.id);
  downloadCsv(`log-kunjungan-${s.id}-${F.ds.from}_${F.ds.to}.csv`, [['ID', 'Tanggal', 'Waktu', 'ID Toko', 'Toko', 'Kota', 'Lat', 'Lng', 'Jarak (m)', 'Status GPS', 'Hasil', 'Catatan', 'Link Foto']]
    .concat(kj.map(k => [k.id, k.tanggal, k.waktu, k.idToko, tokoOf(k.idToko).nama, tokoOf(k.idToko).kota, k.lat, k.lng, k.jarak, k.gps, k.hasil, k.catatan, String(k.fotoUrls || '').replace(/\n/g, ' ')])));
}

// ── Hapus data (Manajer) — optimistic dengan rollback ──
async function deleteItem(kind, id) {
  if (!isMgr()) return;
  const label = { kunjungan: 'data kunjungan', omset: 'data omset', piutang: 'faktur piutang beserta riwayat pembayarannya', pembayaran: 'catatan pembayaran' }[kind];
  if (!await confirmBox({ title: 'Hapus data?', msg: `Anda akan menghapus ${label} (${id}). Tindakan ini tidak dapat dibatalkan.`, ok: 'Ya, Hapus', icon: 'bi-trash' })) return;
  const key = { kunjungan: 'kunjungan', omset: 'omset', piutang: 'piutang', pembayaran: 'pembayaran' }[kind];
  const backup = { [key]: S[key].slice(), pembayaran: S.pembayaran.slice(), piutang: S.piutang.slice() };
  S[key] = S[key].filter(r => r.id !== id);                      // ← UI langsung berubah
  if (kind === 'piutang') S.pembayaran = S.pembayaran.filter(b => b.idPiutang !== id);
  closeModal(); renderNav(); renderPage(false);
  try {
    const r = await api('deleteData', kind, id);
    if (r.piutang) { const i = S.piutang.findIndex(p => p.id === r.piutang.id); if (i >= 0) S.piutang[i] = r.piutang; }
    toast('Data berhasil dihapus.', 'ok');
  } catch (e) {
    Object.assign(S, backup); e.type !== 'auth' && toast(e.message, 'bad', 'Gagal menghapus — data dikembalikan');
  }
  renderNav(); renderPage(false);
}

// ── 7.8 DATA TOKO MITRA ────────────────────────────────────
PAGES.toko = (el, params, fresh) => {
  const f = F.toko = F.toko || { q: '', prov: '', top: '', status: '', page: 1 };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    const provs = [...new Set(S.toko.map(t => t.provinsi).filter(Boolean))].sort();
    el.innerHTML = pageHead('<i class="bi bi-database"></i> Database master toko mitra', 'Data Toko Mitra',
      'Kelola direktori toko mitra teknik & furniture offline, ketentuan pembayaran (TOP), dan pin koordinat peta.',
      `<button class="btn btn-outline" onclick="exportToko()"><i class="bi bi-download"></i> Ekspor CSV</button>
       <button class="btn btn-outline" onclick="openImportToko()"><i class="bi bi-upload"></i> Impor Data Toko</button>
       <button class="btn btn-primary" onclick="openTokoForm()"><i class="bi bi-plus-circle"></i> Tambah Toko Baru</button>`) + `
    <div class="row g-3 mb-4" id="tkKpi"></div>
    <div class="card-x">
      <div class="card-head"><div><h2 class="card-title">Direktori Toko Mitra Offline</h2><p class="card-sub">Data master wilayah operasional dengan verifikasi koordinat lokasi</p></div></div>
      <div class="filters">
        <div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="tkQ" placeholder="Cari nama toko, PIC, alamat…" value="${esc(f.q)}"></div>
        <select class="form-select w-sel" id="tkProv">${selectOptions(provs, f.prov, `Semua Provinsi (${provs.length})`)}</select>
        <select class="form-select w-sel" id="tkTop">${selectOptions((S.lists.top || []).map(t => [t, topLabel(t)]), f.top, 'Term of Payment')}</select>
        <select class="form-select w-sel" id="tkStatus">${selectOptions(['Aktif', 'Perlu Verifikasi', 'Nonaktif'], f.status, 'Status Toko')}</select>
      </div>
      <div class="tbl-wrap" id="tkTbl"></div><div class="card-foot" id="tkFoot"></div>
    </div>`;
    $('#tkQ').addEventListener('input', debounce(e => { f.q = e.target.value; f.page = 1; tkUpdate(); }, 150));
    [['tkProv', 'prov'], ['tkTop', 'top'], ['tkStatus', 'status']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => { f[k] = e.target.value; f.page = 1; tkUpdate(); }));
  }
  tkUpdate();
};
function tkFiltered() {
  const f = F.toko, q = f.q.toLowerCase();
  return S.toko.filter(t => (!q || [t.nama, t.pic, t.alamat, t.kota, t.id].join(' ').toLowerCase().includes(q)) &&
    (!f.prov || t.provinsi === f.prov) && (!f.top || String(t.top) === f.top) && (!f.status || (t.status || 'Aktif') === f.status))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function tkUpdate() {
  const f = F.toko, all = S.toko, list = tkFiltered(), per = 10;
  const aktif = all.filter(t => t.status !== 'Nonaktif'), geo = all.filter(t => t.lat !== '' && t.lng !== '');
  const tops = aktif.map(t => topDays(t.top));
  $('#tkKpi').innerHTML = `
    <div class="col-6 col-xl-3">${kpi({ label: 'Total Toko Mitra', value: `${all.length} <small>toko</small>`, icon: 'bi-shop', meta: `Tersebar di ${new Set(all.map(t => t.provinsi)).size} provinsi` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Status Toko Aktif', value: `${aktif.length} ${pill(pct(aktif.length, all.length) + '%', 'ok')}`, icon: 'bi-check-circle',
      meta: all.filter(t => t.status === 'Perlu Verifikasi').length ? `<span class="text-bad"><i class="bi bi-exclamation-triangle"></i> ${all.filter(t => t.status === 'Perlu Verifikasi').length} toko perlu verifikasi ulang</span>` : `${all.length - aktif.length} toko nonaktif` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Rata-rata TOP', value: `${tops.length ? (sum(tops) / tops.length).toFixed(1).replace('.', ',') : 0} <small>hari</small>`, icon: 'bi-clock', meta: 'Rentang: Tunai, 30, 45, 60 hari' })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Titik Geotag Valid', value: `${pct(geo.length, all.length)}%`, icon: 'bi-geo-alt', meta: geo.length === all.length ? 'Semua toko memiliki koordinat pin peta' : `${all.length - geo.length} toko belum punya pin peta` })}</div>`;
  const pages = Math.ceil(list.length / per) || 1; f.page = Math.min(f.page, pages);
  const slice = list.slice((f.page - 1) * per, f.page * per);
  $('#tkTbl').innerHTML = slice.length ? `<table class="tbl"><thead><tr><th>Toko & Lokasi</th><th>Provinsi</th><th>Term of Payment</th><th>PIC & Kontak</th>
    <th>Salesman PJ</th><th>Geotag Peta</th><th>Status</th><th class="text-end">Aksi</th></tr></thead><tbody>
    ${slice.map(t => `<tr>
      <td><div class="d-flex align-items-center gap-2"><div class="avatar" style="width:32px;height:32px;font-size:11px;border-radius:8px">${esc(initials(t.nama))}</div>
        <div><div class="cell-main">${esc(t.nama)} <span class="code">${esc(t.id)}</span></div><div class="cell-sub">${esc(t.kota)}</div></div></div></td>
      <td>${esc(t.provinsi)}</td><td>${pill(topLabel(t.top), t.top === 'Tunai' ? 'ok' : 'pri')}</td>
      <td><div>${esc(t.pic)}</div><div class="cell-sub num">${esc(t.kontak)}</div></td>
      <td>${esc(salesOf(t.idSalesman).nama)}</td>
      <td>${t.lat !== '' ? `<span class="pill pill-pri num"><i class="bi bi-geo-alt"></i>${(+t.lat).toFixed(3)}, ${(+t.lng).toFixed(3)}</span>` : pill('Belum ada', 'warn')}</td>
      <td>${pill(t.status || 'Aktif', t.status === 'Nonaktif' ? 'neu' : t.status === 'Perlu Verifikasi' ? 'warn' : 'ok', 1)}</td>
      <td class="text-end text-nowrap"><button class="btn btn-sm btn-outline" onclick="openTokoForm('${esc(t.id)}')" aria-label="Edit ${esc(t.nama)}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm ${t.status === 'Nonaktif' ? 'btn-ok-soft' : 'btn-danger-soft'}" onclick="toggleToko('${esc(t.id)}')">${t.status === 'Nonaktif' ? 'Aktifkan' : 'Nonaktifkan'}</button></td></tr>`).join('')}
    </tbody></table>` : emptyState('bi-shop', 'Tidak ada toko yang cocok.');
  $('#tkFoot').innerHTML = `<span>Menampilkan ${list.length ? (f.page - 1) * per + 1 : 0}–${Math.min(f.page * per, list.length)} dari ${list.length} toko mitra</span>${pagerHtml(list.length, f.page, per, 'tkPage')}`;
}
function tkPage(p) { F.toko.page = p; tkUpdate(); }
function exportToko() {
  downloadCsv(`data-toko-${today()}.csv`, [['ID', 'Nama', 'Alamat', 'Kota', 'Provinsi', 'Lat', 'Lng', 'TOP', 'PIC', 'Kontak', 'Salesman PJ', 'Status']]
    .concat(tkFiltered().map(t => [t.id, t.nama, t.alamat, t.kota, t.provinsi, t.lat, t.lng, topLabel(t.top), t.pic, t.kontak, salesOf(t.idSalesman).nama, t.status])));
}
async function toggleToko(id) {
  const t = IDX.toko.get(id), next = t.status === 'Nonaktif' ? 'Aktif' : 'Nonaktif';
  if (next === 'Nonaktif' && !await confirmBox({ title: 'Nonaktifkan toko?', msg: `${t.nama} tidak akan muncul di form kunjungan & omset. Data historis tetap tersimpan.`, ok: 'Nonaktifkan' })) return;
  const prev = t.status; t.status = next; tkUpdate();                 // ← optimistic
  try { const r = await api('setTokoStatus', id, next); Object.assign(t, r); toast(`${t.nama} kini ${next}.`, 'ok'); }
  catch (e) { t.status = prev; tkUpdate(); e.type !== 'auth' && toast(e.message, 'bad', 'Gagal mengubah status'); }
}
function openTokoForm(id) {
  const t = id ? Object.assign({}, IDX.toko.get(id)) : { top: '30', status: 'Aktif', kategori: 'Toko Part Teknik & Retail' };
  const PROV = ['DKI Jakarta', 'Jawa Barat', 'Jawa Tengah', 'DI Yogyakarta', 'Jawa Timur', 'Banten', 'Bali', 'Sumatera Utara', 'Sumatera Barat', 'Sumatera Selatan', 'Riau', 'Kepulauan Riau', 'Lampung', 'Jambi', 'Bengkulu', 'Aceh', 'Bangka Belitung', 'Kalimantan Barat', 'Kalimantan Tengah', 'Kalimantan Selatan', 'Kalimantan Timur', 'Kalimantan Utara', 'Sulawesi Utara', 'Sulawesi Tengah', 'Sulawesi Selatan', 'Sulawesi Tenggara', 'Gorontalo', 'Sulawesi Barat', 'NTB', 'NTT', 'Maluku', 'Maluku Utara', 'Papua', 'Papua Barat'];
  const topDesc = { Tunai: 'Jatuh tempo saat faktur diserahkan (COD / H+0).', '30': 'Standar KNS Teknik — 30 hari kalender setelah faktur.', '45': 'Khusus toko grosir & pembelian volume.', '60': 'Distributor utama & kontraktor terakreditasi.' };
  const sec = (n, title, sub, body) => `<div class="form-section"><div class="form-section-head"><span class="n">${n}</span>${title}<span class="ms-auto small fw-normal opacity-75 d-none d-md-inline">${sub}</span></div><div class="form-section-body">${body}</div></div>`;
  const body = `<form id="tkForm" novalidate>
    ${sec(1, 'Informasi Toko', 'Identitas entitas mitra', `<div class="row g-3">
      <div class="col-md-6"><label class="form-label">Nama Toko Mitra <span class="req">*</span></label><input class="form-control" name="nama" value="${esc(t.nama)}" required maxlength="120"></div>
      <div class="col-md-6"><label class="form-label">Kategori Pelanggan</label><select class="form-select" name="kategori">${selectOptions(['Toko Part Teknik & Retail', 'Toko Furniture', 'Grosir / Distributor', 'Kontraktor / Proyek', 'Toko Bangunan'], t.kategori)}</select></div>
      <div class="col-12"><label class="form-label">Alamat Lengkap</label><input class="form-control" name="alamat" value="${esc(t.alamat)}" maxlength="300"></div>
      <div class="col-md-6"><label class="form-label">Kota / Kabupaten <span class="req">*</span></label><input class="form-control" name="kota" value="${esc(t.kota)}" required></div>
      <div class="col-md-6"><label class="form-label">Provinsi <span class="req">*</span></label><select class="form-select" name="provinsi" required>${selectOptions(PROV, t.provinsi, 'Pilih provinsi…')}</select></div></div>`)}
    ${sec(2, 'Kontak & Penanggung Jawab', 'Komunikasi & jam kunjungan', `<div class="row g-3">
      <div class="col-md-4"><label class="form-label">Nama PIC</label><input class="form-control" name="pic" value="${esc(t.pic)}"></div>
      <div class="col-md-4"><label class="form-label">WhatsApp / Telepon</label><input class="form-control" name="kontak" value="${esc(t.kontak)}" inputmode="tel" placeholder="+62 812-…"></div>
      <div class="col-md-4"><label class="form-label">Jam Operasional</label><input class="form-control" name="jam" value="${esc(t.jam)}" placeholder="Senin - Sabtu 08:00 - 17:00"></div>
      <div class="col-md-6"><label class="form-label">Salesman Penanggung Jawab</label><select class="form-select" name="idSalesman">${selectOptions(S.salesman.map(s => [s.id, `${s.nama} — ${s.wilayah}`]), t.idSalesman, 'Belum ditentukan')}</select></div>
      <div class="col-md-6"><label class="form-label">Status</label><select class="form-select" name="status">${selectOptions(['Aktif', 'Perlu Verifikasi', 'Nonaktif'], t.status || 'Aktif')}</select></div></div>`)}
    ${sec(3, 'Ketentuan Pembayaran (Term of Payment)', 'Tenor kredit & jatuh tempo', `
      <div class="choice-grid mb-3">${['Tunai', '30', '45', '60'].map(v => `<label class="choice"><input type="radio" name="top" value="${v}" ${String(t.top) === v ? 'checked' : ''}>
        <div class="t">${topLabel(v)} ${v === '30' ? pill('Standar', 'pri') : ''}</div><div class="s">${topDesc[v]}</div></label>`).join('')}</div>
      <div class="callout"><i class="bi bi-calculator"></i><div>Sistem menghitung tanggal jatuh tempo setiap faktur baru = tanggal faktur + TOP toko. Faktur yang sudah ada tetap memakai jatuh tempo lamanya.</div></div>`)}
    ${sec(4, 'Penandaan Titik Lokasi GPS & Pin Map', 'Validasi check-in salesman', `
      <div id="tkMap" class="map-box mb-3"></div>
      <div class="row g-3 align-items-end">
        <div class="col-md-4"><label class="form-label">Garis Lintang (Latitude)</label><input class="form-control num" name="lat" value="${esc(t.lat)}" inputmode="decimal" placeholder="-6.917464"></div>
        <div class="col-md-4"><label class="form-label">Garis Bujur (Longitude)</label><input class="form-control num" name="lng" value="${esc(t.lng)}" inputmode="decimal" placeholder="107.619122"></div>
        <div class="col-md-4"><button type="button" class="btn btn-outline w-100" id="tkGps"><i class="bi bi-crosshair"></i> Gunakan Lokasi Saat Ini</button></div>
      </div><div class="form-text mt-2">Klik peta atau geser pin untuk menandai lokasi toko secara presisi.</div>`)}
    <div id="tkErr" class="invalid-msg"></div></form>`;
  openModal({
    title: id ? `Edit Data: ${esc(t.nama)}` : 'Tambah Toko Mitra Baru', sub: id ? `Mode edit • ${esc(id)}` : 'Formulir manajemen data toko', body, size: 'modal-xl',
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="tkSave"><i class="bi bi-check2-circle"></i> Simpan Data Toko</button>`,
    onShown: () => tkMapInit(t)
  });
  $('#tkSave').onclick = () => saveTokoForm(id);
  $('#tkGps').onclick = () => {
    if (!navigator.geolocation) return toast('GPS tidak tersedia.', 'warn');
    const done = busy($('#tkGps'), 'Mencari…');
    navigator.geolocation.getCurrentPosition(p => { done(); tkSetPin(p.coords.latitude, p.coords.longitude, true); },
      () => { done(); toast('Gagal mengambil lokasi. Pastikan izin lokasi aktif.', 'bad'); }, { enableHighAccuracy: true, timeout: 15000 });
  };
}
function tkMapInit(t) {
  const has = t.lat !== '' && t.lat !== undefined;
  mkMap('tk', 'tkMap', has ? +t.lat : -2.5, has ? +t.lng : 117, has ? 16 : 5).then(m => {
    if (!m) return;
    m.on('click', e => tkSetPin(e.latlng.lat, e.latlng.lng));
    if (has) tkSetPin(+t.lat, +t.lng, false);
    const f = $('#tkForm');
    ['lat', 'lng'].forEach(n => f[n].addEventListener('change', () => { const a = parseFloat(f.lat.value), b = parseFloat(f.lng.value); if (isFinite(a) && isFinite(b)) tkSetPin(a, b, true); }));
  });
}
function tkSetPin(lat, lng, fly) {
  const m = MAPS.tk, f = $('#tkForm'); if (!f) return;
  f.lat.value = (+lat).toFixed(6); f.lng.value = (+lng).toFixed(6);
  if (!m) return;
  if (m._pin) m._pin.setLatLng([lat, lng]);
  else { m._pin = L.marker([lat, lng], { draggable: true, icon: pinIcon('#4F46E5') }).addTo(m); m._pin.on('dragend', e => { const p = e.target.getLatLng(); tkSetPin(p.lat, p.lng); }); }
  if (fly) m.setView([lat, lng], 17);
}
async function saveTokoForm(id) {
  const f = $('#tkForm'), fd = Object.fromEntries(new FormData(f).entries());
  const err = [];
  ['nama', 'kota', 'provinsi'].forEach(n => { const bad = !String(fd[n] || '').trim(); f[n].classList.toggle('is-invalid', bad); if (bad) err.push(`${{ nama: 'Nama toko', kota: 'Kota', provinsi: 'Provinsi' }[n]} wajib diisi.`); });
  if ((fd.lat && !isFinite(+fd.lat)) || (fd.lng && !isFinite(+fd.lng))) err.push('Koordinat tidak valid.');
  $('#tkErr').innerHTML = err.map(e => `<div>${esc(e)}</div>`).join('');
  if (err.length) return;
  fd.id = id || ''; fd.lat = fd.lat === '' ? '' : +fd.lat; fd.lng = fd.lng === '' ? '' : +fd.lng;
  const done = busy($('#tkSave'));
  try {
    const r = await api('saveToko', fd);
    const i = S.toko.findIndex(x => x.id === r.id);
    if (i >= 0) S.toko[i] = r; else S.toko.push(r);
    reindex(); closeModal(); tkUpdate();
    toast(`${r.nama} (${r.id}) berhasil disimpan.`, 'ok', id ? 'Data toko diperbarui' : 'Toko baru ditambahkan');
  } catch (e) { done(); $('#tkErr').textContent = e.message; e.type !== 'auth' && toast(e.message, 'bad', 'Gagal menyimpan'); }
}

// ── 7.9 DATA PIUTANG & FAKTUR ──────────────────────────────
PAGES.piutang = (el, params, fresh) => {
  const f = F.piu = F.piu || { q: '', status: 'aktif', prov: '', page: 1 };
  if (fresh || !el.dataset.mounted) {
    el.dataset.mounted = '1';
    const provs = [...new Set(S.toko.map(t => t.provinsi).filter(Boolean))].sort();
    el.innerHTML = pageHead('<i class="bi bi-receipt"></i> Keuangan & piutang • Ledger AR', 'Data Piutang & Faktur Toko',
      'Manajemen pencatatan faktur berjalan, status jatuh tempo otomatis, dan riwayat pelunasan toko.',
      `<button class="btn btn-outline" onclick="exportPiutang()"><i class="bi bi-download"></i> Ekspor CSV</button>
       <button class="btn btn-primary" onclick="openFakturForm()"><i class="bi bi-plus-circle"></i> Buat Faktur Piutang Baru</button>`) + `
    <div class="row g-3 mb-4" id="piKpi"></div>
    <div class="card-x">
      <div class="filters">
        <div class="input-icon grow"><i class="bi bi-search"></i><input class="form-control" id="piQ" placeholder="Cari nomor faktur atau nama toko…" value="${esc(f.q)}"></div>
        <select class="form-select w-sel" id="piStatus">${selectOptions([['aktif', 'Belum lunas (semua)'], ['Belum Lunas', 'Belum jatuh tempo'], ['Jatuh Tempo', 'Jatuh tempo'], ['Lunas', 'Lunas'], ['', 'Semua status']], f.status)}</select>
        <select class="form-select w-sel" id="piProv">${selectOptions(provs, f.prov, 'Semua Wilayah')}</select>
      </div>
      <div class="tbl-wrap" id="piTbl"></div><div class="card-foot" id="piFoot"></div>
    </div>`;
    $('#piQ').addEventListener('input', debounce(e => { f.q = e.target.value; f.page = 1; piUpdate(); }, 150));
    [['piStatus', 'status'], ['piProv', 'prov']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => { f[k] = e.target.value; f.page = 1; piUpdate(); }));
  }
  piUpdate();
};
function piFiltered() {
  const f = F.piu, q = f.q.toLowerCase();
  return piutangRows().filter(p => (!q || (p.noFaktur + ' ' + p._toko.nama + ' ' + p.idToko).toLowerCase().includes(q)) &&
    (!f.prov || p._toko.provinsi === f.prov) && (f.status === 'aktif' ? p._sisa > 0 : !f.status || p._status === f.status))
    .sort((a, b) => (b._sisa > 0) - (a._sisa > 0) || b._late - a._late);
}
function piUpdate() {
  const f = F.piu, all = piutangRows(), list = piFiltered(), per = 10;
  const out = all.filter(p => p._sisa > 0), od = out.filter(p => p._late > 0);
  const ms = monthStart(today());
  const paidM = sum(S.pembayaran.filter(b => b.tanggal >= ms), b => b.jumlah);
  const lunasPct = pct(sum(all, p => (Number(p.nilai) || 0) - p._sisa), sum(all, p => Number(p.nilai) || 0));
  $('#piKpi').innerHTML = `
    <div class="col-md-4">${kpi({ label: 'Total Piutang Berjalan', value: rp(sum(out, p => p._sisa)), icon: 'bi-wallet2', meta: `${out.length} faktur aktif dari ${new Set(out.map(p => p.idToko)).size} toko` })}</div>
    <div class="col-md-4">${kpi({ label: 'Total Jatuh Tempo', value: `<span class="text-bad">${rp(sum(od, p => p._sisa))}</span>`, icon: 'bi-calendar2-x', meta: `${od.length} faktur lewat TOP • <a href="javascript:void(0)" onclick="navigateTo('piutangJT')">lihat daftar</a>` })}</div>
    <div class="col-md-4">${kpi({ label: 'Tingkat Pelunasan', value: `${lunasPct}%`, badge: pill(`${rpShort(paidM)} bulan ini`, 'ok'), bar: lunasPct, barCls: 'ok', meta: 'Proporsi nilai faktur yang sudah dibayar' })}</div>`;
  const pages = Math.ceil(list.length / per) || 1; f.page = Math.min(f.page, pages);
  const slice = list.slice((f.page - 1) * per, f.page * per);
  $('#piTbl').innerHTML = slice.length ? `<table class="tbl"><thead><tr><th>No. Faktur</th><th>Toko Mitra</th><th>Tgl Faktur</th><th>Jatuh Tempo</th>
    <th class="n">Nilai Faktur</th><th class="n">Sisa Piutang</th><th>Status</th><th class="text-end">Aksi</th></tr></thead><tbody>
    ${slice.map(p => `<tr>
      <td><div class="text-primary-x fw-semibold">${esc(p.noFaktur)}</div><div class="cell-sub">${topLabel(p._toko.top)}</div></td>
      <td><div class="cell-main">${esc(p._toko.nama)}</div><div class="cell-sub">${esc(p._toko.kota)} • PIC ${esc(p._toko.pic || '-')}</div></td>
      <td class="num">${fmtDate(p.tglFaktur)}</td><td class="num">${fmtDate(p.jatuhTempo)}<div class="cell-sub">${p._sisa > 0 ? (p._late > 0 ? `telat ${p._late} hari` : p._late === 0 ? 'hari ini' : `${-p._late} hari lagi`) : ''}</div></td>
      <td class="n num">${rp(p.nilai)}</td><td class="n num ${p._late > 0 && p._sisa > 0 ? 'text-bad fw-bold' : 'fw-semibold'}">${rp(p._sisa)}</td>
      <td>${p._status === 'Lunas' ? pill('Lunas', 'ok', 1) : p._status === 'Jatuh Tempo' ? pill(p._late > 30 ? 'Kritis > 30 hari' : 'Jatuh Tempo', 'bad') : pill('Belum Lunas', 'warn')}</td>
      <td class="text-end text-nowrap">
        ${p._sisa > 0 ? `<button class="btn btn-sm btn-primary" onclick="openBayar('${esc(p.id)}')">Catat Bayar</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="openRiwayatBayar('${esc(p.id)}')" aria-label="Riwayat pembayaran"><i class="bi bi-clock-history"></i></button>
        <button class="btn btn-sm btn-outline" onclick="openFakturForm('${esc(p.id)}')" aria-label="Edit faktur"><i class="bi bi-pencil"></i></button>
        ${isMgr() ? `<button class="btn btn-sm btn-danger-soft" onclick="deleteItem('piutang','${esc(p.id)}')" aria-label="Hapus faktur"><i class="bi bi-trash"></i></button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : emptyState('bi-receipt', 'Tidak ada faktur yang cocok.');
  $('#piFoot').innerHTML = `<span>Menampilkan ${list.length ? (f.page - 1) * per + 1 : 0}–${Math.min(f.page * per, list.length)} dari ${list.length} faktur • Sisa <b class="num">${rp(sum(list, p => p._sisa))}</b></span>${pagerHtml(list.length, f.page, per, 'piPage')}`;
}
function piPage(p) { F.piu.page = p; piUpdate(); }
function exportPiutang() {
  downloadCsv(`data-piutang-${today()}.csv`, [['No Faktur', 'ID Toko', 'Toko', 'Kota', 'Tgl Faktur', 'TOP', 'Jatuh Tempo', 'Nilai', 'Sisa', 'Status', 'Hari Terlambat']]
    .concat(piFiltered().map(p => [p.noFaktur, p.idToko, p._toko.nama, p._toko.kota, p.tglFaktur, topLabel(p._toko.top), p.jatuhTempo, p.nilai, p._sisa, p._status, Math.max(0, p._late)])));
}
function openFakturForm(id) {
  const p = id ? S.piutang.find(x => x.id === id) : { tglFaktur: today() };
  const tl = S.toko.filter(t => t.status !== 'Nonaktif' || t.id === p.idToko).sort((a, b) => a.nama.localeCompare(b.nama));
  openModal({
    title: id ? 'Edit Faktur Piutang' : 'Buat Faktur Piutang Baru', sub: id ? esc(p.noFaktur) : 'Jatuh tempo dihitung otomatis dari TOP toko', size: 'modal-lg',
    body: `<form id="fkForm" novalidate><div class="row g-3">
      <div class="col-12"><label class="form-label">Toko Mitra <span class="req">*</span></label><select class="form-select" name="idToko" required>${selectOptions(tl.map(t => [t.id, `${t.nama} — ${t.kota} (TOP ${topLabel(t.top)})`]), p.idToko, 'Pilih toko…')}</select></div>
      <div class="col-md-6"><label class="form-label">Nomor Faktur <span class="req">*</span></label><input class="form-control" name="noFaktur" value="${esc(p.noFaktur)}" placeholder="FKT-2026/11/001" required></div>
      <div class="col-md-6"><label class="form-label">Tanggal Faktur <span class="req">*</span></label><input type="date" class="form-control" name="tglFaktur" value="${esc(p.tglFaktur)}" max="${today()}" required></div>
      <div class="col-md-6"><label class="form-label">Nilai Piutang <span class="req">*</span></label><div class="input-rp"><span>Rp</span><input class="form-control num" name="nilai" inputmode="numeric" value="${p.nilai ? NF.format(p.nilai) : ''}" required></div></div>
      <div class="col-md-6"><label class="form-label">Catatan</label><input class="form-control" name="catatan" value="${esc(p.catatan)}"></div>
      <div class="col-12"><div class="sum-box d-flex flex-wrap justify-content-between gap-2" id="fkPrev"></div></div>
    </div><div id="fkErr" class="invalid-msg mt-2"></div></form>`,
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="fkSave"><i class="bi bi-check2-circle"></i> Simpan Faktur</button>`
  });
  const f = $('#fkForm');
  const prev = () => {
    const t = IDX.toko.get(f.idToko.value), tg = f.tglFaktur.value;
    $('#fkPrev').innerHTML = t && tg ? `<div><div class="kpi-label">Term of Payment</div><b>${topLabel(t.top)}</b></div>
      <div><div class="kpi-label">Jatuh Tempo Otomatis</div><b class="num">${fmtDate(addDays(tg, topDays(t.top)))}</b></div>
      <div><div class="kpi-label">Status Awal</div>${diffDays(addDays(tg, topDays(t.top)), today()) > 0 ? pill('Jatuh Tempo', 'bad') : pill('Belum Lunas', 'warn')}</div>`
      : '<span class="text-2 small">Pilih toko & tanggal faktur untuk melihat jatuh tempo.</span>';
  };
  bindRpInput(f.nilai); f.idToko.addEventListener('change', prev); f.tglFaktur.addEventListener('change', prev); prev();
  $('#fkSave').onclick = async () => {
    const d = Object.fromEntries(new FormData(f).entries()); d.nilai = parseRp(d.nilai); d.id = id || '';
    const err = [];
    if (!d.idToko) err.push('Pilih toko.'); if (!d.noFaktur.trim()) err.push('Nomor faktur wajib diisi.');
    if (!d.tglFaktur || d.tglFaktur > today()) err.push('Tanggal faktur tidak valid.'); if (!(d.nilai > 0)) err.push('Nilai piutang harus angka positif.');
    if (S.piutang.some(x => x.noFaktur.toUpperCase() === d.noFaktur.trim().toUpperCase() && x.id !== id)) err.push('Nomor faktur sudah ada.');
    $('#fkErr').innerHTML = err.map(e => `<div>${esc(e)}</div>`).join(''); if (err.length) return;
    const done = busy($('#fkSave'));
    try {
      const r = await api('savePiutang', d);
      const i = S.piutang.findIndex(x => x.id === r.id); if (i >= 0) S.piutang[i] = r; else S.piutang.push(r);
      closeModal(); renderNav(); renderPage(false); toast(`Faktur ${r.noFaktur} • jatuh tempo ${fmtDate(r.jatuhTempo)}`, 'ok', 'Faktur tersimpan');
    } catch (e) { done(); $('#fkErr').textContent = e.message; }
  };
}
/** Modal catat pembayaran — sesuai desain "Catat Pembayaran Piutang". */
function openBayar(id) {
  const p = piutangRows().find(x => x.id === id); if (!p) return;
  if (p._sisa <= 0) return toast('Faktur ini sudah lunas.', 'info');
  openModal({
    title: 'Catat Pembayaran Piutang', sub: `Faktur #${esc(p.noFaktur)}`, size: '', fs: true,
    body: `<form id="byForm" novalidate>
      <div class="sum-box d-flex align-items-center gap-3 mb-3"><div class="brand-logo" style="width:44px;height:44px">${esc(initials(p._toko.nama))}</div>
        <div class="flex-grow-1 min-w-0"><div class="fw-semibold">${esc(p._toko.nama)}</div><div class="small text-2">${esc(p._toko.kota)} • PIC: ${esc(p._toko.pic || '-')}</div></div>
        <div class="text-end"><div class="small text-2">Sisa Piutang Saat Ini</div><div class="fw-bold text-bad fs-5 num">${rp(p._sisa)}</div></div></div>
      <div class="d-flex justify-content-between"><label class="form-label">Jumlah Pembayaran <span class="req">*</span></label>
        <button type="button" class="btn btn-ghost btn-sm p-0" style="min-height:auto" id="byFull">Bayar Penuh / Lunas</button></div>
      <div class="input-rp mb-3"><span>Rp</span><input class="form-control num" name="jumlah" inputmode="numeric" placeholder="0" required></div>
      <div class="row g-3 mb-3">
        <div class="col-sm-6"><label class="form-label">Tanggal Pembayaran</label><input type="date" class="form-control" name="tanggal" value="${today()}" max="${today()}" required></div>
        <div class="col-sm-6"><label class="form-label">Metode Pembayaran</label><select class="form-select" name="metode">${selectOptions(S.lists.metode || [], 'Transfer Bank')}</select></div></div>
      <div class="mb-3"><label class="form-label">Bukti Transfer / Nomor Referensi</label><div class="input-icon"><i class="bi bi-receipt"></i><input class="form-control" name="referensi" placeholder="TRF-BCA-…"></div></div>
      <div class="mb-3"><label class="form-label">Catatan Pembayaran</label><textarea class="form-control" name="catatan" rows="2" placeholder="Cicilan tahap 1 sesuai janji saat kunjungan salesman."></textarea></div>
      <div class="sum-box" id="bySum"></div><div id="byErr" class="invalid-msg mt-2"></div></form>`,
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="bySave"><i class="bi bi-check2-circle"></i> Simpan Pembayaran</button>`
  });
  const f = $('#byForm');
  const upd = n => {
    const baru = p._sisa - n;
    $('#bySum').innerHTML = `<div class="d-flex justify-content-between small"><span>Sisa Piutang Awal: <b class="num">${rp(p._sisa)}</b></span><span>Pembayaran: <b class="text-primary-x num">- ${rp(n)}</b></span></div>
      <hr class="my-2" style="border-color:var(--border)"><div class="d-flex justify-content-between align-items-end">
      <div><div class="kpi-label">Sisa Piutang Baru</div><div class="fw-bold fs-5 num ${baru < 0 ? 'text-bad' : ''}">${rp(Math.max(0, baru))}</div></div>
      <div class="text-end"><div class="kpi-label">Status Baru</div>${baru < 0 ? pill('Melebihi sisa', 'bad') : baru === 0 ? pill('Lunas', 'ok', 1) : pill(p._late > 0 ? 'Jatuh Tempo' : 'Belum Lunas', p._late > 0 ? 'bad' : 'warn')}</div></div>`;
  };
  bindRpInput(f.jumlah, upd); upd(0);
  $('#byFull').onclick = () => { f.jumlah.value = NF.format(p._sisa); upd(p._sisa); };
  $('#bySave').onclick = async () => {
    const d = Object.fromEntries(new FormData(f).entries()); d.jumlah = parseRp(d.jumlah); d.idPiutang = p.id;
    const err = [];
    if (!(d.jumlah > 0)) err.push('Isi jumlah pembayaran.'); if (d.jumlah > p._sisa) err.push('Jumlah melebihi sisa piutang.');
    if (!d.tanggal || d.tanggal > today()) err.push('Tanggal tidak valid.');
    $('#byErr').innerHTML = err.map(e => `<div>${esc(e)}</div>`).join(''); if (err.length) return;
    // Optimistic: sisa langsung berkurang di UI, rollback bila server menolak
    const orig = S.piutang.find(x => x.id === p.id), backup = Object.assign({}, orig);
    const tmp = Object.assign({ id: 'tmp-' + Date.now(), dicatatOleh: S.user.nama, dibuat: '' }, d);
    orig.sisa = p._sisa - d.jumlah; S.pembayaran.push(tmp);
    closeModal(); renderNav(); renderPage(false);
    toast(`${rp(d.jumlah)} untuk ${p.noFaktur}${orig.sisa === 0 ? ' — LUNAS' : ''}`, 'ok', 'Pembayaran dicatat');
    try {
      const r = await api('savePembayaran', d);
      Object.assign(orig, r.piutang);
      S.pembayaran = S.pembayaran.filter(b => b !== tmp).concat([r.pembayaran]);
    } catch (e) {
      Object.assign(orig, backup); S.pembayaran = S.pembayaran.filter(b => b !== tmp);
      e.type !== 'auth' && toast(e.message, 'bad', 'Pembayaran gagal disimpan — dibatalkan');
    }
    renderNav(); renderPage(false);
  };
}
function openRiwayatBayar(id) {
  const p = piutangRows().find(x => x.id === id); if (!p) return;
  const list = S.pembayaran.filter(b => b.idPiutang === id).sort((a, b) => b.tanggal.localeCompare(a.tanggal));
  openModal({
    title: 'Riwayat Pembayaran', sub: `${esc(p.noFaktur)} • ${esc(p._toko.nama)}`, size: 'modal-lg',
    body: `<div class="row g-2 mb-3"><div class="col-4"><div class="sum-box"><div class="kpi-label">Nilai Faktur</div><b class="num">${rp(p.nilai)}</b></div></div>
      <div class="col-4"><div class="sum-box"><div class="kpi-label">Terbayar</div><b class="num text-ok">${rp(sum(list, b => b.jumlah))}</b></div></div>
      <div class="col-4"><div class="sum-box"><div class="kpi-label">Sisa</div><b class="num ${p._sisa ? 'text-bad' : ''}">${rp(p._sisa)}</b></div></div></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tanggal</th><th>Metode & Referensi</th><th>Dicatat</th><th class="n">Jumlah</th>${isMgr() ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map(b => `<tr><td class="num">${fmtDate(b.tanggal)}</td><td>${esc(b.metode)}<div class="cell-sub">${esc(b.referensi || '-')} ${b.catatan ? '• ' + esc(b.catatan) : ''}</div></td>
        <td class="cell-sub">${esc(b.dicatatOleh)}</td><td class="n num fw-semibold">${rp(b.jumlah)}</td>
        ${isMgr() ? `<td class="text-end"><button class="btn btn-sm btn-danger-soft" onclick="deleteItem('pembayaran','${esc(b.id)}')" aria-label="Hapus pembayaran"><i class="bi bi-trash"></i></button></td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : emptyState('bi-cash', 'Belum ada pembayaran untuk faktur ini.')}`,
    footer: p._sisa > 0 ? `<button class="btn btn-primary" onclick="closeModal();setTimeout(()=>openBayar('${esc(p.id)}'),350)"><i class="bi bi-cash"></i> Catat Pembayaran</button>` : ''
  });
}

// ── 7.10 DATA SALESMAN & HAK AKSES (Manajer) ───────────────
PAGES.salesman = (el) => {
  const users = S.pengguna.slice().sort((a, b) => ({ Manajer: 0, Admin: 2, Salesman: 1 }[a.peran] - { Manajer: 0, Admin: 2, Salesman: 1 }[b.peran]) || a.nama.localeCompare(b.nama));
  const salesUsers = users.filter(u => u.peran === R.SLS && u.status !== 'Nonaktif');
  const portfolio = id => S.toko.filter(t => t.idSalesman === id && t.status !== 'Nonaktif').length;
  const covered = salesUsers.filter(u => (salesOf(u.idSalesman).wilayah || '').trim()).length;
  el.innerHTML = `<div class="callout mb-4"><i class="bi bi-shield-lock"></i><div class="flex-grow-1"><b>Akses Manajer Terproteksi</b> ${pill('Email + kata sandi', 'pri')}<br>
      Hanya akun di daftar ini yang dapat membuka aplikasi. Email boleh dari layanan apa pun. Pengguna baru otomatis mendapat kata sandi sementara; lupa sandi → klik <b>Reset Sandi</b>. ${S.settings.allowedDomain ? `Login dibatasi untuk email <b>@${esc(S.settings.allowedDomain)}</b>.` : ''}</div></div>` +
    pageHead('Administrasi sales', 'Manajemen Tim Salesman & Hak Akses', '',
      `<button class="btn btn-primary" onclick="openUserForm()"><i class="bi bi-person-plus"></i> Tambah Pengguna Baru</button>`) + `
  <div class="row g-3 mb-4">
    <div class="col-6 col-xl-3">${kpi({ label: 'Total Akun Internal', value: `${users.filter(u => u.status !== 'Nonaktif').length} <small>akun</small>`, icon: 'bi-people',
      meta: `${users.filter(u => u.peran === R.SLS && u.status !== 'Nonaktif').length} Salesman, ${users.filter(u => u.peran === R.ADM && u.status !== 'Nonaktif').length} Admin, ${users.filter(u => u.peran === R.MGR).length} Manajer` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Total Toko Terkelola', value: `${S.toko.filter(t => t.status !== 'Nonaktif').length} <small>toko</small>`, icon: 'bi-shop',
      meta: `Rata-rata ${salesUsers.length ? (S.toko.filter(t => t.status !== 'Nonaktif').length / salesUsers.length).toFixed(1).replace('.', ',') : 0} toko per salesman` })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Kata Sandi Diatur', value: `${users.filter(u => u.punyaSandi).length}/${users.length}`, icon: 'bi-key', meta: S.settings.allowedDomain ? `Dibatasi: @${esc(S.settings.allowedDomain)}` : 'Email dari layanan apa pun' })}</div>
    <div class="col-6 col-xl-3">${kpi({ label: 'Status Penugasan', value: `${pct(covered, salesUsers.length)}% <small>tercover</small>`, icon: 'bi-map', bar: pct(covered, salesUsers.length), barCls: 'ok', meta: `${covered}/${salesUsers.length} salesman memiliki wilayah` })}</div>
  </div>
  <div class="card-x"><div class="card-head mb-3"><div><h2 class="card-title">Direktori Akses & Penugasan Wilayah</h2><p class="card-sub">Staf yang memiliki kredensial resmi pada sistem Sales Performance</p></div></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pengguna</th><th>Peran Akses</th><th>Cakupan Wilayah</th><th class="n">Portofolio Toko</th><th class="n">Target Omset</th><th>Kata Sandi</th><th>Status</th><th class="text-end">Tindakan</th></tr></thead><tbody>
  ${users.map(u => { const s = salesOf(u.idSalesman), me = String(u.email).toLowerCase() === S.user.email;
    return `<tr><td><div class="d-flex align-items-center gap-2"><div class="avatar">${esc(initials(u.nama))}</div><div><div class="cell-main">${esc(u.nama)} ${me ? pill('Anda', 'pri') : ''}</div><div class="cell-sub">${esc(u.email)}</div></div></div></td>
      <td>${u.peran === R.MGR ? `<span class="pill" style="background:var(--rail);color:#fff"><i class="bi bi-shield-fill"></i>Manajer</span>` : u.peran === R.ADM ? pill('Admin Ops', 'neu') : pill('Salesman', 'pri')}</td>
      <td>${u.peran === R.SLS ? `<i class="bi bi-globe2 text-2"></i> ${esc(s.wilayah || '-')}` : u.peran === R.MGR ? 'Seluruh Indonesia' : 'Kantor Pusat'}</td>
      <td class="n num">${u.peran === R.SLS ? `${portfolio(u.idSalesman)} toko` : u.peran === R.MGR ? `${S.toko.length} (supervisi)` : 'Toko & Piutang'}</td>
      <td class="n num">${u.peran === R.SLS ? rpShort(targetOf(s)) : '-'}</td>
      <td>${u.punyaSandi ? pill('Sudah diatur', 'ok') : pill('Belum ada', 'warn')}</td>
      <td>${u.status === 'Nonaktif' ? pill('Nonaktif', 'neu') : pill('Aktif', 'ok', 1)}</td>
      <td class="text-end text-nowrap">${me ? `<span class="small text-2"><i class="bi bi-lock"></i> Profil terproteksi</span>` : `
        <button class="btn btn-sm btn-outline" onclick="openUserForm('${esc(u.email)}')">Edit</button>
        <button class="btn btn-sm btn-outline" onclick="resetUserPassword('${esc(u.email)}')" title="Buat kata sandi sementara"><i class="bi bi-key"></i> Reset Sandi</button>
        <button class="btn btn-sm ${u.status === 'Nonaktif' ? 'btn-ok-soft' : 'btn-danger-soft'}" onclick="toggleUser('${esc(u.email)}')">${u.status === 'Nonaktif' ? 'Aktifkan' : 'Nonaktifkan'}</button>`}</td></tr>`; }).join('')}
  </tbody></table></div></div>`;
};
function openUserForm(email) {
  const u = email ? S.pengguna.find(x => x.email === email) : { peran: R.SLS, status: 'Aktif' };
  const s = u.idSalesman ? salesOf(u.idSalesman) : { targetOmset: S.settings.targetOmset, targetKunjungan: S.settings.targetKunjungan };
  openModal({
    title: email ? 'Edit Pengguna' : 'Tambah Pengguna Baru', sub: email ? esc(email) : 'Akun Google Workspace perusahaan', size: 'modal-lg',
    body: `<form id="usForm" novalidate><div class="row g-3">
      <div class="col-md-6"><label class="form-label">Nama Lengkap <span class="req">*</span></label><input class="form-control" name="nama" value="${esc(u.nama)}" required></div>
      <div class="col-md-6"><label class="form-label">Email Google <span class="req">*</span></label><input type="email" class="form-control" name="email" value="${esc(u.email)}" placeholder="nama@${esc(S.settings.domain || 'perusahaan.com')}" required></div>
      <div class="col-md-6"><label class="form-label">Peran Akses</label><select class="form-select" name="peran">${selectOptions([R.SLS, R.ADM, R.MGR], u.peran)}</select></div>
      <div class="col-md-6"><label class="form-label">Status</label><select class="form-select" name="status">${selectOptions(['Aktif', 'Nonaktif'], u.status)}</select></div>
      ${email ? '' : `<div class="col-12"><label class="form-label">Kata sandi awal <span class="text-2 fw-normal">(opsional)</span></label>
        <input class="form-control" name="password" autocomplete="off" placeholder="Kosongkan agar dibuat otomatis">
        <div class="form-text">Pengguna wajib menggantinya saat login pertama. Email boleh dari layanan apa pun (Gmail, Yahoo, Outlook, email kantor).</div></div>`}
      <div class="col-12 sales-only"><label class="form-label">Wilayah Tugas</label><input class="form-control" name="wilayah" value="${esc(s.wilayah)}" placeholder="Contoh: Jawa Barat & DKI Jakarta"></div>
      <div class="col-md-6 sales-only"><label class="form-label">Target Omset Bulanan</label><div class="input-rp"><span>Rp</span><input class="form-control num" name="targetOmset" inputmode="numeric" value="${s.targetOmset ? NF.format(s.targetOmset) : ''}"></div></div>
      <div class="col-md-6 sales-only"><label class="form-label">Target Kunjungan Bulanan</label><input type="number" min="0" class="form-control" name="targetKunjungan" value="${esc(s.targetKunjungan)}"></div>
    </div><div id="usErr" class="invalid-msg mt-2"></div></form>`,
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="usSave"><i class="bi bi-check2-circle"></i> Simpan</button>`
  });
  const f = $('#usForm');
  const tog = () => $$('.sales-only', f).forEach(x => x.classList.toggle('d-none', f.peran.value !== R.SLS));
  f.peran.addEventListener('change', tog); tog(); bindRpInput(f.targetOmset);
  $('#usSave').onclick = () => saveUser(Object.assign(Object.fromEntries(new FormData(f).entries()), { origEmail: email || '' }), $('#usSave'));
}
async function saveUser(d, btn) {
  d.targetOmset = parseRp(d.targetOmset);
  const err = [];
  if (!String(d.nama || '').trim()) err.push('Nama wajib diisi.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email || '').trim())) err.push('Email tidak valid.');
  if (d.password && (d.password.length < 8 || !/[A-Za-z]/.test(d.password) || !/\d/.test(d.password))) err.push('Kata sandi awal minimal 8 karakter berisi huruf & angka.');
  if ($('#usErr')) $('#usErr').innerHTML = err.map(e => `<div>${esc(e)}</div>`).join('');
  if (err.length) return;
  const done = busy(btn);
  try {
    const r = await api('saveSalesman', d);
    S.pengguna = r.pengguna; S.salesman = r.salesman; reindex();
    closeModal(); renderPage(false); toast(`${d.nama} tersimpan.`, 'ok', 'Data pengguna diperbarui');
    if (r.tempPassword) setTimeout(() => showCredentials(r.email, r.tempPassword, d.nama), 400);
  } catch (e) { done(); if ($('#usErr')) $('#usErr').textContent = e.message; e.type !== 'auth' && toast(e.message, 'bad', 'Gagal menyimpan'); }
}
async function toggleUser(email) {
  const u = S.pengguna.find(x => x.email === email), s = u.idSalesman ? salesOf(u.idSalesman) : {};
  const next = u.status === 'Nonaktif' ? 'Aktif' : 'Nonaktif';
  if (next === 'Nonaktif' && !await confirmBox({ title: 'Nonaktifkan akses?', msg: `${u.nama} tidak akan bisa membuka aplikasi. Data historisnya tetap tersimpan.`, ok: 'Nonaktifkan' })) return;
  saveUser({ nama: u.nama, email: u.email, origEmail: u.email, peran: u.peran, status: next, wilayah: s.wilayah || '', targetOmset: s.targetOmset || '', targetKunjungan: s.targetKunjungan || '' });
}

// ── 7.11 NOTIFIKASI OTOMATIS & PENGATURAN (Manajer) ────────
PAGES.notifikasi = (el, params, fresh) => {
  const st = S.settings, tr = st.triggers || {};
  el.innerHTML = pageHead('Integrasi Google Apps Script', 'Notifikasi Email Otomatis & Pengaturan',
    'Sistem memeriksa piutang setiap hari dan mengirim SATU email ringkasan ke Manajer & Admin (hemat kuota Gmail).') + `
  <div class="row g-3">
    <div class="col-xl-4">
      <form class="card-x card-pad mb-3" id="stForm" novalidate>
        <div class="d-flex justify-content-between align-items-center mb-3"><h2 class="card-title"><i class="bi bi-alarm"></i> Jadwal Pemicu</h2>
          ${tr.notif ? pill('AKTIF', 'ok', 1) : pill('BELUM AKTIF', 'bad')}</div>
        <label class="form-label">Kirim setiap hari pukul</label>
        <select class="form-select mb-3" name="notifHour">${selectOptions(Array.from({ length: 24 }, (_, h) => [h, String(h).padStart(2, '0') + ':00 WIB']), st.notifHour)}</select>
        <label class="form-label">Penerima notifikasi</label>
        <textarea class="form-control mb-1" name="notifEmails" rows="3">${esc(String(st.notifEmails || '').split(',').join('\n'))}</textarea>
        <div class="form-text mb-3">Satu email per baris. Disimpan aman di Script Properties.</div>
        <hr style="border-color:var(--border)">
        <h3 class="h6 fw-semibold mb-3">Akses & Tautan</h3>
        <label class="form-label">URL aplikasi (GitHub Pages)</label>
        <input class="form-control mb-1" name="frontendUrl" value="${esc(st.frontendUrl || location.origin + location.pathname)}" placeholder="https://username.github.io/repo/">
        <div class="form-text mb-3">Dipakai untuk tombol "Buka Aplikasi" di email notifikasi.</div>
        <label class="form-label">Batasi login ke domain (opsional)</label>
        <div class="input-group mb-1"><span class="input-group-text">@</span><input class="form-control" name="allowedDomain" value="${esc(st.allowedDomain || '')}" placeholder="knsteknik.com"></div>
        <div class="form-text mb-2">Kosongkan agar email dari layanan apa pun (Gmail, Yahoo, dll.) yang terdaftar bisa login.</div>
        <div class="form-check mb-3"><input class="form-check-input" type="checkbox" name="revokeAll" id="stRevoke"><label class="form-check-label small" for="stRevoke">Paksa semua pengguna login ulang (cabut sesi)</label></div>
        <hr style="border-color:var(--border)">
        <h3 class="h6 fw-semibold mb-3">Target & Validasi</h3>
        <label class="form-label">Radius verifikasi GPS (meter)</label><input type="number" class="form-control mb-3" name="radius" min="20" max="2000" value="${esc(st.radius)}">
        <label class="form-label">Target omset default / salesman / bulan</label><div class="input-rp mb-3"><span>Rp</span><input class="form-control num" name="targetOmset" value="${NF.format(st.targetOmset || 0)}"></div>
        <label class="form-label">Target kunjungan default / bulan</label><input type="number" class="form-control mb-3" name="targetKunjungan" min="0" value="${esc(st.targetKunjungan)}">
        <label class="form-label">Target omset harian tim</label><div class="input-rp mb-3"><span>Rp</span><input class="form-control num" name="targetHarian" value="${NF.format(st.targetHarian || 0)}"></div>
        <button type="submit" class="btn btn-primary w-100" id="stSave"><i class="bi bi-save"></i> Simpan Pengaturan</button>
      </form>
      <div class="card-x card-pad mb-3">
        <div class="kpi-label mb-1">Eksekusi terakhir</div>
        <div class="fw-semibold num">${st.lastNotifRun ? esc(st.lastNotifRun) + ' WIB' : 'Belum pernah'}</div>
        <div class="small text-2 mb-3">${esc(st.lastNotifResult || '-')}</div>
        <button class="btn btn-primary w-100 mb-2" onclick="runNotif(this)"><i class="bi bi-lightning-charge"></i> Jalankan Notifikasi Sekarang</button>
        <button class="btn btn-outline w-100 mb-3" onclick="reinstallTriggers(this)"><i class="bi bi-arrow-repeat"></i> Pasang Ulang Pemicu</button>
        <div class="kpi-label mb-1">Backup database (mingguan, Minggu 23:00)</div>
        <div class="small text-2 mb-2">${tr.backup ? pill('Terjadwal', 'ok', 1) : pill('Belum terjadwal', 'warn')} Terakhir: <span id="lastBackup">${esc(st.lastBackup || 'belum ada')}</span></div>
        <button class="btn btn-outline w-100 mb-3" onclick="runBackup(this)"><i class="bi bi-cloud-arrow-down"></i> Backup Sekarang</button>
        <div class="kpi-label mb-1">Sinkron edit manual spreadsheet</div>
        <div class="small text-2 mb-2">${tr.sheetSync ? pill('Otomatis aktif', 'ok', 1) : pill('Belum aktif — klik Pasang Ulang Pemicu', 'warn')}</div>
        <button class="btn btn-outline w-100" onclick="clearServerCache(this)"><i class="bi bi-arrow-clockwise"></i> Segarkan Cache Server</button>
      </div>
      <div class="callout"><i class="bi bi-code-slash"></i><div class="small">Fungsi <code>sendDailyArOverdueSummary()</code> membaca sheet Piutang, menyegarkan status secara batch, menyaring sisa &gt; 0 yang jatuh tempo, lalu mengirim 1 email via MailApp.</div></div>
    </div>
    <div class="col-xl-8"><div class="card-x">
      <div class="card-head mb-3"><div><h2 class="card-title"><i class="bi bi-envelope-paper"></i> Pratinjau Email Hari Ini</h2><p class="card-sub">Persis seperti yang diterima penerima</p></div>
        <button class="btn btn-sm btn-outline" onclick="loadEmailPreview()"><i class="bi bi-arrow-clockwise"></i> Muat ulang</button></div>
      <div class="px-3 px-md-4 pb-4" id="emailPrev"><div class="skel" style="height:420px"></div></div>
    </div></div>
  </div>`;
  const f = $('#stForm');
  bindRpInput(f.targetOmset); bindRpInput(f.targetHarian);
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    d.targetOmset = parseRp(d.targetOmset); d.targetHarian = parseRp(d.targetHarian); d.revokeAll = !!d.revokeAll;
    const done = busy($('#stSave'));
    try { const r = await api('saveSettings', d); Object.assign(S.settings, r); toast('Pengaturan tersimpan.', 'ok'); renderPage(false); }
    catch (e) { done(); e.type !== 'auth' && toast(e.message, 'bad', 'Gagal menyimpan pengaturan'); }
  });
  loadEmailPreview();
};
function loadEmailPreview() {
  const box = $('#emailPrev'); if (!box) return;
  box.innerHTML = '<div class="skel" style="height:420px"></div>';
  api('getEmailPreview').then(html => {
    box.innerHTML = '<iframe class="email-frame" title="Pratinjau email" sandbox=""></iframe>';
    box.querySelector('iframe').srcdoc = html;
  }).catch(e => { box.innerHTML = emptyState('bi-envelope-x', e.message); });
}
async function reinstallTriggers(btn) {
  const done = busy(btn, 'Memasang…');
  try { S.settings.triggers = await api('reinstallTriggers'); toast('Pemicu harian & mingguan terpasang.', 'ok'); renderPage(false); }
  catch (e) { done(); e.type !== 'auth' && toast(e.message, 'bad'); }
}
async function runBackup(btn) {
  const done = busy(btn, 'Mencadangkan…');
  try { const t = await api('runBackupNow'); S.settings.lastBackup = t; $('#lastBackup').textContent = t; toast('Backup spreadsheet berhasil dibuat di folder Backup.', 'ok'); }
  catch (e) { e.type !== 'auth' && toast(e.message, 'bad', 'Backup gagal'); } finally { done(); }
}


// ════════════════════════════════════════════════════════════
// BAGIAN 8 — IMPOR DATA TOKO (Excel / Google Sheets / CSV)
// ════════════════════════════════════════════════════════════
const IMP_FIELDS = [
  ['nama', 'Nama Toko', true, ['namatoko', 'nama', 'toko', 'namacustomer', 'customer', 'pelanggan', 'namapelanggan', 'outlet', 'namaoutlet', 'namamitra']],
  ['kota', 'Kota / Daerah', true, ['kotadaerah', 'kota', 'kabupaten', 'kotakabupaten', 'kabkota', 'daerah', 'city', 'kab', 'wilayah']],
  ['provinsi', 'Provinsi', false, ['provinsi', 'prov', 'propinsi', 'province']],
  ['alamat', 'Alamat', false, ['alamat', 'alamatlengkap', 'alamattoko', 'address']],
  ['top', 'Term of Payment', false, ['termofpayment', 'top', 'termin', 'tempo', 'termpembayaran', 'syaratbayar', 'jangkawaktu', 'tenor']],
  ['pic', 'Nama PIC', false, ['namapictoko', 'pic', 'namapic', 'pemilik', 'owner', 'kontakperson', 'cp', 'namapemilik', 'contactperson']],
  ['kontak', 'Nomor Kontak / WA', false, ['nomorkontak', 'kontak', 'nohp', 'hp', 'telepon', 'telp', 'wa', 'whatsapp', 'notelp', 'nomorhp', 'nowa', 'phone', 'notlp', 'nomortelepon']],
  ['lat', 'Latitude', false, ['latitude', 'lat', 'garislintang', 'lintang']],
  ['lng', 'Longitude', false, ['longitude', 'lng', 'long', 'lon', 'garisbujur', 'bujur']],
  ['koordinat', 'Koordinat (lat, lng) / Link Maps', false, ['koordinat', 'koordinatpinmap', 'pinmap', 'titikkoordinat', 'lokasi', 'gps', 'maps', 'googlemaps', 'linkmaps', 'linklokasi', 'sharelok']],
  ['salesman', 'Salesman PJ (nama/ID/email)', false, ['salesman', 'sales', 'idsalesman', 'salesmanpj', 'idsalesmanpj', 'namasales', 'namasalesman', 'pjsales']],
  ['kategori', 'Kategori Pelanggan', false, ['kategoripelanggan', 'kategori', 'jenis', 'tipe', 'segmen', 'jenistoko']],
  ['jam', 'Jam Operasional', false, ['jamoperasional', 'jam', 'jambuka']],
  ['status', 'Status', false, ['status', 'statusaktif', 'statustoko']],
  ['id', 'ID Toko (opsional, untuk memperbarui)', false, ['idtoko', 'kodetoko', 'id', 'kode', 'idcustomer', 'kodecustomer', 'kodepelanggan']]
];
const IMP = { header: [], rows: [], map: {}, mode: 'update', result: null };
const normHead = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Parser CSV/TSV sederhana yang memahami tanda kutip. */
function parseDelimited(text) {
  text = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!text.trim()) return [];
  const first = text.split('\n')[0];
  const cnt = c => first.split(c).length - 1;
  const delim = [['\t', cnt('\t')], [';', cnt(';')], [',', cnt(',')]].sort((a, b) => b[1] - a[1])[0][0];
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); out.push(row);
  return out;
}
function autoMap(header) {
  const map = {}, used = new Set(), H = header.map(normHead);
  IMP_FIELDS.forEach(([k, , , syn]) => {
    let idx = -1;
    for (const sy of syn) { idx = H.findIndex((h, i) => !used.has(i) && h === sy); if (idx >= 0) break; }
    if (idx < 0) for (const sy of syn) { idx = H.findIndex((h, i) => !used.has(i) && sy.length > 3 && h.includes(sy)); if (idx >= 0) break; }
    if (idx >= 0) { map[k] = idx; used.add(idx); }
  });
  return map;
}
function downloadTokoTemplate() {
  downloadCsv('template-impor-toko.csv', [
    ['ID Toko', 'Nama Toko', 'Alamat', 'Kota/Daerah', 'Provinsi', 'Latitude', 'Longitude', 'Term of Payment', 'Nama PIC Toko', 'Nomor Kontak', 'Kategori Pelanggan', 'Salesman PJ', 'Jam Operasional', 'Status'],
    ['', 'TB Contoh Jaya', 'Jl. Raya Contoh No. 1', 'Bandung', 'Jawa Barat', '-6.917464', '107.619122', '30', 'Pak Budi', '081234567890', 'Toko Part Teknik & Retail', 'Budi Santoso', 'Senin - Sabtu 08:00 - 17:00', 'Aktif']
  ]);
}

function openImportToko() {
  Object.assign(IMP, { header: [], rows: [], map: {}, mode: 'update', result: null });
  openModal({
    title: 'Impor Data Toko', sub: 'Langkah 1 dari 3 • Sumber data', size: 'modal-xl',
    body: `<div class="callout mb-3"><i class="bi bi-info-circle"></i><div class="small">Bisa dari <b>Excel</b>, <b>Google Sheets</b>, atau file <b>CSV</b>. Baris pertama harus berisi judul kolom.
      Minimal ada kolom <b>Nama Toko</b> dan <b>Kota</b>. Kolom lain bebas urutan dan namanya, karena akan dicocokkan di langkah berikutnya.
      <a href="javascript:void(0)" onclick="downloadTokoTemplate()">Unduh template</a></div></div>
      <div class="row g-3">
        <div class="col-lg-7"><label class="form-label">Tempel data (blok sel di Excel/Sheets termasuk judul kolom → Ctrl+C → Ctrl+V di sini)</label>
          <textarea class="form-control num" id="impPaste" rows="10" placeholder="Nama Toko&#9;Kota&#9;Provinsi&#9;TOP&#9;No HP&#10;TB Maju Lancar&#9;Bandung Barat&#9;Jawa Barat&#9;30 hari&#9;0812…" style="font-size:12px;white-space:pre"></textarea></div>
        <div class="col-lg-5"><label class="form-label">…atau unggah file</label>
          <label class="photo-slot w-100" style="aspect-ratio:auto;height:206px" for="impFile"><i class="bi bi-file-earmark-spreadsheet"></i>
            <span class="fw-semibold" style="color:var(--text)">Pilih file .xlsx, .xls, atau .csv</span><span id="impFileName">Maks. 5.000 baris</span></label>
          <input type="file" id="impFile" class="d-none" accept=".xlsx,.xls,.csv,.txt,text/csv"></div>
      </div><div id="impErr" class="invalid-msg mt-2"></div>`,
    footer: `<button class="btn btn-outline" data-bs-dismiss="modal">Batal</button><button class="btn btn-primary" id="impNext1">Lanjut <i class="bi bi-arrow-right"></i></button>`
  });
  $('#impFile').addEventListener('change', impReadFile);
  $('#impNext1').onclick = () => {
    const txt = $('#impPaste').value;
    if (!IMP.rows.length && !txt.trim()) return ($('#impErr').textContent = 'Tempel data atau pilih file terlebih dahulu.');
    if (txt.trim()) impLoadTable(parseDelimited(txt));
    if (IMP.rows.length) impStepMap();
  };
}
async function impReadFile(e) {
  const f = e.target.files[0]; if (!f) return;
  $('#impFileName').textContent = 'Membaca ' + f.name + '…';
  try {
    let table;
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      await loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames.find(n => /toko|customer|pelanggan|outlet/i.test(n)) || wb.SheetNames[0]];
      table = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    } else {
      table = parseDelimited(await f.text());
    }
    impLoadTable(table);
    $('#impFileName').textContent = `${f.name} • ${IMP.rows.length} baris data`;
    $('#impPaste').value = '';
    if (IMP.rows.length) impStepMap();
  } catch (err) { $('#impFileName').textContent = 'Gagal membaca file'; $('#impErr').textContent = err.message || 'File tidak dapat dibaca.'; }
}
function impLoadTable(table) {
  table = (table || []).filter(r => r && r.some(c => String(c).trim() !== ''));
  if (table.length < 2) { $('#impErr').textContent = 'Data minimal 2 baris: judul kolom + 1 baris toko.'; IMP.rows = []; return; }
  // Cari baris judul: baris pertama yang memuat kata "toko"/"nama"/"kota"
  let h = table.findIndex(r => r.some(c => /toko|nama|kota|customer|pelanggan/i.test(String(c))));
  if (h < 0 || h > 10) h = 0;
  IMP.header = table[h].map(c => String(c).trim());
  IMP.rows = table.slice(h + 1).map((r, i) => ({ cells: r, line: h + i + 2 }));
  if (IMP.rows.length > 5000) { $('#impErr').textContent = `File berisi ${IMP.rows.length} baris. Maksimal 5.000 per impor.`; IMP.rows = []; return; }
  IMP.map = autoMap(IMP.header);
}
function impStepMap() {
  const opts = sel => `<option value="">— tidak ada —</option>` + IMP.header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || 'Kolom ' + (i + 1))}</option>`).join('');
  const sample = i => i === undefined || i === '' ? '' : IMP.rows.slice(0, 3).map(r => r.cells[i]).filter(v => String(v || '').trim()).map(v => esc(String(v).slice(0, 40))).join(' • ');
  $('#appModalContent .modal-header .text-primary-x').textContent = `Langkah 2 dari 3 • Cocokkan kolom (${IMP.rows.length} baris)`;
  $('#appModalContent .modal-body').innerHTML = `
    <p class="small text-2">Kolom sudah dicocokkan otomatis dari judul. Periksa dan ubah bila ada yang keliru.</p>
    <div class="tbl-wrap mb-3"><table class="tbl"><thead><tr><th>Data Aplikasi</th><th>Kolom di file Anda</th><th>Contoh isi</th></tr></thead><tbody>
    ${IMP_FIELDS.map(([k, label, req]) => `<tr><td class="fw-semibold">${esc(label)} ${req ? '<span class="text-bad">*</span>' : ''}</td>
      <td style="min-width:220px"><select class="form-select form-select-sm" data-f="${k}">${opts(IMP.map[k])}</select></td>
      <td class="cell-sub" id="smp-${k}">${sample(IMP.map[k])}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="sum-box"><div class="fw-semibold mb-2">Jika toko sudah ada di aplikasi (ID sama, atau Nama + Kota sama):</div>
      <div class="choice-grid"><label class="choice"><input type="radio" name="impMode" value="update" checked><div class="t">Perbarui datanya</div><div class="s">Isi baru menimpa yang lama; pin peta & salesman lama dipertahankan bila kolom kosong.</div></label>
      <label class="choice"><input type="radio" name="impMode" value="skip"><div class="t">Lewati</div><div class="s">Hanya menambahkan toko yang belum ada.</div></label></div></div>
    <div id="impErr" class="invalid-msg mt-2"></div>`;
  $$('#appModalContent select[data-f]').forEach(sl => sl.addEventListener('change', () => {
    IMP.map[sl.dataset.f] = sl.value === '' ? undefined : +sl.value;
    $('#smp-' + sl.dataset.f).innerHTML = sample(IMP.map[sl.dataset.f]);
  }));
  $('#appModalContent .modal-footer').innerHTML = `<button class="btn btn-outline" onclick="openImportToko()"><i class="bi bi-arrow-left"></i> Kembali</button>
    <button class="btn btn-primary" id="impCheck"><i class="bi bi-search"></i> Periksa Data</button>`;
  $('#impCheck').onclick = () => impRun(true, $('#impCheck'));
}
function impPayload() {
  return IMP.rows.map(r => {
    const o = { _line: r.line };
    IMP_FIELDS.forEach(([k]) => { if (IMP.map[k] !== undefined) o[k] = r.cells[IMP.map[k]] === undefined ? '' : String(r.cells[IMP.map[k]]); });
    return o;
  });
}
async function impRun(dry, btn) {
  if (dry) {
    if (IMP.map.nama === undefined || IMP.map.kota === undefined) return ($('#impErr').textContent = 'Kolom "Nama Toko" dan "Kota / Daerah" wajib dipilih.');
    IMP.mode = ($('input[name="impMode"]:checked') || {}).value || 'update';
  }
  const done = busy(btn, dry ? 'Memeriksa…' : 'Mengimpor…');
  try {
    const r = await api('importToko', impPayload(), { dryRun: dry, mode: IMP.mode });
    if (dry) { IMP.result = r; impStepPreview(r); }
    else {
      S.toko = r.toko; reindex(); closeModal(); renderPage(false); saveBootCache();
      toast(`${r.added} toko baru, ${r.updated} diperbarui${r.errorCount ? `, ${r.errorCount} baris dilewati karena error` : ''}.`, 'ok', 'Impor selesai');
    }
  } catch (e) { done(); if ($('#impErr')) $('#impErr').textContent = e.message; }
}
function impStepPreview(r) {
  const sub = $('#appModalContent .modal-header .text-primary-x'); if (sub) sub.textContent = 'Langkah 3 dari 3 • Pratinjau hasil pemeriksaan';
  const total = r.added + r.updated;
  const list = (arr, cls) => arr.map(x => `<div class="small py-1 border-bottom" style="border-color:var(--border)!important"><b>Baris ${x.line}:</b> <span class="${cls}">${esc(x.msg)}</span></div>`).join('');
  $('#appModalContent .modal-body').innerHTML = `
    <div class="row g-2 mb-3">
      <div class="col-6 col-md-3"><div class="sum-box"><div class="kpi-label">Toko baru</div><div class="fs-4 fw-bold text-ok num">${r.added}</div></div></div>
      <div class="col-6 col-md-3"><div class="sum-box"><div class="kpi-label">Diperbarui</div><div class="fs-4 fw-bold text-primary-x num">${r.updated}</div></div></div>
      <div class="col-6 col-md-3"><div class="sum-box"><div class="kpi-label">Dilewati (sudah ada)</div><div class="fs-4 fw-bold num">${r.skipped}</div></div></div>
      <div class="col-6 col-md-3"><div class="sum-box"><div class="kpi-label">Baris error</div><div class="fs-4 fw-bold num ${r.errorCount ? 'text-bad' : ''}">${r.errorCount}</div></div></div>
    </div>
    ${r.errorCount ? `<div class="danger-zone mb-3"><div class="fw-semibold mb-1"><i class="bi bi-x-octagon"></i> ${r.errorCount} baris tidak akan diimpor</div>
      <div style="max-height:160px;overflow:auto">${list(r.errors, '')}</div><div class="small mt-2">Perbaiki di file lalu impor ulang. Baris yang valid tetap bisa diimpor sekarang.</div></div>` : ''}
    ${r.warningCount ? `<details class="mb-3"><summary class="small fw-semibold" style="color:var(--warn-text)"><i class="bi bi-exclamation-triangle"></i> ${r.warningCount} catatan (tetap diimpor)</summary>
      <div style="max-height:160px;overflow:auto">${list(r.warnings, 'text-2')}</div></details>` : ''}
    ${r.preview.length ? `<div class="kpi-label mb-2">Contoh data yang akan disimpan</div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Baris</th><th>Aksi</th><th>Toko</th><th>Kota / Provinsi</th><th>TOP</th><th>Kontak</th><th>Salesman PJ</th><th>Pin Peta</th></tr></thead><tbody>
      ${r.preview.map(p => `<tr><td class="num">${p.line}</td><td>${pill(p.aksi, p.aksi === 'Baru' ? 'ok' : 'pri')}</td><td class="cell-main">${esc(p.nama)} ${p.id ? `<span class="code">${esc(p.id)}</span>` : ''}</td>
        <td>${esc(p.kota)}<div class="cell-sub">${esc(p.provinsi)}</div></td><td>${pill(topLabel(p.top), p.top === 'Tunai' ? 'ok' : 'pri')}</td><td class="num">${esc(p.kontak)}</td>
        <td>${esc(p.idSalesman ? salesOf(p.idSalesman).nama : '-')}</td><td>${p.lat !== '' ? pill('Ada', 'ok', 1) : pill('Belum', 'warn')}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div id="impErr" class="invalid-msg mt-2"></div>`;
  $('#appModalContent .modal-footer').innerHTML = `<button class="btn btn-outline" onclick="impStepMap()"><i class="bi bi-arrow-left"></i> Ubah Kolom</button>
    <button class="btn btn-primary" id="impGo" ${total ? '' : 'disabled'}><i class="bi bi-cloud-upload"></i> Impor ${total} Toko</button>`;
  $('#impGo').onclick = () => impRun(false, $('#impGo'));
}
async function clearServerCache(btn) {
  const done = busy(btn, 'Menyegarkan…');
  try { await api('clearServerCache'); await syncNow(true); toast('Cache server dikosongkan & data terbaru dimuat.', 'ok'); }
  catch (e) { e.type !== 'auth' && toast(e.message, 'bad'); } finally { done(); }
}
