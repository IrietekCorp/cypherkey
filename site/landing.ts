import { initTheme } from './theme';

/**
 * The two moving parts on the landing page.
 *
 * Both are decorative and both are written so that losing them costs nothing: the
 * carousel is five cards that are all in the DOM and all readable, and the hero panel is
 * a picture of a signal. If this module never runs, the page is a page.
 */

initTheme();

/* ---- the hero panel ----------------------------------------------------- */

const WAVE_BARS = 28;
const WAVE_MS = 420;

/**
 * A demonstration of the shape of the signal, not a reading of one.
 *
 * It matters that this is honest about what it is. Nothing here is measured -- the page
 * is not listening to anybody -- so the numbers drift within the range a real dwell and
 * flight occupy, and the one number that is a promise rather than a sample, `stored 0 B`,
 * is static markup that no script can move.
 */
function startHeroWave(): void {
  const wave = document.querySelector<HTMLElement>('[data-hero-wave]');
  const dwell = document.querySelector<HTMLElement>('[data-hero-dwell]');
  const flight = document.querySelector<HTMLElement>('[data-hero-flight]');
  if (wave === null) return;

  const heights: number[] = Array.from(
    { length: WAVE_BARS },
    (_, k) => 30 + 40 * Math.abs(Math.sin(k * 0.7)),
  );
  const bars = heights.map((height, k) => {
    const bar = document.createElement('span');
    bar.style.height = `${height}%`;
    // The oldest bars fade out, so the eye reads the strip left-to-right as time.
    bar.style.opacity = String(0.35 + 0.65 * (k / WAVE_BARS));
    wave.append(bar);
    return bar;
  });

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  window.setInterval(() => {
    heights.push(20 + Math.random() * 56);
    heights.shift();
    for (const [k, bar] of bars.entries()) bar.style.height = `${heights[k]}%`;
    if (dwell !== null) dwell.textContent = String(70 + Math.round(Math.random() * 40));
    if (flight !== null) flight.textContent = String(95 + Math.round(Math.random() * 60));
  }, WAVE_MS);
}

/* ---- the carousel -------------------------------------------------------- */

const AUTO_MS = 6000;

function startCarousel(): void {
  const root = document.querySelector<HTMLElement>('[data-carousel]');
  const track = document.querySelector<HTMLElement>('[data-carousel-track]');
  const bars = document.querySelector<HTMLElement>('[data-carousel-bars]');
  const counter = document.querySelector<HTMLElement>('[data-carousel-counter]');
  if (root === null || track === null) return;

  const slides = [...track.querySelectorAll<HTMLElement>('.ck-slide')];
  if (slides.length === 0) return;

  const trackEl = track;
  let index = 0;
  let paused = false;

  const dots = slides.map((_, k) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Go to slide ${k + 1}`);
    dot.addEventListener('click', () => {
      go(k);
      // A deliberate choice should not be taken away again two seconds later.
      paused = true;
    });
    bars?.append(dot);
    return dot;
  });

  function go(next: number): void {
    const count = slides.length;
    index = ((next % count) + count) % count;

    // The track is laid out in `min(78%, 720px)` columns with a 16px gap, so the offset
    // has to be computed the same way rather than from a measured width -- measuring
    // mid-transition returns the position it is travelling through.
    trackEl.style.transform = `translateX(calc(${-index} * (min(78%, 720px) + 16px)))`;

    for (const [k, slide] of slides.entries()) {
      slide.dataset.active = String(k === index);
      // Off-screen slides stay in the document and stay readable, but they are not
      // stops on the way to the next focusable thing.
      slide.setAttribute('aria-hidden', String(k !== index));
    }
    for (const [k, dot] of dots.entries()) {
      dot.setAttribute('aria-current', String(k === index));
    }
    if (counter !== null) {
      counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')} · Why rhythm`;
    }
  }

  document.querySelector('[data-carousel-prev]')?.addEventListener('click', () => go(index - 1));
  document.querySelector('[data-carousel-next]')?.addEventListener('click', () => go(index + 1));

  // Hovering is reading. Advancing out from under someone mid-sentence is the one thing
  // a carousel must not do.
  root.addEventListener('mouseenter', () => {
    paused = true;
  });
  root.addEventListener('mouseleave', () => {
    paused = false;
  });
  root.addEventListener('focusin', () => {
    paused = true;
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') go(index + 1);
    if (event.key === 'ArrowLeft') go(index - 1);
  });

  go(0);

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.setInterval(() => {
      if (!paused) go(index + 1);
    }, AUTO_MS);
  }
}

startHeroWave();
startCarousel();
