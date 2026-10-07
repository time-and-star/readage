import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { buildForgettingCurveModel, predictPersonalRecallPercent, type ForgettingCurveHorizon, type ForgettingCurvePoint } from '../lib/forgettingCurve';
import type { WordMemoryState } from '../lib/memoryV2/types';
import './forgettingCurvePanel.css';

interface ForgettingCurvePanelProps {
  states: readonly WordMemoryState[];
  currentWordId?: string;
  currentWordLabel?: string;
  canonicalWordIds?: ReadonlyMap<string, string>;
}

function timeLabel(days: number): string {
  if (days === 0) return '0 天';
  if (days < 1 / 24) return `${Math.round(days * 1440)} 分钟`;
  if (days < 1) return `${Number((days * 24).toFixed(1))} 小时`;
  return `${Number(days.toFixed(1))} 天`;
}

function percentLabel(percent: number | null): string {
  return percent === null ? '暂无预测' : `约 ${Math.round(percent)}%`;
}

/** Monotone cubic segments preserve sampled percentages without overshooting 0–100%. */
function curvePath(points: readonly ForgettingCurvePoint[], x: (day: number) => number, y: (percent: number) => number): string {
  if (!points.length) return '';
  const nodes = points.map(point => ({ x: x(point.elapsedDays), y: y(point.percent) }));
  if (nodes.length === 1) return `M ${nodes[0].x} ${nodes[0].y}`;
  const slopes = nodes.slice(1).map((node, index) => (node.y - nodes[index].y) / (node.x - nodes[index].x));
  const tangents = nodes.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === nodes.length - 1) return slopes.at(-1)!;
    const left = slopes[index - 1];
    const right = slopes[index];
    if (left * right <= 0) return 0;
    const leftWidth = nodes[index].x - nodes[index - 1].x;
    const rightWidth = nodes[index + 1].x - nodes[index].x;
    const firstWeight = 2 * rightWidth + leftWidth;
    const secondWeight = rightWidth + 2 * leftWidth;
    return (firstWeight + secondWeight) / (firstWeight / left + secondWeight / right);
  });
  return nodes.slice(1).reduce((path, node, index) => {
    const left = nodes[index];
    const width = (node.x - left.x) / 3;
    return `${path} C ${(left.x + width).toFixed(3)} ${(left.y + width * tangents[index]).toFixed(3)}, ${(node.x - width).toFixed(3)} ${(node.y - width * tangents[index + 1]).toFixed(3)}, ${node.x.toFixed(3)} ${node.y.toFixed(3)}`;
  }, `M ${nodes[0].x.toFixed(3)} ${nodes[0].y.toFixed(3)}`);
}

function CurveChart({ id, points, width, height, horizon, draw, animationKey, ariaLabel, selectedTime, selectedValue = null, onSelectTime }: {
  id: string;
  points: readonly ForgettingCurvePoint[];
  width: number;
  height: number;
  horizon: ForgettingCurveHorizon;
  draw: boolean;
  animationKey: string;
  ariaLabel: string;
  selectedTime?: number;
  selectedValue?: number | null;
  onSelectTime?: (time: number) => void;
}) {
  const compact = width < 540;
  const left = compact ? 32 : 43;
  const right = width - 15;
  const top = 22;
  const bottom = height - 42;
  const x = (day: number) => left + day / horizon * (right - left);
  const y = (percent: number) => bottom - percent / 100 * (bottom - top);
  const path = curvePath(points, x, y);
  const ticks = horizon === 1 ? [0, .25, .5, .75, 1] : horizon === 7 ? [0, 1, 3, 5, 7] : [0, 7, 14, 21, 30];

  return <svg key={animationKey} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}
    onPointerMove={onSelectTime ? event => {
      if (event.pointerType === 'touch') return;
      const rectangle = event.currentTarget.getBoundingClientRect();
      onSelectTime(Math.max(0, Math.min(horizon, ((event.clientX - rectangle.left) / rectangle.width * width - left) / (right - left) * horizon)));
    } : undefined}>
    <defs><clipPath id={`${id}-plot`}><rect x={left - 3} y={top - 4} width={right - left + 6} height={bottom - top + 8} /></clipPath><filter id={`${id}-glow`} x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="2.3" /></filter></defs>
    {[0, 25, 50, 75, 100].map(percent => <g key={percent}><line className="forgetting-chart-grid" x1={left} x2={right} y1={y(percent)} y2={y(percent)} /><text className="forgetting-chart-tick forgetting-chart-tick--personal" x={left - 9} y={y(percent) + 4} textAnchor="end">{percent}</text></g>)}
    {ticks.map(day => <g key={day}><line className="forgetting-chart-tick-mark" x1={x(day)} x2={x(day)} y1={bottom} y2={bottom + 5} /><text className="forgetting-chart-tick" x={x(day)} y={bottom + 25} textAnchor={day === horizon ? 'end' : 'middle'}>{timeLabel(day)}</text></g>)}
    <g clipPath={`url(#${id}-plot)`}>
      <path className={`forgetting-chart-line forgetting-chart-line--personal ${draw ? 'forgetting-chart-line--draw' : 'forgetting-chart-line--waiting'}`} d={path} pathLength={1} />
      {selectedTime !== undefined && selectedValue !== null && <><line className="forgetting-chart-cursor" x1={x(selectedTime)} x2={x(selectedTime)} y1={top} y2={bottom} /><circle className="forgetting-chart-selected forgetting-chart-selected--personal" cx={x(selectedTime)} cy={y(selectedValue)} r={compact ? 3.6 : 4.6} /></>}
      {draw && path && <g className="forgetting-chart-glint" aria-hidden="true"><circle r="7" fill="#b5e6d8" opacity=".65" filter={`url(#${id}-glow)`} /><circle r="2.4" fill="#fff8d7" /><animateMotion path={path} dur="1.4s" begin=".35s" fill="freeze" /><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.08;.82;1" dur="1.6s" begin=".25s" fill="freeze" /></g>}
    </g>
  </svg>;
}

export function ForgettingCurvePanel({ states, currentWordId, currentWordLabel, canonicalWordIds }: ForgettingCurvePanelProps) {
  const id = useId().replace(/:/g, '');
  const gardenRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [horizon, setHorizon] = useState<ForgettingCurveHorizon>(7);
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [selectedTime, setSelectedTime] = useState(7);
  const [chartWidth, setChartWidth] = useState(760);
  const [projectionTime, setProjectionTime] = useState(() => new Date());
  const [curveVisible, setCurveVisible] = useState(false);

  useEffect(() => {
    if (!open) { setCurveVisible(false); return; }
    let active = true;
    const observer = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .15)) {
        setCurveVisible(true);
        observer.disconnect();
      }
    }, { threshold: .15 });
    if (chartRef.current) observer.observe(chartRef.current);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => gardenRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }), reduceMotion ? 0 : 520);
    return () => { active = false; observer.disconnect(); window.clearTimeout(timer); };
  }, [open]);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;
    const observer = new ResizeObserver(entries => { const actualWidth = entries[0].contentRect.width; if (actualWidth > 0) setChartWidth(actualWidth); });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!currentWordId && scope === 'current') setScope('all');
  }, [currentWordId, scope]);

  const model = useMemo(() => buildForgettingCurveModel(states, { now: new Date(), horizonDays: horizon, currentWordId, canonicalWordIds }), [states, projectionTime, horizon, currentWordId, canonicalWordIds]);
  const personal = scope === 'all' ? model.personal.allWords : model.personal.currentWord;
  const activeTime = Math.min(selectedTime, horizon);
  const personalValue = predictPersonalRecallPercent(activeTime, personal.stabilityDaysByWord);
  const height = chartWidth < 350 ? 220 : chartWidth < 640 ? 250 : 290;
  const animationKey = `${scope}:${horizon}:${scope === 'current' ? currentWordId : 'all'}:${personal.reviewCount}:${open}:${curveVisible}`;

  const changeHorizon = (days: ForgettingCurveHorizon) => {
    setHorizon(days);
    setSelectedTime(days);
  };

  return <section className={`forgetting-disclosure ${open ? 'forgetting-disclosure--open' : ''}`}>
    <button type="button" className="forgetting-disclosure__toggle" id={`${id}-toggle`} aria-expanded={open} aria-controls={`${id}-content`}
      onClick={() => { if (!open) setProjectionTime(new Date()); setOpen(value => !value); }}>
      <span>记忆曲线</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    <div className="forgetting-disclosure__collapse" id={`${id}-content`} role="region" aria-labelledby={`${id}-toggle`} aria-hidden={!open} inert={!open}>
      <div className="forgetting-disclosure__clip">
        <div ref={gardenRef} className="forgetting-garden">
          <header className="forgetting-garden__header"><div><p className="forgetting-garden__eyebrow">THE GARDEN OF MEMORY</p><h2>记忆的时间</h2></div></header>

          <div className="forgetting-garden__chart-card">
            <div className="forgetting-garden__toolbar"><div className="forgetting-garden__segmented" role="group" aria-label="个人曲线范围"><button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>我的词库</button><button type="button" disabled={!currentWordId} aria-pressed={scope === 'current'} onClick={() => setScope('current')}>当前词</button></div><div className="forgetting-garden__horizons" role="group" aria-label="观察时间范围">{([1, 7, 30] as const).map(days => <button type="button" key={days} aria-pressed={horizon === days} onClick={() => changeHorizon(days)}>{days} 天</button>)}</div></div>

            <h3 className="forgetting-garden__chart-title">复习后记忆预测</h3>
            {scope === 'current' && <p className="forgetting-garden__word" lang="en">{currentWordLabel || currentWordId}</p>}
            <p className="forgetting-garden__metric">预计回忆成功率 %</p>
            {personal.currentPercent !== null && <p className="forgetting-garden__data-note">按各词实际距上次回忆的时间计算，当前预计回忆率 {percentLabel(personal.currentPercent)}。</p>}

            <div ref={chartRef} className="forgetting-garden__chart">
              {personal.points.length ? <CurveChart id={`${id}-personal`} points={personal.points} width={chartWidth} height={height} horizon={horizon} draw={open && curveVisible} animationKey={animationKey} selectedTime={activeTime} selectedValue={personalValue} onSelectTime={setSelectedTime}
                ariaLabel={`复习后记忆预测。横轴为距每个词上次评分的天数，范围 ${horizon} 天；纵轴为 FSRS 预计回忆成功率。各词从上次评分后对齐，假设此后不再学习，0 天的 100% 是模型起点，并非实测成绩。`} /> : <div className="forgetting-garden__empty" role="status"><p>还没有可用的复习记录</p><span>完成词卡评分后，会显示初步预测。</span></div>}
            </div>
            {personal.points.length > 0 && <>
            <p className="forgetting-garden__x-axis">距每个词上次评分</p>

            <div className="forgetting-garden__explorer"><div className="forgetting-garden__readout"><span className="forgetting-garden__time">复习后 <strong>{timeLabel(activeTime)}</strong></span><span className="forgetting-garden__personal-value">预计回忆成功率 <strong>{percentLabel(personalValue)}</strong></span></div><label className="sr-only" htmlFor={`${id}-time`}>探索复习后的时间</label><input id={`${id}-time`} type="range" min={0} max={horizon} step="any" value={activeTime} onChange={event => setSelectedTime(Number(event.target.value))} aria-valuetext={`复习后 ${timeLabel(activeTime)}，预计回忆成功率 ${percentLabel(personalValue)}`} /></div>

            <p className="forgetting-garden__data-note">默认模型{personal.status === 'limited' ? '初步' : ''}估计 · {personal.wordCount} 个词 · {personal.reviewCount} 条回忆记录</p>
            <p className="forgetting-garden__data-note">{personal.dataNote}</p>
            <p className="forgetting-garden__assumption">假设此后不再学习；0 天的 100% 是模型起点，并非实测。</p>
            </>}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
