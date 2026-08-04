function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const power = 10 ** exponent;
  const fraction = rawStep / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

export function axisScale(maxValue, tickCount = 4, integer = false) {
  const max = Math.max(0, finiteNumber(maxValue));
  if (max === 0) return { max: 1, ticks: [0] };
  const calculatedStep = niceStep(max / tickCount);
  const step = integer ? Math.max(1, Math.ceil(calculatedStep)) : Math.max(max <= tickCount ? 1 : 0, calculatedStep);
  const axisMax = Math.max(tickCount, step * tickCount);
  return {
    max: axisMax,
    ticks: Array.from({ length: tickCount + 1 }, (_, index) => step * index),
  };
}
