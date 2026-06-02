import { randomInt } from "node:crypto";
import {
  checkRateLimit,
  generateCaptchaCode,
  rateLimitResponse,
  signRegisterCaptcha,
} from "../../_utils.js";

function buildCaptchaSvg(code) {
  const width = 118;
  const height = 44;
  const colors = ["#0f172a", "#0f766e", "#dc2626", "#7c3aed", "#334155"];
  const chars = code.split("").map((char, index) => {
    const x = 20 + index * 22 + randomInt(-2, 3);
    const y = 28 + randomInt(-3, 4);
    const rotate = randomInt(-9, 10);
    const color = colors[randomInt(0, colors.length)];
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" fill="${color}" font-size="24" font-family="Arial, Helvetica, sans-serif" font-weight="800">${char}</text>`;
  }).join("");
  const lines = Array.from({ length: 5 }).map((_, index) => {
    const y = 12 + randomInt(0, 24);
    const color = ["#14b8a6", "#dc2626", "#7c3aed", "#94a3b8", "#0f766e"][index];
    return `<path d="M${randomInt(2, 14)} ${y} C ${randomInt(30, 48)} ${randomInt(4, 40)}, ${randomInt(68, 88)} ${randomInt(4, 40)}, ${randomInt(104, 116)} ${randomInt(8, 36)}" stroke="${color}" stroke-width="${index === 1 ? 2 : 1.4}" fill="none" stroke-linecap="round" opacity="${index === 3 ? 0.55 : 0.76}"/>`;
  }).join("");
  const dots = Array.from({ length: 18 }).map(() => {
    const x = randomInt(6, width - 6);
    const y = randomInt(7, height - 7);
    const color = colors[randomInt(0, colors.length)];
    return `<circle cx="${x}" cy="${y}" r="${randomInt(1, 3) / 2}" fill="${color}" opacity="0.32"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="验证码">
  <rect width="${width}" height="${height}" rx="12" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="11.5" fill="none" stroke="#dbe7ea"/>
  ${dots}
  ${chars}
  ${lines}
</svg>`;
}

export async function GET(request) {
  const guard = await checkRateLimit(request, {
    namespace: "auth:captcha",
    limit: 30,
    windowSec: 10 * 60,
  });
  if (!guard.ok) return rateLimitResponse(guard, "验证码刷新过于频繁，请稍后再试");

  const code = generateCaptchaCode(4);
  const svg = buildCaptchaSvg(code);
  const image = `data:image/svg+xml;base64,${Buffer.from(svg, "utf-8").toString("base64")}`;
  return Response.json({
    ok: true,
    token: signRegisterCaptcha(code),
    image,
  }, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
