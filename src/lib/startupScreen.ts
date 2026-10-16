export type StartupPhase = 'resources' | 'profile' | 'opening';

const phaseText: Record<StartupPhase, string> = {
  resources: '正在检查本机资源…',
  profile: '正在读取学习档案…',
  opening: '正在打开阅读空间…',
};

const startupMarkup = `<div class="app-startup__hero">
  <div class="app-startup__art" aria-hidden="true">
    <svg class="app-startup__composition" viewBox="0 0 360 370" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-19 180 185)">
        <rect x="-43" y="61" width="345" height="43" rx="21.5" fill="#FFBB8D"/>
        <rect x="72" y="136" width="256" height="114" rx="33" fill="#FFF7E9"/>
        <circle cx="72" cy="136" r="35" fill="#211A16"/>
        <circle cx="328" cy="250" r="35" fill="#211A16"/>
        <rect x="-26" y="279" width="189" height="29" rx="14.5" fill="#FFBB8D"/>
        <rect x="351" y="156" width="84" height="29" rx="14.5" fill="#FFBB8D"/>
      </g>
    </svg>
  </div>
  <h1 class="app-startup__name">ReadAge</h1>
</div>
<div class="app-startup__loading">
  <span class="app-startup__activity" aria-hidden="true"></span>
  <p class="app-startup__status" data-startup-status role="status" aria-live="polite">正在打开阅读空间…</p>
  <p class="app-startup__hint" data-startup-hint hidden></p>
</div>`;

const appearanceObservers = new WeakMap<HTMLElement, MutationObserver>();

function setWebStartupAppearance(visible: boolean) {
  document.documentElement.toggleAttribute('data-app-starting', visible);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', visible ? '#ff5b22' : '#f8f6f0');
}

/** A small, dependency-free shell that can render before the database and React. */
export function showStartupScreen(root: HTMLElement, retry: () => void, onVisibilityChange?: (visible: boolean) => void) {
  appearanceObservers.get(root)?.disconnect();
  setWebStartupAppearance(true); onVisibilityChange?.(true);
  let screen = root.querySelector<HTMLElement>('[data-startup-screen]');
  if (!screen) {
    screen = document.createElement('main');
    screen.className = 'app-startup';
    screen.dataset.startupScreen = '';
    const content = document.createElement('div');
    content.className = 'app-startup__content';
    content.innerHTML = startupMarkup;
    screen.append(content); root.replaceChildren(screen);
  }
  const observer = new MutationObserver(() => {
    if (root.querySelector('[data-startup-screen]')) return;
    observer.disconnect(); appearanceObservers.delete(root);
    setWebStartupAppearance(false); onVisibilityChange?.(false);
  });
  observer.observe(root, { childList: true, subtree: true });
  appearanceObservers.set(root, observer);
  screen.setAttribute('aria-busy', 'true');
  const status = screen.querySelector<HTMLElement>('[data-startup-status]')!;
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const hint = screen.querySelector<HTMLElement>('[data-startup-hint]')!;
  const activity = screen.querySelector<HTMLElement>('.app-startup__activity')!;
  let disposed = false;
  const slowTimer = window.setTimeout(() => {
    if (disposed) return;
    hint.textContent = '首次打开或更新资源时会稍久，请保持应用开启。';
    hint.hidden = false;
  }, 8000);
  const dispose = () => { disposed = true; window.clearTimeout(slowTimer); };
  return {
    phase(phase: StartupPhase) { if (!disposed) status.textContent = phaseText[phase]; },
    dispose,
    fail(error: unknown) {
      dispose(); screen.setAttribute('aria-busy', 'false'); activity.hidden = true;
      status.setAttribute('role', 'alert'); status.textContent = '暂时无法打开阅读空间';
      hint.textContent = error instanceof Error ? error.message : '学习档案读取失败，请重试。';
      hint.hidden = false;
      const button = document.createElement('button');
      button.className = 'app-startup__retry'; button.type = 'button'; button.textContent = '重新尝试';
      button.onclick = () => { button.disabled = true; root.replaceChildren(); retry(); };
      status.parentElement!.append(button);
      button.focus({ preventScroll: true });
    },
  };
}
