import { useEffect, useRef, type CSSProperties } from 'react';
import { ReadAgeBrand } from './ReadAgeBrand';
import './landingPage.css';

type LandingPageProps = {
  onStartReading: () => void;
};

type Particle = {
  left: string;
  size: string;
  opacity: string;
  duration: string;
  delay: string;
  drift: string;
  driftBack: string;
};

function createParticles(count: number): Particle[] {
  let seed = 2026;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  return Array.from({ length: count }, () => {
    const drift = random() * 90 - 45;
    return {
      left: `${(random() * 100).toFixed(2)}%`,
      size: `${(random() * 2.7 + 0.7).toFixed(2)}px`,
      opacity: (random() * 0.52 + 0.12).toFixed(2),
      duration: `${(random() * 13 + 10).toFixed(2)}s`,
      delay: `${(random() * -24).toFixed(2)}s`,
      drift: `${drift.toFixed(1)}px`,
      driftBack: `${(drift * -0.35).toFixed(1)}px`,
    };
  });
}

const PARTICLES = createParticles(68);

export function LandingPage({ onStartReading }: LandingPageProps) {
  const heroCopyRef = useRef<HTMLElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousTitle = document.title;
    const previousBodyOverflow = document.body.style.overflow;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousThemeColor = themeColor?.content;

    document.title = 'ReadAge — Find Your Reading Edge';
    document.body.style.overflow = 'hidden';
    themeColor?.setAttribute('content', '#07131f');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const handlePointerMove = (event: PointerEvent) => {
      const x = event.clientX / window.innerWidth - 0.5;
      const y = event.clientY / window.innerHeight - 0.5;

      if (heroCopyRef.current) {
        heroCopyRef.current.style.transform =
          `translate(calc(-50% + ${x * -10}px), calc(-50% + ${y * -6}px))`;
      }
      if (bookRef.current) {
        bookRef.current.style.transform =
          `translateX(calc(-50% + ${x * 8}px)) translateY(${y * 4}px)`;
      }
    };

    if (!reduceMotion && finePointer) {
      window.addEventListener('pointermove', handlePointerMove);
    }

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      document.title = previousTitle;
      document.body.style.overflow = previousBodyOverflow;
      if (themeColor && previousThemeColor) {
        themeColor.setAttribute('content', previousThemeColor);
      }
    };
  }, []);

  return (
    <main className="readage-landing">
      <div className="readage-landing__aurora" aria-hidden="true" />
      <div className="readage-landing__particles" aria-hidden="true">
        {PARTICLES.map((particle, index) => (
          <i
            className="readage-landing__particle"
            key={index}
            style={{
              left: particle.left,
              '--particle-size': particle.size,
              '--particle-opacity': particle.opacity,
              '--particle-duration': particle.duration,
              '--particle-delay': particle.delay,
              '--particle-drift': particle.drift,
              '--particle-drift-back': particle.driftBack,
            } as CSSProperties}
          />
        ))}
      </div>

      <header className="readage-landing__header">
        <a className="readage-landing__brand" href="/" aria-label="ReadAge home">
          <ReadAgeBrand
            textTone="inverse"
            logoClassName="h-8 w-8"
            nameClassName="text-sm uppercase tracking-[0.14em]"
          />
        </a>
      </header>

      <section
        className="readage-landing__hero-copy"
        aria-labelledby="readage-landing-title"
        ref={heroCopyRef}
      >
        <p className="readage-landing__eyebrow">
          Find the level where reading becomes discovery
        </p>
        <h1
          className="readage-landing__title"
          id="readage-landing-title"
          aria-label="ReadAge"
        >
          <span className="readage-landing__title-solid">Read</span>
          <span className="readage-landing__title-outline">Age</span>
          <span className="readage-landing__title-dot" aria-hidden="true" />
        </h1>
      </section>

      <div className="readage-landing__book" aria-hidden="true" ref={bookRef}>
        <div className="readage-landing__page-edge" />
        <div className="readage-landing__page readage-landing__page--left" />
        <div className="readage-landing__page readage-landing__page--right" />
        <div className="readage-landing__page-lines readage-landing__page-lines--left" />
        <div className="readage-landing__page-lines readage-landing__page-lines--right" />
      </div>

      <div className="readage-landing__start-wrap">
        <button
          className="readage-landing__start-button"
          type="button"
          onClick={onStartReading}
          aria-label="Start article reading"
        >
          Start
        </button>
      </div>
    </main>
  );
}
