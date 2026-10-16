const environment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
export const IS_ANDROID = environment?.VITE_APP_PLATFORM === 'android';
export const IS_DESKTOP = environment?.VITE_APP_PLATFORM === 'desktop';
export const IS_OFFLINE_APP = IS_ANDROID || environment?.VITE_OFFLINE_APP === 'true';
/** Magazine downloads begin only after an explicit update action on either installed app. */
export const CAN_MANUALLY_SYNC_MAGAZINES = IS_ANDROID || IS_DESKTOP || !IS_OFFLINE_APP;
