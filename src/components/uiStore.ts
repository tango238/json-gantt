import { create } from "zustand";
import { t } from "../i18n";
import type { CommandErr } from "../engine";

export type ToastKind = "error" | "info";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
export interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

interface UiState {
  toasts: ToastItem[];
  confirm: ConfirmRequest | null;
}

export const useUiStore = create<UiState>()(() => ({ toasts: [], confirm: null }));

export const TOAST_MS = 3000;
let nextToastId = 1;

/** Show a toast for 3 seconds (03 section 11.6). */
export function showToast(kind: ToastKind, message: string): void {
  const id = nextToastId++;
  useUiStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
  setTimeout(() => dismissToast(id), TOAST_MS);
}
export function dismissToast(id: number): void {
  useUiStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

/** Toast for a failed engine command (`error.engine.<CODE>`). */
export function showCommandError(err: CommandErr): void {
  showToast("error", t(`error.engine.${err.code}`, err.params));
}

export function requestConfirm(req: ConfirmRequest): void {
  useUiStore.setState({ confirm: req });
}
export function closeConfirm(): void {
  useUiStore.setState({ confirm: null });
}
