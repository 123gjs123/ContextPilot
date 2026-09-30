// Página de opciones: pegar token, URL del daemon y probar conexión (CP-037.2/.4).
import type { ConnectionTest, ToBackground } from '../messages.js';
import { DEFAULT_DAEMON_URL } from '../bg/daemon.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const token = $<HTMLInputElement>('token');
const url = $<HTMLInputElement>('url');
const status = $('status');

function show(text: string, cls: 'ok' | 'bad' | 'warn' | 'muted' = 'muted'): void {
  status.textContent = text;
  status.className = cls;
}

async function load(): Promise<void> {
  const s = await chrome.storage.local.get(['cpToken', 'cpDaemonUrl']);
  token.value = (s.cpToken as string) ?? '';
  url.value = (s.cpDaemonUrl as string) || DEFAULT_DAEMON_URL;
  if (token.value) void test();
}

async function save(): Promise<void> {
  const t = token.value.trim();
  const u = url.value.trim() || DEFAULT_DAEMON_URL;
  if (t && !/^[0-9a-f]{16,128}$/i.test(t)) {
    show('El token tiene un formato raro (se esperan caracteres hex). Revisalo y volvé a pegarlo.', 'warn');
  }
  await chrome.storage.local.set({ cpToken: t, cpDaemonUrl: u });
  show('Guardado.', 'ok');
  await test();
}

async function test(): Promise<void> {
  show('Probando…');
  const msg: ToBackground = { type: 'cp:test-connection', token: token.value.trim(), daemonUrl: url.value.trim() };
  const r = (await chrome.runtime.sendMessage(msg)) as ConnectionTest;
  if (r.health === 'down') show('Sin conexión con el daemon: ¿está corriendo? (sin datos)', 'bad');
  else if (r.auth === 'ok') show('Conectado ✓', 'ok');
  else if (r.auth === 'unauthorized') show('El daemon responde pero rechazó el token. Copiá de nuevo el token.', 'bad');
  else if (r.auth === 'skipped') show('El daemon responde. Falta pegar el token.', 'warn');
  else show(`El daemon responde pero falló la consulta autenticada (${r.detail ?? 'error'}).`, 'bad');
}

$('save').addEventListener('click', () => void save());
$('test').addEventListener('click', () => void test());
$('show').addEventListener('click', () => {
  token.type = token.type === 'password' ? 'text' : 'password';
});
void load();
