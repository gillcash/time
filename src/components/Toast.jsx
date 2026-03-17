import { signal } from '@preact/signals';

// Global toast state
export const toastState = signal({ message: '', type: '', visible: false, dismissible: false });

let toastTimeout = null;

export function showToast(message, type = '', { dismissible = false } = {}) {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }

  toastState.value = { message, type, visible: true, dismissible };

  if (!dismissible) {
    toastTimeout = setTimeout(() => {
      toastState.value = { ...toastState.value, visible: false };
    }, 3000);
  }
}

export function dismissToast() {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  toastState.value = { ...toastState.value, visible: false };
}

export function Toast() {
  const { message, type, visible, dismissible } = toastState.value;

  return (
    <div class={`toast ${type} ${visible ? 'visible' : ''}`}>
      <span class="toast-message">{message}</span>
      {dismissible && (
        <button class="toast-dismiss" onClick={dismissToast} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}
