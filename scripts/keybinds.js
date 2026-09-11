/* Bound input widget: focus, idle fire, resolve, run. */
const MODULE_ID = 'victory-keybinds', WIDGET_ID = 'vkb-widget';
const L = (k, data) => data ? game.i18n.format(`VKB.${k}`, data) : game.i18n.localize(`VKB.${k}`);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const setting = (k) => game.settings.get(MODULE_ID, k);
const DBG = (...a) => setting('debug') && console.log('VKB |', ...a);
const fail = (e, ...a) => console.error('VKB |', ...a, e);

let root = null, inputEl = null, echoEl = null, ctl = null, idleTimer = null, drag = null;
const history = [];

/* Focus binding as a human label. */
const focusBinding = () => game.keybindings.get(MODULE_ID, 'focus')[0];
const keyLabel = () => {
  const b = focusBinding();
  if (!b) return L('Widget.Unbound');
  try { return (globalThis.KeybindingsConfig ?? foundry.applications.sidebar.apps.ControlsConfig).humanizeBinding(b); } catch { return b.key; } // v12 then v13
};

/* Echo row: debug keeps five lines, else one. */
function echo(message, kind = 'info') {
  if (!echoEl) return;
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  history.push(`<div class="vkb-row vkb-${kind}">[${stamp}] ${esc(message)}</div>`);
  while (history.length > (setting('debug') ? 5 : 1)) history.shift();
  echoEl.innerHTML = history.join(''); echoEl.scrollTop = echoEl.scrollHeight;
  DBG(kind, message);
}

/* Resolution: sigils, keywords, UUIDs, bare macro id. */
const uuid = async (id) => { try { return await fromUuid(id.trim()); } catch (e) { DBG('fromUuid threw', e); return null; } };
const lookup = async (id, type, kind) => { const doc = await uuid(id); return doc?.documentName === type ? { doc, kind } : null; };
const kw = (result) => ({ kind: 'keyword', result });
const createActor = async (type, label) => {
  try { await Actor.implementation.createDialog({ type }); return { ok: true, message: L('Echo.CreateOpened', { label }) }; }
  catch (e) { fail(e, label); return { ok: false, message: L('Echo.CreateError', { label }) }; }
};
const KEYWORDS = {
  inventory: async () => {
    const actor = canvas.tokens.controlled[0]?.actor;
    if (!actor) return { ok: false, message: L('Echo.NoToken') };
    const hits = actor.items.filter((i) => i.name?.toLowerCase().includes('inventory'));
    if (!hits.length) return { ok: false, message: L('Echo.NoInventory', { actor: actor.name }) };
    hits[0].sheet.render(true);
    return { ok: true, message: L(hits.length > 1 ? 'Echo.OpenedMany' : 'Echo.Opened', { name: hits[0].name, actor: actor.name, n: hits.length }) };
  },
  newPC: () => createActor('character', 'PC'), // case sensitive
  newNPC: () => createActor('npc', 'NPC'), // case sensitive
};

function jumpTab(name) {
  if (!name) return { ok: false, message: L('Echo.TabMissing') };
  const names = Object.keys(ui.sidebar?.tabs ?? {}), hit = names.find((t) => t.toLowerCase() === name); // exact match only
  if (!hit) return { ok: false, message: L(names.length ? 'Echo.TabUnknown' : 'Echo.TabNone', { name }) };
  try { ui.sidebar.activateTab ? ui.sidebar.activateTab(hit) : ui.sidebar.changeTab(hit, 'primary'); return { ok: true, message: L('Echo.TabOpened', { name: hit }) }; } // v12 then v13
  catch (e) { fail(e, hit); return { ok: false, message: L('Echo.TabError') }; }
}

async function resolve(raw) {
  const input = raw.trim();
  if (!input) return null;
  if (input.startsWith('=')) return lookup(input.slice(1), 'Actor', 'actor');
  if (input.startsWith('<')) return lookup(input.slice(1), 'JournalEntry', 'journal');
  if (input.startsWith('>')) return kw(jumpTab(input.slice(1).trim().toLowerCase()));
  const handler = KEYWORDS[input] ?? KEYWORDS[input.toLowerCase()]; // exact then lowercase
  if (handler) { DBG('keyword', input); return kw(await handler()); }
  if (input.includes('.')) { const doc = await uuid(input); return ['Macro', 'Item'].includes(doc?.documentName) ? { doc, kind: doc.documentName.toLowerCase() } : null; }
  const macro = game.macros.get(input); // bare world macro id
  return macro ? { doc: macro, kind: 'macro' } : null;
}

/* Fire: resolve, run, echo. Idle timer or Enter. */
async function fire(text) {
  clearTimeout(idleTimer); idleTimer = null;
  const raw = text ?? inputEl?.value ?? '';
  if (text === undefined && inputEl) inputEl.value = '';
  if (!raw.trim()) return echo(L('Echo.Empty'));
  DBG('fire', raw);
  const t = await resolve(raw);
  if (!t) return echo(L('Echo.NotFound', { text: raw }), 'miss');
  if (t.kind === 'keyword') return echo(`${L('Tag.keyword')} ${t.result.message}`, t.result.ok ? 'ok' : 'miss');
  const { doc, kind } = t;
  echo(`${L(`Tag.${kind}`)} ${doc.name}`, 'ok');
  try { if (kind === 'macro') await doc.execute(); else if (kind === 'item') await doc.use(); else doc.sheet.render(true); }
  catch (e) { fail(e, doc.name); echo(L('Echo.Error', { name: doc.name }), 'miss'); }
}

/* Input: idle fire, Enter fires, Escape clears. */
const schedule = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idleTimer = null; if (inputEl?.value.trim()) fire(); }, setting('idleMs')); };
function onKey(ev) {
  if (ev.code === focusBinding()?.key) { ev.preventDefault(); inputEl.select(); } // binding while focused
  else if (ev.key === 'Enter') { ev.preventDefault(); fire(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); clearTimeout(idleTimer); idleTimer = null; inputEl.value = ''; inputEl.blur(); echo(L('Echo.Cleared')); }
}

/* Drag by header, clamped to the window. */
function dragStart(ev) {
  if (ev.target.closest('.vkb-close')) return;
  const r = root.getBoundingClientRect();
  drag = { x: ev.clientX - r.left, y: ev.clientY - r.top }; ev.preventDefault();
}
function dragMove(ev) {
  if (!drag) return;
  root.style.left = `${Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - drag.x))}px`;
  root.style.top = `${Math.max(0, Math.min(window.innerHeight - 20, ev.clientY - drag.y))}px`;
}

/* Widget lifecycle on document.body. */
const applyDebug = () => root?.classList.toggle('vkb-debug', setting('debug'));
function open() {
  if (!game.user.isGM) return ui.notifications.error(L('GmOnly'));
  close(); document.getElementById(WIDGET_ID)?.remove(); // stale node after reload
  const key = keyLabel();
  root = document.createElement('div'); root.id = WIDGET_ID;
  root.innerHTML = `<div class="vkb-head"><span class="vkb-title">${esc(L('Widget.Title'))}</span><span class="vkb-badge">${esc(L('Widget.Debug'))}</span><button type="button" class="vkb-close" title="${esc(L('Widget.Close'))}"><i class="fas fa-times"></i></button></div>
<div class="vkb-body"><input type="text" class="vkb-input" placeholder="${esc(L('Widget.Placeholder', { key }))}" autocomplete="off" spellcheck="false"><div class="vkb-echo"></div><div class="vkb-hint">${esc(L('Widget.Hint', { key }))}</div></div>`;
  document.body.appendChild(root);
  inputEl = root.querySelector('.vkb-input'); echoEl = root.querySelector('.vkb-echo');

  ctl = new AbortController(); // one abort drops every listener
  const sig = { signal: ctl.signal };
  inputEl.addEventListener('input', schedule, sig);
  inputEl.addEventListener('keydown', onKey, sig);
  inputEl.addEventListener('focus', () => root.classList.add('vkb-focused'), sig);
  inputEl.addEventListener('blur', () => root.classList.remove('vkb-focused'), sig);
  root.querySelector('.vkb-head').addEventListener('mousedown', dragStart, sig);
  root.querySelector('.vkb-close').addEventListener('click', close, sig);
  document.addEventListener('mousemove', dragMove, sig);
  document.addEventListener('mouseup', () => (drag = null), sig);

  applyDebug(); echo(L('Echo.Armed')); ui.notifications.info(L('Armed', { key }));
  DBG('open, key', key);
}
function close() {
  if (!root) return;
  ctl.abort(); clearTimeout(idleTimer); root.remove();
  root = inputEl = echoEl = ctl = idleTimer = drag = null; history.length = 0;
  DBG('closed');
}
const toggle = () => (root ? close() : open());
const focus = () => { if (!root) open(); inputEl?.focus(); inputEl?.select(); DBG('focus claimed'); };

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'idleMs', { name: 'VKB.Settings.IdleMs.Name', hint: 'VKB.Settings.IdleMs.Hint', scope: 'client', config: true, type: Number, default: 150 });
  game.settings.register(MODULE_ID, 'autoOpen', { name: 'VKB.Settings.AutoOpen.Name', hint: 'VKB.Settings.AutoOpen.Hint', scope: 'client', config: true, type: Boolean, default: true });
  game.settings.register(MODULE_ID, 'debug', { name: 'VKB.Settings.Debug.Name', hint: 'VKB.Settings.Debug.Hint', scope: 'client', config: true, type: Boolean, default: false, onChange: applyDebug });
  game.keybindings.register(MODULE_ID, 'focus', { name: 'VKB.Keys.Focus', hint: 'VKB.Keys.FocusHint', editable: [{ key: 'Backquote' }], restricted: true, onDown: () => { focus(); return true; }, precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY }); // true eats the keystroke
  game.keybindings.register(MODULE_ID, 'toggle', { name: 'VKB.Keys.Toggle', hint: 'VKB.Keys.ToggleHint', editable: [], restricted: true, onDown: () => { toggle(); return true; } });
});

/* API: open(), close(), toggle(), fire(text). */
Hooks.once('ready', () => {
  game.modules.get(MODULE_ID).api = { open, close, toggle, fire };
  if (game.user.isGM && setting('autoOpen')) open();
});
