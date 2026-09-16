// Trend sparklines (G015). A pure dependency-free SVG sparkline generator:
// take a series of numbers and emit an SVG polyline sparkline. The module
// is pure and dependency-free. Malformed inputs throw SparklineError.
// Dashboard embedding is a later slice.
class SparklineError extends Error { constructor(code, message) { super(message); this.name = "SparklineError"; this.code = code; } }
const fail = (code, message) => { throw new SparklineError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sparkline", message); };
// Generate an SVG sparkline. values is a non-empty number array.
// Options: width, height, stroke color, strokeWidth.
export function sparkline({ values, width = 100, height = 30, stroke = "#2563eb", strokeWidth = 1.5 }) {
  check(Array.isArray(values) && values.length > 0, "values must be a non-empty array");
  check(values.every(v => typeof v === "number" && Number.isFinite(v)), "every value must be a finite number");
  check(Number.isFinite(width) && width > 0, "width must be positive");
  check(Number.isFinite(height) && height > 0, "height must be positive");
  check(typeof stroke === "string" && stroke.length > 0, "stroke must be a non-empty string");
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1; // avoid divide-by-zero on flat series
  const stepX = values.length === 1 ? 0 : width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = (i * stepX).toFixed(2);
    const y = (height - ((v - min) / range) * height).toFixed(2);
    return `${x},${y}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">` +
    `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`;
  return svg;
}
export { SparklineError };
