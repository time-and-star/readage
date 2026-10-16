import { registerPlugin } from '@capacitor/core';

interface NativeStartupAppearance {
  setStartupVisible(options: { visible: boolean }): Promise<void>;
}

const appearance = registerPlugin<NativeStartupAppearance>('ReadageStartupAppearance');
let updates: Promise<void> = Promise.resolve();

/** Keep native colors in DOM-commit order, including a quick startup completion. */
export function setNativeStartupVisible(visible: boolean): Promise<void> {
  updates = updates.catch(() => {}).then(() => appearance.setStartupVisible({ visible }));
  return updates;
}
