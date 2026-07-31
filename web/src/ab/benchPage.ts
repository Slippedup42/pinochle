// Browser side of #115's cost measurement.
//
// The Node numbers answer "what does the model cost per decision"; this answers
// it in the runtime the product actually runs in, at the viewport it ships to.
// Same code path, same positions, same statistic — only the host differs.
//
// Loaded by `bench/index.html`, which the Vite dev server serves and the
// production build ignores (`build.rollupOptions.input` is `index.html` alone),
// so nothing here reaches a player or the PWA precache.
//
// Two caveats a reader of the numbers needs:
//
//   Dev-server code, not the minified bundle. Minification does not change what
//   the arithmetic does, and the Node run measures the same source, so this is
//   a cross-check on the runtime rather than an independent third number.
//
//   `performance.now()` is clamped to 100us in Chrome outside a
//   cross-origin-isolated context, which is why every position is timed over
//   repeats — see `latency.ts`. Single-shot samples are not collected here;
//   they would be measuring the clamp.

import { formatLatency, runLatencyBenchmark } from './latency'

const output = document.getElementById('out') as HTMLElement

function run(positions: number, repeats: number): void {
  output.textContent = 'measuring…'
  // Yield first so the "measuring" text paints before the main thread blocks.
  setTimeout(() => {
    const report = runLatencyBenchmark(positions, repeats, false)
    output.textContent = [
      `viewport ${window.innerWidth}x${window.innerHeight}, dpr ${window.devicePixelRatio}`,
      `userAgent ${navigator.userAgent}`,
      '',
      formatLatency(report),
    ].join('\n')
  }, 50)
}

;(document.getElementById('go') as HTMLElement).addEventListener('click', () =>
  run(
    Number((document.getElementById('positions') as HTMLInputElement).value),
    Number((document.getElementById('repeats') as HTMLInputElement).value),
  ),
)
