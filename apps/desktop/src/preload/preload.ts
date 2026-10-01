import { contextBridge, ipcRenderer } from 'electron';
import type { ChatState } from '../shared/chat.js';
import type { AppSnapshot, RendererApi } from '../shared/types.js';

// Puente mínimo renderer ↔ main. El renderer nunca ve el token ni tiene Node.

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: RendererApi & { onOpenSession(cb: (id: string) => void): () => void } = {
  getSnapshot: () => ipcRenderer.invoke('cp:getSnapshot'),
  onSnapshot: (cb) => subscribe<AppSnapshot>('cp:snapshot', cb),
  onFocusSuggestion: (cb) => subscribe<string>('cp:focusSuggestion', cb),
  onOpenSession: (cb) => subscribe<string>('cp:openSession', cb),
  runAction: (id, index) => ipcRenderer.invoke('cp:runAction', id, index),
  feedback: (id, fb) => ipcRenderer.invoke('cp:feedback', id, fb),
  api: (method, path, body) => ipcRenderer.invoke('cp:api', method, path, body),
  saveFile: (name, content) => ipcRenderer.invoke('cp:saveFile', name, content),
  openJsonFiles: (multi) => ipcRenderer.invoke('cp:openJsonFiles', multi),
  openDashboard: (sessionId) => ipcRenderer.invoke('cp:openDashboard', sessionId),
  hideOverlay: () => ipcRenderer.invoke('cp:hideOverlay'),
  launchClaudeDesktop: () => ipcRenderer.invoke('cp:launchClaudeDesktop'),
  chat: {
    list: () => ipcRenderer.invoke('cp:chat:list'),
    open: (id) => ipcRenderer.invoke('cp:chat:open', id),
    create: (model) => ipcRenderer.invoke('cp:chat:create', model),
    send: (id, text) => ipcRenderer.invoke('cp:chat:send', id, text),
    interrupt: (id) => ipcRenderer.invoke('cp:chat:interrupt', id),
    permission: (id, req, allow) => ipcRenderer.invoke('cp:chat:permission', id, req, allow),
    setModel: (id, model) => ipcRenderer.invoke('cp:chat:model', id, model),
    remove: (id) => ipcRenderer.invoke('cp:chat:remove', id),
    onUpdate: (cb) => subscribe<ChatState>('cp:chat', cb),
    onList: (cb) => subscribe('cp:chatList', cb),
  },
};

contextBridge.exposeInMainWorld('cp', api);
