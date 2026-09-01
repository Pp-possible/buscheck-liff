/**
 * app.js — BusCheck
 * bootstrap, router, api(), คิวออฟไลน์, กล้อง
 */

const CFG = window.BUSCHECK_CONFIG;

// ไอคอน SVG (อ้างอิง <symbol> ที่นิยามไว้ใน index.html) — ใช้แทน emoji ทั้งหมด
function ic(name, cls) {
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '"><use href="#i-' + name + '"></use></svg>';
}

// ต้องประกาศก่อน boot() เรียกใช้ (renderHomeFromData_ อาจถูกเรียกจาก boot() ทันทีถ้ามีแคชอยู่แล้ว)
const TILE_ICONS = { scan: ic('camera'), vouchQr: ic('id-card'), myRounds: ic('list'), manageBus: ic('bus') };

const state = {
  sessionToken: null,
  persona: null,
  profile: null,
  permissions: [],
  buses: [],
  permVersion: 0,
  currentRoundId: null,
  busRounds: { BOARD: null, DROP: null },
  vouchTickets: [],
  vouchTicketIdx: 0,
  vouchTimer: null,
  regType: null,   // 'TEACHER' | 'STUDENT'
  ticket: null,
  sponsor: null,
  html5Qr: null,
  html5QrVouch: null,
  scanHistory: {},  // clientEventId -> true, กันยิงซ้ำเร็วเกินไปจากกล้อง
  bootReady: false, // true เมื่อ auth.bootstrap ผ่านแล้วจริง (ก่อนหน้านี้หน้าจออาจวาดจากแคชไปก่อน)
  pendingRoute: null
};

// ---------------------------------------------------------------------------
// แคชหน้าจอ (stale-while-revalidate) — วาดจากของเก่าทันทีให้รู้สึกเหมือนเปิดแอพเกม
// แล้วค่อยยิงไปเซิร์ฟเวอร์เงียบ ๆ เพื่ออัปเดตทับ พร้อมปุ่มรีเฟรชให้กดยืนยันเอง
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'buscheck_cache_';

function cacheGet_(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function cacheSet_(key, data) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data: data, cachedAt: Date.now() })); } catch (e) {}
}

function setSyncBadge_(elId, mode, ts) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('loading');
  if (mode === 'loading') { el.innerHTML = ic('refresh', 'btn-refresh-spin') + ' กำลังอัปเดต...'; el.classList.add('loading'); }
  else if (mode === 'cache') { el.innerHTML = ic('save') + ' ข้อมูลล่าสุดที่บันทึกไว้ — กำลังตรวจสอบใหม่'; }
  else if (mode === 'fresh') { el.innerHTML = ic('check-circle', 'icon-ok') + ' อัปเดตแล้ว ' + new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }); flashSynced_(elId); }
  else if (mode === 'error') { el.innerHTML = ic('alert-triangle', 'icon-error') + ' อัปเดตไม่สำเร็จ — แตะปุ่มรีเฟรชเพื่อลองใหม่'; }
}
function flashSynced_(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
function spinRefreshBtn_(btnId, on) {
  const el = document.getElementById(btnId);
  if (el) el.classList.toggle('btn-refresh-spin', !!on);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

// กันกดปุ่มซ้ำระหว่างรอ API ตอบ (double-submit) — ปิดปุ่มไว้ระหว่างทำงาน คืนสภาพให้เสมอไม่ว่าสำเร็จ
// หรือพัง ปุ่มที่ปิดอยู่แล้วจะเห็นเป็นสีจาง ๆ ตาม .btn[disabled] ใน styles.css โดยอัตโนมัติ
function guardClick_(fn) {
  return async function (e) {
    const btn = e && e.currentTarget;
    if (btn) {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
    }
    try { await fn(e); } finally {
      if (btn) { btn.disabled = false; delete btn.dataset.busy; }
    }
  };
}

function onClickGuarded_(id, fn) {
  document.getElementById(id).addEventListener('click', guardClick_(fn));
}

function beep(freq, duration) {
  try {
    const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq; osc.type = 'sine';
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.start(); osc.stop(ctx.currentTime + duration / 1000);
  } catch (e) { /* เสียงเป็นแค่ feedback เสริม ไม่ใช่ตัวบล็อกการทำงาน */ }
}

function feedbackSuccess() { beep(880, 120); vibrate(60); }
function feedbackTransfer() { beep(660, 160); vibrate([40, 40, 40]); }
function feedbackDuplicate() { beep(520, 100); vibrate([30, 30]); }
function feedbackError() { beep(220, 300); vibrate(300); }

const qrInstances_ = {};
function renderQr_(elId, text) {
  if (qrInstances_[elId]) {
    qrInstances_[elId].clear();
    qrInstances_[elId].makeCode(text);
  } else {
    document.getElementById(elId).innerHTML = '';
    qrInstances_[elId] = new QRCode(elId, { text: text, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  }
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function thaiDateNow() {
  const d = new Date();
  const be = d.getFullYear() + 543;
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + be;
}

// scheduledAt = "YYYY-MM-DDTHH:mm" (ค่าจาก <input type=datetime-local> หรือจาก backend ตรง ๆ)
function formatThaiDateTime_(scheduledAt) {
  if (!scheduledAt || scheduledAt.indexOf('T') === -1) return '';
  const [datePart, timePart] = scheduledAt.split('T');
  const [y, m, dd] = datePart.split('-').map(Number);
  const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return dd + ' ' + months[m - 1] + ' ' + (y + 543) + ' เวลา ' + timePart.slice(0, 5) + ' น.';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === name));
  window.scrollTo(0, 0);
  if (name !== 'S-03' && state.html5Qr) stopScanCamera_();
  if (name !== 'S-00b' && state.html5QrVouch) stopVouchCamera_();
  if (name !== 'S-19' && state.vouchTimer) { clearInterval(state.vouchTimer); state.vouchTimer = null; }
}

document.addEventListener('click', (e) => {
  const back = e.target.closest('[data-back]');
  if (back) showScreen(back.dataset.back);
});

// ---------------------------------------------------------------------------
// api() — ทุก request เป็น POST, Content-Type: text/plain;charset=utf-8 (N10)
// ---------------------------------------------------------------------------

async function api(action, payload) {
  const body = { action: action, sessionToken: state.sessionToken, payload: payload || {} };
  let res;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000); // เชื่อมต่อค้าง (เช่น connection ตายเงียบใน webview) ต้องไม่แขวนถาวร
  try {
    res = await fetch(CFG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
  } catch (networkErr) {
    return { ok: false, data: null, error: { code: 'E_NETWORK', message: 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ต' } };
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = await res.json(); } catch (e) {
    return { ok: false, data: null, error: { code: 'E_INTERNAL', message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่' } };
  }
  if (typeof json.permVersion === 'number' && json.permVersion !== state.permVersion) {
    state.permVersion = json.permVersion;
    refreshProfileSilently_();
  }
  return json;
}

async function refreshProfileSilently_() {
  if (!state.sessionToken) return;
  const r = await api('me.profile', {});
  if (r.ok) {
    state.permissions = r.data.permissions;
    state.buses = r.data.buses;
  }
}

// ---------------------------------------------------------------------------
// คิวออฟไลน์ (6.9)
// ---------------------------------------------------------------------------

const QUEUE_KEY = 'buscheck_offline_queue';

function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); updateOfflineBanner(); }

function enqueueScan(roundId, event) {
  const q = getQueue();
  if (q.length >= CFG.MAX_OFFLINE_QUEUE) { toast('คิวออฟไลน์เต็ม กรุณาหาสัญญาณอินเทอร์เน็ตด่วน'); return; }
  q.push({ roundId, event });
  setQueue(q);
}

function updateOfflineBanner() {
  const n = getQueue().length;
  ['offline-banner', 'offline-banner-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) { el.innerHTML = ic('alert-triangle') + ' ยังไม่ส่ง ' + n + ' รายการ (ออฟไลน์)'; el.classList.add('show'); }
    else { el.classList.remove('show'); }
  });
}

async function flushQueue() {
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;

  const byRound = {};
  q.forEach(item => { (byRound[item.roundId] = byRound[item.roundId] || []).push(item.event); });

  let duplicateCount = 0;
  const stillQueued = [];

  for (const roundId of Object.keys(byRound)) {
    const events = byRound[roundId].slice(0, CFG.MAX_OFFLINE_QUEUE);
    const r = await api('scan.submit', { roundId, events });
    if (!r.ok) { byRound[roundId].forEach(ev => stillQueued.push({ roundId, event: ev })); continue; }
    r.data.results.forEach(res => { if (res.result === 'DUPLICATE_IN_ROUND') duplicateCount++; });
    if (state.currentRoundId === roundId) renderScanCounts_(r.data.counts);
  }

  setQueue(stillQueued);
  if (duplicateCount > 0) toast(duplicateCount + ' รายการซ้ำกับที่มีคนเช็คไว้แล้ว');
}

setInterval(flushQueue, (CFG.OFFLINE_FLUSH_SEC || 5) * 1000);
window.addEventListener('online', flushQueue);
updateOfflineBanner();

// ---------------------------------------------------------------------------
// Bootstrap — จุดเริ่มต้นของแอพ
// ---------------------------------------------------------------------------

// รองรับลิงก์เจาะจงหน้า (?p=scan/vouch/bus) — ใช้กับปุ่ม Rich Menu ของบอทตอบกลับ (เฟส 3, 9.7)
// LIFF ตอน redirect ผ่านหน้า login อาจย้าย query string เดิมไปไว้ใน liff.state แทน จึงต้องเช็คทั้งสองที่
function deepLinkRoute_() {
  const ROUTE_MAP = { scan: 'S-02', vouch: 'S-19', bus: 'S-20' };
  let p = new URLSearchParams(location.search).get('p');
  if (!p && liff.state) p = new URLSearchParams(liff.state.replace(/^\?/, '')).get('p');
  return ROUTE_MAP[p] || null;
}

async function boot() {
  // เช็คลิงก์เจาะจงหน้า (?p=...) จาก URL ทันทีตั้งแต่ต้น ก่อน liff.init() เลย (อ่าน location.search
  // ได้โดยไม่ต้องรอ LIFF) เพื่อไม่ให้วาดหน้าแรกจาก cache ทับก่อน — ปุ่ม Rich Menu ที่ตั้งใจพาไปหน้า
  // เจาะจงจะได้ไม่ต้องเห็นหน้า home วาบขึ้นมาก่อนเด้งไปหน้าที่ต้องการ
  state.pendingRoute = deepLinkRoute_();

  // วาดหน้าแรกจากแคชทันที (ถ้าเคยเปิดสำเร็จมาก่อน) ก่อนรอ LIFF/เซิร์ฟเวอร์เลย — ข้ามขั้นนี้ถ้ามี
  // ลิงก์เจาะจงหน้าอยู่แล้ว เพราะปลายทางจริงไม่ใช่หน้าแรก ไม่ต้องวาดหน้าแรกให้เสียเวลา/วาบจอ
  const cachedHome = cacheGet_('home');
  if (cachedHome && cachedHome.data && !state.pendingRoute) {
    renderHomeFromData_(cachedHome.data);
    setSyncBadge_('s01-sync', 'cache', cachedHome.cachedAt);
    showScreen('S-01');
  }

  try {
    let idToken;
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      idToken = liff.getIDToken();
      // liff.state มีค่าได้ก็ต่อเมื่อ liff.init() เสร็จแล้วเท่านั้น (LIFF ย้าย query string เดิมไปไว้ที่นี่
      // ตอน redirect ผ่านหน้า login) เช็คซ้ำอีกทีเผื่อรอบแรกจาก location.search เพียวๆ ยังไม่เจอ
      if (!state.pendingRoute) state.pendingRoute = deepLinkRoute_();
    } catch (e) {
      if (!cachedHome) toast('เปิดผ่าน LINE เท่านั้น กรุณาเปิดลิงก์นี้ในแอพ LINE');
      else { toast('เชื่อมต่อไม่ได้ กำลังแสดงข้อมูลล่าสุดที่บันทึกไว้'); setSyncBadge_('s01-sync', 'error'); }
      return;
    }
    if (!idToken) {
      if (!cachedHome) toast('ยืนยันตัวตนไม่สำเร็จ กรุณาเปิดแอพใหม่');
      return;
    }

    const r = await api('auth.bootstrap', { idToken: idToken });
    if (!r.ok) {
      if (r.error.code === 'E_PENDING_APPROVAL') { toast(r.error.message); return; }
      if (!cachedHome) toast(r.error.message || 'เข้าสู่ระบบไม่สำเร็จ');
      else { toast('เชื่อมต่อไม่ได้ กำลังแสดงข้อมูลล่าสุดที่บันทึกไว้'); setSyncBadge_('s01-sync', 'error'); }
      return;
    }

    state.permVersion = r.permVersion;

    if (!r.data.known) {
      renderGateModes_(r.data.gateModes);
      showScreen('S-00a');
      return;
    }

    applySession_(r.data);
    state.bootReady = true;

    if (state.persona === 'STUDENT') {
      showScreen('S-21');
      loadStudentHome_();
    } else if (state.pendingRoute) {
      // มีลิงก์เจาะจงหน้า — ไปหน้านั้นตรง ๆ เลย ไม่ต้องผ่านหน้าแรกให้เห็นวาบก่อน แต่ยังโหลดข้อมูล
      // หน้าแรกเงียบ ๆ อยู่เบื้องหลังไว้ด้วย (renderHome_ ไม่เรียก showScreen) กันหน้าแรกว่างเปล่า
      // ตอนกดย้อนกลับจากหน้าที่ลิงก์พาไป
      const route = state.pendingRoute;
      state.pendingRoute = null;
      navigateTile_(route);
      renderHome_({ silent: true });
    } else {
      showScreen('S-01');
      renderHome_({ silent: !!cachedHome });
    }
  } finally {
    window.__buscheckBootReady = true;
  }
}

function applySession_(data) {
  state.sessionToken = data.sessionToken;
  state.persona = data.persona;
  state.profile = data.profile;
  state.permissions = data.permissions || [];
}

function renderGateModes_(modes) {
  document.getElementById('btn-reg-teacher').style.display = modes.sponsorQr ? 'block' : 'none';
  document.getElementById('btn-reg-student').style.display = modes.sponsorQr ? 'block' : 'none';
}

document.getElementById('btn-logout').addEventListener('click', () => {
  state.sessionToken = null;
  try { liff.logout(); } catch (e) {}
  location.reload();
});

boot();

// ---------------------------------------------------------------------------
// S-00 — ลงทะเบียนด้วย QR ผู้รับรอง
// ---------------------------------------------------------------------------

document.getElementById('btn-reg-teacher').addEventListener('click', () => startVouchScan_('TEACHER'));
document.getElementById('btn-reg-student').addEventListener('click', () => startVouchScan_('STUDENT'));

function startVouchScan_(regType) {
  state.regType = regType;
  document.getElementById('s00b-title').textContent = regType === 'TEACHER' ? 'ลงทะเบียนเป็นครู' : 'ลงทะเบียนเป็นนักเรียน';
  document.getElementById('s00b-instruction').textContent = regType === 'TEACHER'
    ? 'ให้ผู้ดูแลระบบสูงสุดเปิดหน้า "QR รับรองของฉัน" แล้วสแกนที่นี่'
    : 'ให้ครูเปิดหน้า "QR รับรองของฉัน" แล้วสแกนที่นี่';
  showScreen('S-00b');
  startVouchCamera_();
}

function startVouchCamera_() {
  const el = document.getElementById('qr-reader-vouch');
  el.innerHTML = '';
  const qr = new Html5Qrcode('qr-reader-vouch');
  state.html5QrVouch = qr;
  qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 },
    (decodedText) => onVouchQrDecoded_(decodedText),
    () => {}
  ).catch(() => toast('เปิดกล้องไม่ได้ กรุณาอนุญาตการใช้กล้อง'));
}

function stopVouchCamera_() {
  if (state.html5QrVouch) { state.html5QrVouch.stop().catch(() => {}); state.html5QrVouch = null; }
}

let vouchScanLock = false;
async function onVouchQrDecoded_(rawQr) {
  if (vouchScanLock) return;
  vouchScanLock = true;
  stopVouchCamera_();

  let idToken;
  try { idToken = liff.getIDToken(); } catch (e) { idToken = null; }

  const r = await api('vouch.verify', { idToken: idToken, rawQr: rawQr, regType: state.regType });
  if (!r.ok) {
    feedbackError();
    toast(voutchErrorMessage_(r.error.code, r.error.message));
    vouchScanLock = false;
    startVouchCamera_();
    return;
  }

  feedbackSuccess();
  state.ticket = r.data.ticket;
  state.sponsor = r.data.sponsor;
  vouchScanLock = false;
  showVouchForm_(r.data);
}

function voutchErrorMessage_(code, fallback) {
  const map = {
    E_VOUCH_EXPIRED: 'QR หมดอายุแล้ว — ขอให้ผู้รับรองกดสร้างใหม่',
    E_VOUCH_LEVEL: fallback,
    E_WRONG_QR_FAMILY: 'นี่คือ QR ประจำตัวนักเรียน ไม่ใช่ QR ผู้รับรอง',
    E_VOUCH_USED: 'QR นี้ถูกใช้ไปแล้ว ขอให้ผู้รับรองสร้างใหม่',
    E_ALREADY_REGISTERED: 'บัญชี LINE นี้ลงทะเบียนไว้แล้ว'
  };
  return map[code] || fallback;
}

let s00cTimer = null;
function showVouchForm_(data) {
  document.getElementById('s00c-sponsor-name').textContent = data.sponsor.name;
  document.getElementById('s00c-sponsor-role').textContent = data.sponsor.role;

  const expiresAt = new Date(data.expiresAt).getTime();
  clearInterval(s00cTimer);
  s00cTimer = setInterval(() => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    document.getElementById('s00c-countdown').textContent = '⏱ กรอกให้เสร็จภายใน ' + m + ':' + String(s).padStart(2, '0') + ' นาที';
    if (left <= 0) { clearInterval(s00cTimer); toast('หมดเวลากรอกฟอร์ม กรุณาสแกน QR ผู้รับรองใหม่'); showScreen('S-00a'); }
  }, 1000);

  document.getElementById('s00c-form-teacher').style.display = state.regType === 'TEACHER' ? 'block' : 'none';
  document.getElementById('s00c-form-student').style.display = state.regType === 'STUDENT' ? 'block' : 'none';

  if (state.regType === 'TEACHER') {
    renderBusChips_();
  } else {
    populateBusStopSelects_();
    document.querySelectorAll('#s00c-form-student .chip[data-ride], #s00c-form-student .chip[data-day]').forEach(chip => {
      chip.onclick = () => chip.classList.toggle('selected');
    });
  }
  showScreen('S-00c');
}

async function renderBusChips_() {
  const r = await api('me.buses', {});
  const buses = (r.ok ? r.data : []);
  const wrap = document.getElementById('t-buses');
  wrap.innerHTML = buses.map(b => '<div class="chip" data-bus="' + b.bus_id + '">' + b.bus_code + '</div>').join('') || '<span style="color:var(--text-muted);font-size:13px">(ยังไม่มีรถในระบบ — ให้ผู้ดูแลกำหนดภายหลัง)</span>';
  wrap.querySelectorAll('.chip').forEach(c => c.onclick = () => c.classList.toggle('selected'));
}

async function populateBusStopSelects_() {
  // ตอนลงทะเบียนนักเรียนยังไม่มี session (ticket-only) — ใช้รายการรถ/จุดจอดจากผู้รับรอง (ครู) ไม่ได้
  // จึงให้กรอกรหัสรถ/จุดจอดเป็นข้อความอิสระผ่าน select ที่โหลดจาก me.buses ถ้ามี session ชั่วคราวไม่มี ก็ปล่อยว่างให้ผู้ดูแลเติมทีหลัง
  const busSel = document.getElementById('s-busId');
  const stopSel = document.getElementById('s-stopId');
  busSel.innerHTML = '<option value="">— เลือกรถ —</option>';
  stopSel.innerHTML = '<option value="">— เลือกจุดจอด —</option>';
}

onClickGuarded_('btn-submit-teacher', async () => {
  const fullName = document.getElementById('t-fullName').value.trim();
  const phone = document.getElementById('t-phone').value.trim();
  if (!fullName || !phone) { toast('กรุณากรอกชื่อและเบอร์โทรให้ครบ'); return; }
  const busIds = Array.from(document.querySelectorAll('#t-buses .chip.selected')).map(c => c.dataset.bus);

  const r = await api('reg.submitTeacher', {
    ticket: state.ticket, fullName: fullName, phone: phone,
    employeeCode: document.getElementById('t-employeeCode').value.trim(), requestedBusIds: busIds
  });
  if (!r.ok) { toast(r.error.message); return; }
  applySession_(r.data);
  clearInterval(s00cTimer);
  document.getElementById('s00d-message').textContent = 'ลงทะเบียนสำเร็จ · สิทธิ์: ' + (r.data.user.role || 'ครูประจำรถ') + ' · รับรองโดย ' + state.sponsor.name;
  document.getElementById('s00d-qr-box').style.display = 'none';
  showScreen('S-00d');
});

onClickGuarded_('btn-submit-student', async () => {
  const payload = {
    ticket: state.ticket,
    fullName: document.getElementById('s-fullName').value.trim(),
    nickname: document.getElementById('s-nickname').value.trim(),
    classLevel: document.getElementById('s-classLevel').value.trim(),
    room: document.getElementById('s-room').value.trim(),
    guardianName: document.getElementById('s-guardianName').value.trim(),
    guardianPhone: document.getElementById('s-guardianPhone').value.trim(),
    busId: document.getElementById('s-busId').value,
    stopId: document.getElementById('s-stopId').value,
    rideAm: document.querySelector('.chip[data-ride="am"]').classList.contains('selected'),
    ridePm: document.querySelector('.chip[data-ride="pm"]').classList.contains('selected'),
    serviceDays: Array.from(document.querySelectorAll('#s-serviceDays .chip.selected')).map(c => c.dataset.day)
  };
  if (!payload.fullName || !payload.classLevel || !payload.room || !payload.guardianName || !payload.guardianPhone) {
    toast('กรุณากรอกข้อมูลให้ครบถ้วน'); return;
  }
  const r = await api('reg.submitStudent', payload);
  if (!r.ok) { toast(r.error.message); return; }
  applySession_({ sessionToken: r.data.sessionToken, persona: 'STUDENT', profile: r.data.student, permissions: [] });
  clearInterval(s00cTimer);
  document.getElementById('s00d-message').textContent = 'ลงทะเบียนสำเร็จ · ใช้ QR นี้ให้ครูสแกนตอนขึ้น-ลงรถ';
  document.getElementById('s00d-qr-box').style.display = 'block';
  renderQr_('s00d-qr-canvas', r.data.qrPayload);
  showScreen('S-00d');
});

document.getElementById('btn-goto-home').addEventListener('click', () => {
  if (state.persona === 'STAFF') { showScreen('S-01'); renderHome_(); }
  else { showScreen('S-21'); loadStudentHome_(); }
});

// ---------------------------------------------------------------------------
// S-01 หน้าแรก
// ---------------------------------------------------------------------------

function renderHomeFromData_(data) {
  document.getElementById('s01-name').textContent = data.profile.name;
  document.getElementById('s01-role').textContent = data.profile.role || '';
  document.getElementById('s01-sponsor').textContent = data.profile.registered_by_name
    ? 'เพิ่มโดย ' + data.profile.registered_by_name : '';

  const tilesWrap = document.getElementById('s01-tiles');
  tilesWrap.innerHTML = data.tiles.map(t => (
    '<div class="tile" data-tile="' + t.key + '" data-route="' + (t.route || '') + '">' +
    '<span class="icon-wrap">' + (TILE_ICONS[t.key] || ic('list')) + '</span>' +
    '<span class="label">' + t.label + '</span>' +
    (t.badge ? '<span class="badge">' + t.badge + '</span>' : '') +
    '</div>'
  )).join('');

  tilesWrap.querySelectorAll('.tile').forEach(el => {
    el.addEventListener('click', () => {
      const route = el.dataset.route;
      if (!state.bootReady) { state.pendingRoute = route; toast('กำลังเชื่อมต่อ รอสักครู่...'); return; }
      navigateTile_(route);
    });
  });
}

function navigateTile_(route) {
  if (route === 'S-02') { showScreen('S-02'); loadRounds_(); }
  else if (route === 'S-19') { showScreen('S-19'); startVouchQrLoop_(); }
  else if (route === 'S-20') { showScreen('S-20'); loadBuses_(); }
}

async function renderHome_(opts) {
  opts = opts || {};
  const cached = cacheGet_('home');
  if (cached && !opts.silent) {
    renderHomeFromData_(cached.data);
    setSyncBadge_('s01-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s01-sync', 'loading');
  spinRefreshBtn_('btn-refresh-home', true);

  const r = await api('me.home', {});
  spinRefreshBtn_('btn-refresh-home', false);
  if (!r.ok) {
    if (!cached) toast(r.error.message);
    setSyncBadge_('s01-sync', 'error');
    return;
  }

  cacheSet_('home', r.data);
  renderHomeFromData_(r.data);
  setSyncBadge_('s01-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-home').addEventListener('click', () => renderHome_());

// ---------------------------------------------------------------------------
// S-02 เลือกรอบเช็ค
// ---------------------------------------------------------------------------

document.getElementById('btn-refresh-rounds').addEventListener('click', () => loadRounds_());

const ROUND_TYPE_LABELS_ = { BOARD: 'ขึ้นรถ', DROP: 'ลงรถ', HEADCOUNT: 'นับยอด', ACTIVITY: 'กิจกรรม' };

function renderRoundsList_(rounds) {
  const list = document.getElementById('s02-list');
  if (!rounds.length) { list.innerHTML = '<div class="empty-state">วันนี้ยังไม่มีรอบเช็ค</div>'; return; }

  state.roundsById = {};
  rounds.forEach(r => { state.roundsById[r.round_id] = r; });

  const canManage = state.permissions && state.permissions.indexOf('round.open') !== -1;

  list.innerHTML = rounds.map(round => {
    const statusClass = round.status === 'OPEN' ? 'open' : (round.status === 'CLOSED' ? 'closed' : '');
    const statusLabel = round.status === 'OPEN' ? 'เปิดอยู่' : round.status === 'CLOSED' ? 'ปิดแล้ว' : 'รอเปิด';
    const checkers = round.checkers.map(c => c.name).join(' + ') || ('ยังไม่มอบหมายผู้เช็ค ' + ic('alert-triangle', 'icon-amber'));
    const isPlanned = round.status === 'PLANNED';
    const busLabel = (state.busMap && state.busMap[round.scope_id]) || round.scope_id || '';
    const typeLabel = ROUND_TYPE_LABELS_[round.round_type] || round.round_type;

    let html = '<div class="round-item ' + statusClass + '" data-round="' + round.round_id + '" data-status="' + round.status + '">';
    if (isPlanned && canManage) {
      html += '<div class="round-item-actions" data-delete="' + round.round_id + '">ลบ</div>';
      html += '<div class="round-item-content swipeable">';
    } else {
      html += '<div class="round-item-content">';
    }

    html += '<div class="row1"><span class="status-dot"></span> ' + round.seq + '. ' + round.round_name + ' — ' + round.checked + '/' + round.expected + ' ' + statusLabel + '</div>' +
      '<div class="progress">' + formatThaiDateTime_(round.scheduled_at) + ' · ' + typeLabel + ' · ' + busLabel + '</div>' +
      '<div class="progress">' + checkers + '</div>' +
      (round.duplicateAttempts > 0 ? '<div class="warn">' + ic('alert-triangle') + ' มีการเช็คซ้ำ ' + round.duplicateAttempts + ' ครั้ง</div>' : '') +
      (isPlanned ? '<button class="btn btn-secondary" style="margin-top:8px" data-open="' + round.round_id + '">เปิดรอบ</button>' : '') +
      (round.status === 'OPEN' ? '<button class="btn btn-primary" style="margin-top:8px" data-enter="' + round.round_id + '">เช็คต่อ →</button>' : '') +
      (isPlanned && canManage ? '<button class="btn btn-secondary" style="margin-top:8px" data-edit="' + round.round_id + '">แก้ไข</button>' : '') +
      (canManage ? '<button class="btn btn-secondary" style="margin-top:8px" data-duplicate="' + round.round_id + '">ทำซ้ำ</button>' : '') +
      '</div></div>';
    return html;
  }).join('');

  list.querySelectorAll('[data-open]').forEach(btn => btn.addEventListener('click', () => openRound_(btn.dataset.open)));
  list.querySelectorAll('[data-enter]').forEach(btn => btn.addEventListener('click', () => enterScanScreen_(btn.dataset.enter)));
  list.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => openCreateRoundDialog_(state.roundsById[btn.dataset.edit], false)));
  list.querySelectorAll('[data-duplicate]').forEach(btn => btn.addEventListener('click', () => openCreateRoundDialog_(state.roundsById[btn.dataset.duplicate], true)));
  list.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', guardClick_(async (e) => {
    if (!confirm('ยืนยันลบรอบเช็คนี้?')) return;
    const roundId = e.currentTarget.dataset.delete;
    const r = await api('round.delete', { roundId });
    if (!r.ok) { toast(r.error.message); return; }
    toast('ลบรอบสำเร็จ');
    loadRounds_({ silent: true });
  })));

  // Swipe logic
  let startX = 0, currentX = 0;
  list.querySelectorAll('.swipeable').forEach(el => {
    el.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      currentX = 0;
      el.style.transition = 'none';
    }, {passive: true});
    el.addEventListener('touchmove', e => {
      currentX = e.touches[0].clientX - startX;
      if (currentX > 0) currentX = 0; // only swipe left
      if (currentX < -100) currentX = -100; // max swipe
      el.style.transform = 'translateX(' + currentX + 'px)';
    }, {passive: true});
    el.addEventListener('touchend', e => {
      el.style.transition = 'transform 0.2s ease-out';
      if (currentX < -50) {
        el.style.transform = 'translateX(-80px)'; // snap open
      } else {
        el.style.transform = 'translateX(0)'; // snap close
      }
      currentX = 0;
    });
  });
}

async function ensureBusMap_() {
  if (state.busMap) return;
  const r = await api('me.buses', {});
  state.busMap = {};
  if (r.ok) (r.data || []).forEach(b => { state.busMap[b.bus_id] = b.bus_name || b.bus_code; });
}

async function loadRounds_(opts) {
  opts = opts || {};
  const list = document.getElementById('s02-list');
  const cached = cacheGet_('rounds');
  if (cached && !opts.silent) {
    await ensureBusMap_();
    renderRoundsList_(cached.data);
    setSyncBadge_('s02-sync', 'cache', cached.cachedAt);
  } else if (!cached) {
    list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }
  setSyncBadge_('s02-sync', 'loading');
  spinRefreshBtn_('btn-refresh-rounds', true);

  const [r] = await Promise.all([api('round.today', {}), ensureBusMap_()]);
  spinRefreshBtn_('btn-refresh-rounds', false);
  if (!r.ok) {
    if (!cached) list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>';
    setSyncBadge_('s02-sync', 'error');
    return;
  }

  cacheSet_('rounds', r.data);
  renderRoundsList_(r.data);
  setSyncBadge_('s02-sync', 'fresh', Date.now());
}

document.getElementById('btn-new-round').addEventListener('click', () => openCreateRoundDialog_());
document.getElementById('dlg-create-round-cancel').addEventListener('click', () => {
  document.getElementById('dlg-create-round').classList.remove('show');
});

function nowForDatetimeLocal_() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); // ตัด offset ออกก่อน toISOString ให้ได้เวลาท้องถิ่นตรง ๆ
  return d.toISOString().slice(0, 16);
}

// existingRound: ไม่ใส่ = สร้างใหม่, ใส่ + duplicate=false = แก้ไขรอบเดิม, ใส่ + duplicate=true = ทำซ้ำเป็นรอบใหม่
async function openCreateRoundDialog_(existingRound, duplicate) {
  const busSel = document.getElementById('cr-bus');
  busSel.innerHTML = '<option value="">กำลังโหลด...</option>';
  document.getElementById('dlg-create-round-title').textContent = existingRound && !duplicate ? 'แก้ไขรอบเช็ค' : 'สร้างรอบเช็คใหม่';
  document.getElementById('dlg-create-round-submit').textContent = existingRound && !duplicate ? 'บันทึก' : 'สร้างรอบ';
  document.getElementById('cr-round-id').value = existingRound && !duplicate ? existingRound.round_id : '';
  document.getElementById('cr-name').value = existingRound ? existingRound.round_name : '';
  document.getElementById('cr-type').value = existingRound ? existingRound.round_type : 'BOARD';
  document.getElementById('cr-type').disabled = !!(existingRound && !duplicate); // แก้ประเภทรอบเดิมไม่ได้ (round.update ไม่รองรับ) — ทำซ้ำเป็นรอบใหม่แทนถ้าอยากเปลี่ยน
  document.getElementById('cr-scheduled-at').value = (existingRound && existingRound.scheduled_at) ? existingRound.scheduled_at.slice(0, 16) : nowForDatetimeLocal_();
  document.getElementById('cr-require-all').checked = existingRound ? existingRound.require_all : true;
  document.getElementById('dlg-create-round').classList.add('show');

  const r = await api('me.buses', {});
  if (!r.ok) { toast('โหลดรายการรถไม่ได้: ' + r.error.message); busSel.innerHTML = '<option value="">(โหลดไม่สำเร็จ)</option>'; return; }
  const buses = r.data || [];
  state.busMap = {};
  buses.forEach(b => { state.busMap[b.bus_id] = b.bus_name || b.bus_code; });
  busSel.innerHTML = buses.map(b => '<option value="' + b.bus_id + '">' + b.bus_code + (b.bus_name && b.bus_name !== b.bus_code ? ' · ' + b.bus_name : '') + '</option>').join('') || '<option value="">(ไม่มีรถในขอบเขตของคุณ)</option>';
  if (existingRound && buses.some(b => b.bus_id === existingRound.scope_id)) busSel.value = existingRound.scope_id;
}

onClickGuarded_('dlg-create-round-submit', async () => {
  const roundName = document.getElementById('cr-name').value.trim();
  const busId = document.getElementById('cr-bus').value;
  const scheduledAt = document.getElementById('cr-scheduled-at').value;
  const roundId = document.getElementById('cr-round-id').value;
  if (!roundName) { toast('กรุณาระบุชื่อรอบ'); return; }
  if (!busId) { toast('กรุณาเลือกรถ'); return; }
  if (!scheduledAt) { toast('กรุณาระบุวันที่และเวลาตรวจยอด'); return; }

  const r = roundId
    ? await api('round.update', {
        roundId: roundId, roundName: roundName, scopeId: busId, scheduledAt: scheduledAt,
        requireAll: document.getElementById('cr-require-all').checked
      })
    : await api('round.create', {
        scheduledAt: scheduledAt, scopeType: 'BUS', scopeId: busId,
        roundName: roundName, roundType: document.getElementById('cr-type').value,
        requireAll: document.getElementById('cr-require-all').checked
      });
  if (!r.ok) { toast(r.error.message); return; }

  document.getElementById('dlg-create-round').classList.remove('show');
  document.getElementById('cr-name').value = '';
  toast(roundId ? 'บันทึกการแก้ไขแล้ว' : 'สร้างรอบแล้ว — อย่าลืมมอบหมายผู้เช็คก่อนเปิดรอบ');
  loadRounds_({ silent: true });
});

async function openRound_(roundId) {
  const r = await api('round.open', { roundId: roundId });
  if (!r.ok) { toast(r.error.message); return; }
  toast('เปิดรอบแล้ว');
  loadRounds_({ silent: true });
}

// ---------------------------------------------------------------------------
// S-03 หน้าสแกน
// ---------------------------------------------------------------------------

async function enterScanScreen_(roundId) {
  state.currentRoundId = roundId;
  const r = await api('round.get', { roundId: roundId });
  if (!r.ok) { toast(r.error.message); return; }
  const round = r.data;

  document.getElementById('s03-round-name').textContent = round.round_name + ' (รอบ ' + round.seq + ')';
  document.getElementById('s03-round-sub').textContent = thaiDateNow() + ' · ผู้เช็ค: ' + round.checkers.map(c => c.name).join(', ');
  renderScanCounts_({ expected: round.expected, checked: round.checked });
  document.getElementById('s03-feed').innerHTML = '';

  const isBoard = round.round_type === 'BOARD';
  document.getElementById('s03-mode-board').classList.toggle('active', isBoard);
  document.getElementById('s03-mode-drop').classList.toggle('active', !isBoard);

  showScreen('S-03');
  startScanCamera_();
}

function renderScanCounts_(counts) {
  const queued = getQueue().filter(q => q.roundId === state.currentRoundId).length;
  document.getElementById('s03-count-onboard').textContent = counts.checked != null ? counts.checked : (counts.expected - (counts.remaining || 0));
  document.getElementById('s03-count-checked').textContent = counts.checked;
  document.getElementById('s03-count-remaining').textContent = Math.max(0, (counts.expected || 0) - (counts.checked || 0));
  if (queued > 0) document.getElementById('s03-count-checked').textContent += ' (+' + queued + ' รอส่ง)';
}

function startScanCamera_() {
  const el = document.getElementById('qr-reader');
  el.innerHTML = '';
  const qr = new Html5Qrcode('qr-reader');
  state.html5Qr = qr;
  qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 },
    (decodedText) => onScanDecoded_(decodedText),
    () => {}
  ).catch(() => toast('เปิดกล้องไม่ได้ กรุณาอนุญาตการใช้กล้อง'));
}

function stopScanCamera_() {
  if (state.html5Qr) { state.html5Qr.stop().catch(() => {}); state.html5Qr = null; }
}

let scanLock = false;
async function onScanDecoded_(rawQr) {
  if (scanLock) return;
  scanLock = true;
  await submitScanEvent_(rawQr, 'QR');
  setTimeout(() => { scanLock = false; }, 800); // สแกนต่อเนื่องอัตโนมัติใน 0.8 วินาที
}

async function submitScanEvent_(raw, method, extra) {
  const clientEventId = uuid();
  const event = Object.assign({ clientEventId: clientEventId, raw: raw, method: method, scannedAt: new Date().toISOString() }, extra || {});

  if (!navigator.onLine) {
    enqueueScan(state.currentRoundId, event);
    addFeedItem_({ result: 'QUEUED', message: 'บันทึกไว้แล้ว (รอส่งเมื่อมีสัญญาณ)', student: null });
    return;
  }

  const r = await api('scan.submit', { roundId: state.currentRoundId, events: [event] });
  if (!r.ok) {
    feedbackError();
    toast(r.error.message);
    return;
  }
  const result = r.data.results[0];
  renderScanCounts_(r.data.counts);
  handleScanResult_(result, event);
}

function handleScanResult_(result, originalEvent) {
  switch (result.result) {
    case 'OK':
    case 'MOVED_FROM_OTHER_BUS':
      feedbackSuccess();
      if (result.result === 'MOVED_FROM_OTHER_BUS') feedbackTransfer();
      addFeedItem_(result);
      break;
    case 'NEEDS_CONFIRM':
      showTransferDialog_(result, originalEvent);
      break;
    case 'DUPLICATE_IN_ROUND':
      feedbackDuplicate();
      showDuplicateDialog_(result, originalEvent);
      break;
    case 'ROUND_NOT_OPEN':
    case 'NOT_ASSIGNED':
    case 'UNKNOWN_QR':
    case 'REVOKED_CARD':
    case 'E_WRONG_QR_FAMILY':
    case 'REJECTED_TIME':
      feedbackError();
      addFeedItem_(result);
      break;
    default:
      addFeedItem_(result);
  }
}

function addFeedItem_(result) {
  const feed = document.getElementById('s03-feed');
  const cls = result.result === 'OK' ? 'ok' : result.result === 'MOVED_FROM_OTHER_BUS' ? 'transfer' :
    result.result === 'DUPLICATE_IN_ROUND' ? 'duplicate' : 'error';
  const icon = cls === 'ok' ? ic('check-circle', 'icon-ok') : cls === 'transfer' ? ic('transfer') : cls === 'duplicate' ? ic('alert-triangle', 'icon-amber') : ic('x-circle', 'icon-error');
  const name = result.student ? (result.student.nickname || result.student.name) + ' (' + result.student.name + ')' : '';
  const sub = result.student ? result.student.class : '';
  const div = document.createElement('div');
  div.className = 'scan-feed-item ' + cls;
  div.innerHTML = '<span class="feed-icon">' + icon + '</span>' +
    '<div><div class="name">' + (name || result.message) + '</div>' +
    '<div class="sub">' + (name ? (sub + ' · ' + (result.message || '')) : '') + '</div>' +
    (result.student && result.student.medical_note ? '<div class="medical">' + ic('alert-triangle', 'icon-amber') + ' ' + result.student.medical_note + '</div>' : '') +
    '</div>';
  feed.insertBefore(div, feed.firstChild);
}

// ---- Dialog: ยืนยันย้ายรถ / เปิดสถานะใหม่ ----
let pendingTransfer = null;
function showTransferDialog_(result, originalEvent) {
  pendingTransfer = { result, originalEvent };
  document.getElementById('dlg-transfer-title').textContent = 'ยืนยันย้ายรถ?';
  document.getElementById('dlg-transfer-body').textContent = result.message;
  document.getElementById('dlg-confirm-transfer').classList.add('show');
}
document.getElementById('dlg-transfer-cancel').addEventListener('click', () => {
  document.getElementById('dlg-confirm-transfer').classList.remove('show');
  pendingTransfer = null;
});
onClickGuarded_('dlg-transfer-confirm', async () => {
  document.getElementById('dlg-confirm-transfer').classList.remove('show');
  if (!pendingTransfer) return;
  await submitScanEvent_(pendingTransfer.originalEvent.raw, pendingTransfer.originalEvent.method, { confirmTransfer: true });
  pendingTransfer = null;
});

// ---- Dialog: เช็คซ้ำ ----
let pendingDuplicate = null;
function showDuplicateDialog_(result, originalEvent) {
  pendingDuplicate = { result, originalEvent };
  document.getElementById('dlg-duplicate-body').innerHTML =
    (result.student ? '<strong>' + (result.student.nickname || result.student.name) + '</strong> · ' + result.student.name + '<br>' : '') +
    'เช็คโดย ' + result.existingCheck.checked_by_name + '<br>เมื่อ ' + new Date(result.existingCheck.checked_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) +
    ' (' + result.existingCheck.minutesAgo + ' นาทีที่แล้ว)';
  document.getElementById('dlg-duplicate-override').style.display = result.canOverride ? 'inline-flex' : 'none';
  document.getElementById('dlg-duplicate').classList.add('show');
}
document.getElementById('dlg-duplicate-ack').addEventListener('click', () => {
  document.getElementById('dlg-duplicate').classList.remove('show');
  pendingDuplicate = null;
});
onClickGuarded_('dlg-duplicate-override', async () => {
  document.getElementById('dlg-duplicate').classList.remove('show');
  if (!pendingDuplicate) return;
  const reason = prompt('ระบุเหตุผลที่เช็คทับ (เช่น เช็คผิดคน / ผลเดิมผิด)') || 'อื่น ๆ';
  await submitScanEvent_(pendingDuplicate.originalEvent.raw, pendingDuplicate.originalEvent.method, { confirmOverride: true, overrideReason: reason });
  pendingDuplicate = null;
});

// ---- ค้นหาชื่อ (บัตรหาย/QR เสีย) ----
let searchDebounce = null;
document.getElementById('s03-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('s03-search-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  searchDebounce = setTimeout(async () => {
    const r = await api('student.searchAll', { q: q });
    if (!r.ok) return;
    resultsEl.innerHTML = r.data.map(s =>
      '<div class="roster-row" data-add="' + s.student_id + '"><div><div class="name">' + (s.nickname || s.name) + '</div>' +
      '<div class="meta">' + s.name + ' · ' + s.class + '</div></div></div>'
    ).join('') || '<div class="empty-state">ไม่พบรายชื่อ</div>';
    resultsEl.querySelectorAll('[data-add]').forEach(row => row.addEventListener('click', () => addStudentToRound_(row.dataset.add)));
  }, 300);
});

async function addStudentToRound_(studentId) {
  const r = await api('trip.addStudent', { roundId: state.currentRoundId, studentId: studentId, clientEventId: uuid() });
  document.getElementById('s03-search').value = '';
  document.getElementById('s03-search-results').innerHTML = '';
  if (!r.ok) { toast(r.error.message); return; }
  renderScanCounts_(r.data.counts);
  if (r.data.scanResult) handleScanResult_(r.data.scanResult, {});
}

document.getElementById('s03-mode-board').addEventListener('click', () => switchScanMode_('BOARD'));
document.getElementById('s03-mode-drop').addEventListener('click', () => switchScanMode_('DROP'));

async function switchScanMode_(type) {
  const r = await api('round.today', {});
  if (!r.ok) return;
  const round = r.data.find(x => x.round_id === state.currentRoundId);
  if (!round) return;
  const target = r.data.find(x => x.scope_id === round.scope_id && x.round_type === type && x.status === 'OPEN');
  if (!target) { toast('ยังไม่มีรอบประเภทนี้เปิดอยู่'); return; }
  enterScanScreen_(target.round_id);
}

document.getElementById('btn-goto-s04').addEventListener('click', () => { showScreen('S-04'); loadRoster_(); });
document.getElementById('btn-goto-s05').addEventListener('click', () => { showScreen('S-05'); loadCloseScreen_(); });

// ---------------------------------------------------------------------------
// S-04 รายชื่อ
// ---------------------------------------------------------------------------

let rosterCache = [];
let rosterTab = 'all';

async function loadRoster_() {
  const cacheKey = 'roster_' + state.currentRoundId;
  const cached = cacheGet_(cacheKey);
  if (cached) {
    rosterCache = cached.data;
    renderRosterList_();
    setSyncBadge_('s04-sync', 'cache', cached.cachedAt);
  } else {
    document.getElementById('s04-list').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  }
  setSyncBadge_('s04-sync', 'loading');
  spinRefreshBtn_('btn-refresh-roster', true);

  const r = await api('round.checks', { roundId: state.currentRoundId });
  spinRefreshBtn_('btn-refresh-roster', false);
  if (!r.ok) {
    if (!cached) toast(r.error.message);
    setSyncBadge_('s04-sync', 'error');
    return;
  }

  cacheSet_(cacheKey, r.data.items);
  rosterCache = r.data.items;
  renderRosterList_();
  setSyncBadge_('s04-sync', 'fresh', Date.now());
}

document.querySelectorAll('#s04-tabs .chip').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('#s04-tabs .chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
  rosterTab = chip.dataset.tab;
  renderRosterList_();
}));
document.getElementById('s04-search').addEventListener('input', renderRosterList_);
document.getElementById('btn-refresh-roster').addEventListener('click', loadRoster_);

function renderRosterList_() {
  const q = document.getElementById('s04-search').value.trim().toLowerCase();
  let items = rosterCache;
  if (rosterTab === 'pending') items = items.filter(i => !i.result);
  else if (rosterTab === 'onboard' || rosterTab === 'completed' || rosterTab === 'absent') {
    // ต้องอิงจาก DayRoster.day_status จริง — round.checks คืนแค่ผลรายรอบ จึงกรองแบบหยาบจาก result ที่มี
    items = items.filter(i => i.result === 'PRESENT');
  }
  if (q) items = items.filter(i => i.name.toLowerCase().indexOf(q) !== -1);

  const list = document.getElementById('s04-list');
  list.innerHTML = items.map(i => (
    '<div class="roster-row"><div><div class="name">' + i.name + '</div>' +
    '<div class="meta">' + (i.checked_by_name ? 'เช็คโดย ' + i.checked_by_name + ' · ' + (i.checked_at || '') : (i.hint || 'ยังไม่ถูกเช็ค')) + '</div></div>' +
    '<span class="status-pill">' + (i.result || 'รอ') + '</span></div>'
  )).join('') || '<div class="empty-state">ไม่มีรายชื่อ</div>';
}

// ---------------------------------------------------------------------------
// S-05 ปิดรอบ / ปิดเที่ยวรถ
// ---------------------------------------------------------------------------

function renderCloseSummary_(round) {
  document.getElementById('s05-round-summary').textContent = round.checked + '/' + round.expected + ' คน · เช็คซ้ำ ' + round.duplicateAttempts + ' ครั้ง';
}

async function loadCloseScreen_() {
  const cacheKey = 'close_' + state.currentRoundId;
  const cached = cacheGet_(cacheKey);
  if (cached) {
    renderCloseSummary_(cached.data);
    setSyncBadge_('s05-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s05-sync', 'loading');
  spinRefreshBtn_('btn-refresh-close', true);

  const rr = await api('round.get', { roundId: state.currentRoundId });
  spinRefreshBtn_('btn-refresh-close', false);
  if (!rr.ok) {
    if (!cached) toast(rr.error.message);
    setSyncBadge_('s05-sync', 'error');
    return;
  }

  cacheSet_(cacheKey, rr.data);
  renderCloseSummary_(rr.data);
  setSyncBadge_('s05-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-close').addEventListener('click', loadCloseScreen_);

onClickGuarded_('btn-close-round', async () => {
  const r = await api('round.close', { roundId: state.currentRoundId });
  if (!r.ok) {
    if (r.error.code === 'E_ROUND_INCOMPLETE' && r.error.details) {
      showManageBlockersUI_(r.error.details.blockers);
      return;
    }
    toast(r.error.message);
    return;
  }
  toast('ปิดรอบแล้ว');
  showScreen('S-02'); loadRounds_();
});

function showManageBlockersUI_(blockers) {
  const wrap = document.getElementById('s05-round-card');
  const existing = wrap.querySelector('.blocker-list'); if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'blocker-list';
  div.innerHTML = '<p style="color:var(--color-error);font-weight:700;">' + ic('alert-octagon') + ' ปิดรอบไม่ได้ — ยังมี ' + blockers.length + ' คนที่ยังไม่ระบุสถานะ</p>' +
    blockers.map(b => (
      '<div class="roster-row"><div class="name">' + b.name + '</div></div>' +
      '<div class="chip-group" style="margin:0 0 10px;">' +
      '<div class="chip" data-manage="ABSENT" data-student="' + b.student_id + '">ขาด</div>' +
      '<div class="chip" data-manage="EXCUSED" data-student="' + b.student_id + '">ผู้ปกครองรับเอง</div>' +
      '<div class="chip" data-manage="UNRESOLVED" data-student="' + b.student_id + '">ยังไม่ทราบ</div></div>'
    )).join('');
  wrap.appendChild(div);
  div.querySelectorAll('[data-manage]').forEach(chip => chip.addEventListener('click', guardClick_(async () => {
    const status = chip.dataset.manage;
    const reasonCode = status === 'ABSENT' ? 'NO_SHOW' : status === 'EXCUSED' ? 'PARENT_PICKUP' : 'STILL_SEARCHING';
    const r = await api('student.setStatus', {
      date: new Date().toISOString().slice(0, 10), direction: 'AM', studentId: chip.dataset.student,
      status: status, reasonCode: reasonCode, clientEventId: uuid()
    });
    if (r.ok) { chip.closest('.roster-row').nextSibling ? null : null; chip.parentElement.previousElementSibling.remove(); chip.parentElement.remove(); toast('บันทึกแล้ว'); }
    else toast(r.error.message);
  })));
}

onClickGuarded_('btn-close-trip', async () => {
  const rr = await api('round.get', { roundId: state.currentRoundId });
  if (!rr.ok) return;
  const r = await api('trip.close', { tripId: rr.data.trip_id });
  if (!r.ok) { toast(r.error.message); return; }
  toast('ปิดเที่ยวรถแล้ว');
  showScreen('S-01'); renderHome_();
});

// ---------------------------------------------------------------------------
// S-19 QR รับรองของฉัน
// ---------------------------------------------------------------------------

async function startVouchQrLoop_() {
  await refreshVouchTokens_();
  renderVouchesList_();
  if (state.vouchTimer) clearInterval(state.vouchTimer);
  state.vouchTimer = setInterval(tickVouchQr_, 1000);
  tickVouchQr_();
}

async function refreshVouchTokens_() {
  const r = await api('vouch.getMyQr', {});
  if (!r.ok) { toast(r.error.message); return; }
  state.vouchTickets = r.data.tokens;
  state.vouchTicketIdx = 0;
  const scope = 'ครู ' + (r.data.canVouch.teacher ? ic('check-circle', 'icon-ok') : ic('x-circle', 'icon-error')) +
    ' · นักเรียน ' + (r.data.canVouch.student ? ic('check-circle', 'icon-ok') : ic('x-circle', 'icon-error'));
  document.getElementById('s19-scope').innerHTML = 'QR นี้รับรองได้: ' + scope;
  document.getElementById('s19-usedtoday').textContent = 'วันนี้รับรองไปแล้ว ' + r.data.usedToday + ' คน' + (r.data.dailyLimit ? ' / ' + r.data.dailyLimit : ' (ไม่จำกัด)');
}

function tickVouchQr_() {
  if (!state.vouchTickets.length) return;
  const now = Date.now();
  let idx = state.vouchTicketIdx;
  while (idx < state.vouchTickets.length - 1 && new Date(state.vouchTickets[idx].validTo).getTime() < now) idx++;
  state.vouchTicketIdx = idx;
  const tokenObj = state.vouchTickets[idx];
  const left = Math.max(0, Math.round((new Date(tokenObj.validTo).getTime() - now) / 1000));
  document.getElementById('s19-countdown').innerHTML = ic('refresh') + ' เปลี่ยนใหม่ใน ' + left + ' วินาที';
  renderQr_('s19-qr-canvas', tokenObj.payload);

  if (idx >= state.vouchTickets.length - 2 && left < 60) refreshVouchTokens_();
}

document.getElementById('btn-vouch-new').addEventListener('click', refreshVouchTokens_);
onClickGuarded_('btn-vouch-revoke-all', async () => {
  if (!confirm('ยกเลิก QR ทั้งชุดที่ออกไปแล้ว?')) return;
  const r = await api('vouch.revokeAllTokens', {});
  if (r.ok) { toast('ยกเลิกแล้ว'); refreshVouchTokens_(); } else toast(r.error.message);
});

async function renderVouchesList_() {
  const r = await api('vouch.myVouches', {});
  if (!r.ok) return;
  const list = document.getElementById('s19-vouches-list');
  list.innerHTML = r.data.map(v => (
    '<div class="roster-row"><div><div class="name">' + v.full_name + ' (' + (v.reg_type === 'TEACHER' ? 'ครู' : 'นักเรียน') + ')</div>' +
    '<div class="meta">' + (v.submitted_at || '') + (v.revoked ? ' · ระงับแล้ว' : '') + '</div></div>' +
    (v.canRevoke ? '<button class="btn btn-danger" data-revoke="' + v.reg_id + '" style="min-height:36px;padding:6px 12px;">ไม่ใช่ฉัน</button>' : '') +
    '</div>'
  )).join('') || '<div class="empty-state">ยังไม่มีรายการ</div>';

  list.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', guardClick_(async () => {
    if (!confirm('ยืนยันระงับบัญชีนี้?')) return;
    const rr = await api('vouch.revoke', { regId: btn.dataset.revoke, reason: 'ไม่ใช่ฉัน' });
    if (rr.ok) { toast('ระงับบัญชีแล้ว'); renderVouchesList_(); } else toast(rr.error.message);
  })));
}

// ---------------------------------------------------------------------------
// S-20 จัดการรถ
// ---------------------------------------------------------------------------

function renderBusList_(buses) {
  const list = document.getElementById('s20-list');
  if (!buses.length) { list.innerHTML = '<div class="empty-state">ยังไม่มีรถในระบบ</div>'; return; }
  list.innerHTML = buses.map(b => (
    '<div class="roster-row" style="opacity:' + (b.is_active ? '1' : '0.45') + '">' +
    '<div style="flex:1">' +
    '<div class="name">' + ic('bus') + ' รถ ' + b.bus_code + (b.bus_name && b.bus_name !== b.bus_code ? ' · ' + b.bus_name : '') + '</div>' +
    '<div class="meta">' +
    (b.plate_no ? 'ทะเบียน ' + b.plate_no + ' · ' : '') +
    'จุ ' + (b.capacity || '—') + ' คน' +
    ' · นักเรียน ' + b.student_count + ' คน' +
    (b.is_active ? '' : ' · ปิดใช้งาน') +
    '</div>' +
    (b.note ? '<div class="meta" style="color:var(--text-muted)">' + b.note + '</div>' : '') +
    '</div>' +
    '<div style="display:flex;gap:6px;flex-shrink:0">' +
    '<button class="btn btn-secondary" style="min-height:36px;padding:6px 10px;" data-bus-edit="' + b.bus_id + '" aria-label="แก้ไขรถ ' + b.bus_code + '" title="แก้ไข">' + ic('pencil') + '</button>' +
    '<button class="btn ' + (b.is_active ? 'btn-danger' : 'btn-secondary') + '" style="min-height:36px;padding:6px 10px;font-size:13px;" data-bus-toggle="' + b.bus_id + '" data-bus-active="' + b.is_active + '">' + (b.is_active ? 'ปิด' : 'เปิด') + '</button>' +
    '</div>' +
    '</div>'
  )).join('');

  list.querySelectorAll('[data-bus-edit]').forEach(btn => btn.addEventListener('click', () => {
    const bus = buses.find(b => b.bus_id === btn.dataset.busEdit);
    if (bus) openBusDialog_(bus);
  }));

  list.querySelectorAll('[data-bus-toggle]').forEach(btn => btn.addEventListener('click', guardClick_(async () => {
    const busId = btn.dataset.busToggle;
    const currently = btn.dataset.busActive === 'true';
    const bus = buses.find(b => b.bus_id === busId);
    const busLabel = bus ? 'รถ ' + bus.bus_code : busId;
    if (currently && !confirm('ปิดใช้งาน ' + busLabel + '?\nรถที่ปิดจะไม่แสดงในรายการเลือกรถสำหรับรอบเช็คใหม่')) return;
    const r = await api('bus.setActive', { busId, active: !currently });
    if (r.ok) { toast(currently ? 'ปิดใช้งานแล้ว' : 'เปิดใช้งานแล้ว'); loadBuses_({ silent: true }); }
    else toast(r.error.message);
  })));
}

async function loadBuses_(opts) {
  opts = opts || {};
  const cached = cacheGet_('buses');
  if (cached && !opts.silent) {
    renderBusList_(cached.data);
    setSyncBadge_('s20-sync', 'cache', cached.cachedAt);
  }
  setSyncBadge_('s20-sync', 'loading');
  spinRefreshBtn_('btn-refresh-buses', true);

  const r = await api('bus.list', {});
  spinRefreshBtn_('btn-refresh-buses', false);
  if (!r.ok) {
    if (!cached) document.getElementById('s20-list').innerHTML = '<div class="empty-state">' + r.error.message + '</div>';
    setSyncBadge_('s20-sync', 'error');
    return;
  }

  cacheSet_('buses', r.data);
  renderBusList_(r.data);
  setSyncBadge_('s20-sync', 'fresh', Date.now());
}

function openBusDialog_(bus) {
  const isEdit = !!bus;
  document.getElementById('dlg-bus-title').textContent = isEdit ? 'แก้ไขรถ ' + bus.bus_code : 'เพิ่มรถใหม่';
  document.getElementById('be-bus-id').value = isEdit ? bus.bus_id : '';
  document.getElementById('be-code').value = isEdit ? bus.bus_code : '';
  document.getElementById('be-name').value = isEdit ? (bus.bus_name && bus.bus_name !== bus.bus_code ? bus.bus_name : '') : '';
  document.getElementById('be-plate').value = isEdit ? (bus.plate_no || '') : '';
  document.getElementById('be-cap').value = isEdit ? (bus.capacity || '') : '';
  document.getElementById('be-note').value = isEdit ? (bus.note || '') : '';
  document.getElementById('be-order').value = isEdit ? (bus.sort_order != null ? bus.sort_order : '') : '';
  document.getElementById('dlg-bus-edit').classList.add('show');
}

document.getElementById('btn-add-bus').addEventListener('click', () => openBusDialog_(null));
document.getElementById('btn-refresh-buses').addEventListener('click', () => loadBuses_());
document.getElementById('dlg-bus-cancel').addEventListener('click', () => document.getElementById('dlg-bus-edit').classList.remove('show'));

onClickGuarded_('dlg-bus-save', async () => {
  const busCode = document.getElementById('be-code').value.trim();
  if (!busCode) { toast('กรุณาระบุหมายเลข/ชื่อรถ'); return; }
  const busId = document.getElementById('be-bus-id').value;
  const payload = {
    busCode,
    busName: document.getElementById('be-name').value.trim(),
    plateNo: document.getElementById('be-plate').value.trim(),
    capacity: document.getElementById('be-cap').value,
    note: document.getElementById('be-note').value.trim(),
    sortOrder: document.getElementById('be-order').value
  };
  if (busId) payload.busId = busId;

  const r = await api('bus.upsert', payload);
  if (!r.ok) { toast(r.error.message); return; }
  document.getElementById('dlg-bus-edit').classList.remove('show');
  toast(busId ? 'บันทึกแล้ว' : 'เพิ่มรถสำเร็จ');
  loadBuses_({ silent: true });
});

// ---------------------------------------------------------------------------
// S-21..S-24 โหมดนักเรียน (persona = STUDENT) — เฟส 4, 8.5
// ---------------------------------------------------------------------------

const DAY_STATUS_LABEL_ = {
  PENDING: 'ยังไม่ขึ้น', ONBOARD: 'อยู่บนรถ', COMPLETED: 'ถึงแล้ว',
  ABSENT: 'ขาด', EXCUSED: 'ไม่ใช้รถ', UNRESOLVED: 'ยังไม่ทราบสถานะ'
};

function renderStudentTodayRow_(label, row) {
  if (!row) return '<div class="progress">' + label + ': ยังไม่มีรอบวันนี้</div>';
  const statusText = DAY_STATUS_LABEL_[row.day_status] || row.day_status;
  let detail = '';
  if (row.day_status === 'ONBOARD' && row.board_at) detail = ' · ขึ้นรถ ' + row.board_at.slice(11, 16) + (row.board_by_name ? ' (' + row.board_by_name + ')' : '');
  else if (row.day_status === 'COMPLETED' && row.drop_at) detail = ' · ถึง ' + row.drop_at.slice(11, 16) + (row.drop_by_name ? ' (' + row.drop_by_name + ')' : '');
  return '<div class="row1"><span class="status-dot"></span> ' + label + ': ' + statusText + detail + '</div>';
}

async function loadStudentHome_(opts) {
  opts = opts || {};
  setSyncBadge_('s21-sync', 'loading');
  const r = await api('student.myHome', {});
  if (!r.ok) { toast(r.error.message); setSyncBadge_('s21-sync', 'error'); return; }

  const d = r.data;
  document.getElementById('s21-name').textContent = d.profile.nickname ? d.profile.name + ' (' + d.profile.nickname + ')' : d.profile.name;
  document.getElementById('s21-class').textContent = [d.profile.class, d.bus ? d.bus.bus_name : ''].filter(Boolean).join(' · ');
  document.getElementById('s21-sponsor').textContent = d.profile.registered_by_name ? 'เพิ่มโดย ' + d.profile.registered_by_name : '';
  document.getElementById('s21-today').innerHTML = renderStudentTodayRow_('เช้า', d.today.am) + renderStudentTodayRow_('บ่าย', d.today.pm);

  const qrCard = document.getElementById('s21-qr-card');
  if (d.qrPayload) { qrCard.style.display = 'block'; renderQr_('s21-qr-canvas', d.qrPayload); }
  else qrCard.style.display = 'none';

  document.getElementById('s21-tile-noride').style.display = d.canSelfExcuse ? 'flex' : 'none';
  state.studentCanSelfExcuse = d.canSelfExcuse;

  setSyncBadge_('s21-sync', 'fresh', Date.now());
}

document.getElementById('btn-refresh-student-home').addEventListener('click', () => loadStudentHome_());
document.getElementById('s21-tile-bus').addEventListener('click', () => { showScreen('S-22'); loadStudentBusInfo_(); });
document.getElementById('s21-tile-noride').addEventListener('click', () => {
  if (!state.studentCanSelfExcuse) { toast('โรงเรียนปิดการแจ้งไม่ใช้รถด้วยตนเองไว้ กรุณาติดต่อครูประจำรถ'); return; }
  showScreen('S-23');
  const todayStr = new Date().toISOString().slice(0, 10);
  document.getElementById('s23-date-from').value = todayStr;
  document.getElementById('s23-date-to').value = todayStr;
  document.getElementById('s23-note').value = '';
});
document.getElementById('s21-tile-history').addEventListener('click', () => { showScreen('S-24'); loadStudentHistory_(); });

async function loadStudentBusInfo_() {
  const content = document.getElementById('s22-content');
  content.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api('student.myBusInfo', {});
  if (!r.ok) { content.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; return; }

  const d = r.data;
  if (!d.bus) { content.innerHTML = '<div class="empty-state">ยังไม่มีรถประจำ</div>'; return; }
  let html = '<div class="card"><div class="card-title">รถประจำ</div><div class="row1">' + d.bus.bus_name + '</div></div>';
  if (d.stop) html += '<div class="card"><div class="card-title">จุดขึ้น-ลง</div><div class="row1">' + d.stop.stop_name + '</div></div>';
  if (d.contacts.length) {
    html += '<div class="card"><div class="card-title">ครูประจำรถ</div>' +
      d.contacts.map(c => '<div class="row1">' + c.name + ' — <a href="tel:' + c.phone + '">' + c.phone + '</a></div>').join('') +
      '</div>';
  }
  content.innerHTML = html;
}

async function loadStudentHistory_() {
  const list = document.getElementById('s24-list');
  list.innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api('student.myHistory', {});
  if (!r.ok) { list.innerHTML = '<div class="empty-state">' + r.error.message + '</div>'; return; }
  if (!r.data.length) { list.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการเดินทาง</div>'; return; }

  list.innerHTML = r.data.map(h => {
    const statusText = DAY_STATUS_LABEL_[h.day_status] || h.day_status;
    const dirLabel = h.direction === 'AM' ? 'เช้า' : 'บ่าย';
    return '<div class="round-item"><div class="round-item-content"><div class="row1">' +
      h.date + ' · ' + dirLabel + ' — ' + statusText + '</div></div></div>';
  }).join('');
}

onClickGuarded_('btn-submit-noride', async () => {
  const dateFrom = document.getElementById('s23-date-from').value;
  const dateTo = document.getElementById('s23-date-to').value;
  if (!dateFrom || !dateTo) { toast('กรุณาระบุช่วงวันที่'); return; }

  const r = await api('student.reportNoRide', {
    dateFrom, dateTo,
    direction: document.getElementById('s23-direction').value,
    note: document.getElementById('s23-note').value.trim()
  });
  if (!r.ok) { toast(r.error.message); return; }

  toast('แจ้งไม่ใช้รถแล้ว');
  showScreen('S-21');
  loadStudentHome_({ silent: true });
});
