import { buildStudyPattern, drawStudyGlass } from './renderer';

const root = document.getElementById('glass-study')!;
const defaults = [
  { name: '纤细微光', seamWidth: .8, transmission: .40, halo: 2, refraction: 1.2 },
  { name: '清透棱光', seamWidth: 1.6, transmission: .58, halo: 4, refraction: 1.8 },
  { name: '宽缝圣光', seamWidth: 3.2, transmission: .78, halo: 8, refraction: 2.6 },
  { name: '弥散辉光', seamWidth: 4.8, transmission: .92, halo: 12, refraction: 3.6 },
];
const states = defaults.map(value => ({ ...value }));
const fields = ['seamWidth', 'transmission', 'halo', 'refraction'] as const;
const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-preset]'));
const canvases = cards.map(card => card.querySelector<HTMLCanvasElement>('canvas')!);
const selectors = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-select]'));
const source = document.getElementById('source')!;
const status = document.getElementById('analysis')!;
const error = document.getElementById('error')!;
const fileInput = document.getElementById('photo') as HTMLInputElement;
const originalButton = document.getElementById('original')!;
const paneSelect = document.getElementById('panes') as HTMLSelectElement;
let selected = 2;
let original = false;
let image: HTMLImageElement | null = null;
let pattern: ReturnType<typeof buildStudyPattern> | null = null;
let imageVersion = 0;
let frame = 0;
let objectUrl: string | null = null;

function updateLabels() {
  cards.forEach((card, index) => {
    const state = states[index];
    card.querySelector<HTMLElement>('[data-ratio]')!.textContent = `×${(state.seamWidth / .8).toFixed(1).replace(/\.0$/, '')}`;
    card.querySelector<HTMLElement>('[data-values]')!.textContent = ` · 缝宽 ${state.seamWidth.toFixed(1)} · 透光 ${Math.round(state.transmission * 100)}%`;
    card.classList.toggle('selected', index === selected);
    selectors[index].setAttribute('aria-pressed', String(index === selected));
    selectors[index].textContent = index === selected ? '已选 · 可调节' : '选择并调节';
  });
  document.getElementById('selected-name')!.textContent = states[selected].name;
  fields.forEach(field => {
    (document.getElementById(field) as HTMLInputElement).value = String(states[selected][field]);
    document.getElementById(`${field}-value`)!.textContent = field === 'transmission'
      ? `${Math.round(states[selected][field] * 100)}%` : states[selected][field].toFixed(1).replace(/\.0$/, '');
  });
}

function render() {
  frame = 0;
  if (!image || !pattern) return;
  const widths = canvases.map(canvas => canvas.parentElement!.clientWidth - 2);
  const width = Math.max(1, Math.min(...widths));
  canvases.forEach((canvas, index) => {
    drawStudyGlass(canvas, image!, pattern!, { ...states[index], original, width });
    canvas.dataset.panes = String(pattern!.paneCount);
    canvas.dataset.seamWidth = String(states[index].seamWidth);
    canvas.dataset.transmission = String(states[index].transmission);
    canvas.dataset.refraction = String(states[index].refraction);
    canvas.dataset.original = String(original);
    canvas.dataset.ready = 'true';
  });
}

function queueRender() {
  if (!frame) frame = requestAnimationFrame(render);
}

function rebuild() {
  if (!image) return;
  pattern = buildStudyPattern(image, paneSelect.value === 'auto' ? 'auto' : Number(paneSelect.value));
  status.textContent = `${pattern.paneCount} 块 · 四图共用同一纹样`;
  queueRender();
}

async function loadPhoto(src: string, name: string) {
  const version = ++imageVersion;
  status.textContent = '准备玻璃纹样…';
  error.hidden = true;
  const next = new Image();
  try {
    await new Promise<void>((resolve, reject) => { next.onload = () => resolve(); next.onerror = reject; next.src = src; });
    if (version !== imageVersion) {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src);
      return;
    }
    image = next;
    source.textContent = name;
    if (objectUrl && objectUrl !== src) URL.revokeObjectURL(objectUrl);
    objectUrl = src.startsWith('blob:') ? src : null;
    rebuild();
  } catch {
    if (src.startsWith('blob:')) URL.revokeObjectURL(src);
    if (version !== imageVersion) return;
    error.textContent = '这张图片无法读取，请选择浏览器支持的 JPG、PNG 或 WebP 照片。';
    error.hidden = false;
    status.textContent = pattern ? `${pattern.paneCount} 块 · 四图共用同一纹样` : '请选择照片';
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadPhoto(URL.createObjectURL(file), file.name);
});
document.getElementById('sample')!.addEventListener('click', () => {
  fileInput.value = '';
  void loadPhoto(root.dataset.sample!, '示例：Somi · 来自你的杂志藏书');
});
originalButton.addEventListener('click', () => {
  original = !original;
  originalButton.setAttribute('aria-pressed', String(original));
  originalButton.textContent = original ? '返回玻璃效果' : '查看原图';
  queueRender();
});
selectors.forEach((button, index) => button.addEventListener('click', () => { selected = index; updateLabels(); }));
fields.forEach(field => {
  document.getElementById(field)!.addEventListener('input', event => {
    states[selected][field] = Number((event.target as HTMLInputElement).value);
    updateLabels();
    queueRender();
  });
});
document.getElementById('restore')!.addEventListener('click', () => {
  states[selected] = { ...defaults[selected] };
  updateLabels(); queueRender();
});
paneSelect.addEventListener('change', rebuild);
const resize = new ResizeObserver(queueRender);
canvases.forEach(canvas => resize.observe(canvas.parentElement!));
window.addEventListener('beforeunload', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
updateLabels();
void loadPhoto(root.dataset.sample!, '示例：Somi · 来自你的杂志藏书');
