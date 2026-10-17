import {StrictMode, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import { initializeLocalDatabase } from './lib/localDatabase';
import { IS_ANDROID, IS_DESKTOP } from './lib/platform/runtime';
import { showStartupScreen } from './lib/startupScreen';
import './index.css';
import { patchStatus, patchReady } from './lib/webPatches';

function UpdateHealth({ id }: { id: string | undefined }) {
  useEffect(() => { if (id) void patchReady(id).catch(() => { /* A failed acknowledgement leaves rollback enabled. */ }); }, [id]);
  return null;
}

let starting = false;
async function start() {
  if (starting) return;
  starting = true;
  const element = document.getElementById('root')!;
  const startup = showStartupScreen(element, () => { void start(); }, visible => {
    if (IS_ANDROID) void import('./lib/platform/nativeStartupAppearance')
      .then(({ setNativeStartupVisible }) => setNativeStartupVisible(visible)).catch(() => { /* Appearance cannot block profile loading. */ });
  });
  startup.phase(IS_ANDROID ? 'resources' : 'profile');
  try {
    const update = await patchStatus();
    if (IS_ANDROID) {
      const { initializeAndroidPlatform } = await import('./lib/platform/android');
      await initializeAndroidPlatform();
    }
    startup.phase('profile');
    await initializeLocalDatabase();
    if (IS_DESKTOP) {
      const [{ flushPendingPersistentWrites }, { flushLocalDatabaseWrites }] = await Promise.all([
        import('./lib/storage'), import('./lib/localDatabase'),
      ]);
      (window as Window & { __READGE_FLUSH_LOCAL_DATA__?: () => Promise<void> }).__READGE_FLUSH_LOCAL_DATA__ = async () => {
        await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
      };
    }
    // Load modules with synchronous preference reads only after SQLite hydration.
    startup.phase('opening');
    const [{ default: App }, { MemoryProvider }] = await Promise.all([
      import('./App.tsx'), import('./lib/memoryV2/MemoryProvider'),
    ]);
    startup.dispose();
    createRoot(element).render(<StrictMode><MemoryProvider><App /><UpdateHealth id={update.id} /></MemoryProvider></StrictMode>);
  } catch (error) {
    startup.fail(error);
  } finally {
    starting = false;
  }
}
void start();
