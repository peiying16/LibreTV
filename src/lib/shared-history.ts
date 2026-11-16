'use client';
import type { HistoryEntry } from './db';
import { libraryRequest } from './library-client';
const updated = () => window.dispatchEvent(new Event('libretv:history-updated'));
export async function upsertHistory(entry: Omit<HistoryEntry, 'id'>) { await libraryRequest('/history', 'POST', entry); updated(); }
export async function removeHistory(id: string) { await libraryRequest(`/history?id=${encodeURIComponent(id)}`, 'DELETE'); updated(); }
export async function clearAllHistory() { await libraryRequest('/history', 'DELETE'); updated(); }
export function readSharedProgress(sourceUrl: string, vodId: string, index: number) {
  return libraryRequest<{ position: number; duration: number }>(`/progress?${new URLSearchParams({ sourceUrl, vodId, index: String(index) })}`);
}
export async function saveSharedProgress(sourceUrl: string, vodId: string, index: number, position: number, duration: number, ended = false) {
  if (!Number.isFinite(duration) || duration <= 0) return;
  await libraryRequest('/progress', 'PUT', { sourceUrl, vodId, index, position, duration, ended }); updated();
}
