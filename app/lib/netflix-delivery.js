export function normalizedService(value) {
  return String(value || "").trim().toLowerCase();
}

export function orderItemService(order, item, index = -1) {
  const itemService = normalizedService(item?.service);
  return itemService || (index === 0 ? normalizedService(order?.service) : "");
}

export function isNetflixOrderItem(order, item, index = -1) {
  return orderItemService(order, item, index) === "netflix";
}

export function netflixCredentialSecrets(order) {
  const items = Array.isArray(order?.items) && order.items.length > 0
    ? order.items
    : [order];
  const secrets = [];
  items.forEach((item, index) => {
    if (!isNetflixOrderItem(order, item, index)) return;
    const candidates = [
      item?.staffPassword,
      item?.password,
      ...(index === 0 ? [order?.staffPassword, order?.password] : []),
    ];
    for (const candidate of candidates) {
      const password = String(candidate || "").trim();
      if (password) secrets.push(password);
    }
  });
  return Array.from(new Set(secrets));
}

export function stripNetflixCredentialSecrets(order, value) {
  const text = String(value || "");
  if (order?.netflixDeliveryMode !== "self_service" || !text) return text;
  const secrets = netflixCredentialSecrets(order);
  if (!secrets.length) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !secrets.some((secret) => line.includes(secret)))
    .join("\n")
    .trim();
}

const NETFLIX_SELF_SERVICE_INSTRUCTIONS = [
  "请先在 Netflix 官方登录页输入订单中的邮箱并继续；如页面要求登录码或身份确认，请打开 https://www.liumeiti.vip/netflix-code，按页面提示选择或核验订单，再读取登录码或打开 Netflix 官方确认链接。登录码和确认链接有时效，请及时使用。",
  "On Netflix, enter the email address shown in the order and continue. If Netflix asks for a sign-in code or identity confirmation, open https://www.liumeiti.vip/netflix-code and follow the page instructions to select or verify your order, then retrieve the sign-in code or open Netflix’s official confirmation link. Codes and confirmation links expire, so use the result promptly.",
];

function stripNetflixSelfServiceInstructions(value) {
  let text = String(value || "");
  for (const instruction of NETFLIX_SELF_SERVICE_INSTRUCTIONS) {
    text = text.split(instruction).join("");
  }
  // Compatibility for previously generated wording. Remove only the login-code
  // sentence, never the surrounding profile, PIN, restriction or expiry text.
  text = text
    .replace(/请先在 Netflix 官方登录页[^\n]*?netflix-code[^\n]*?请及时使用。/gi, "")
    .replace(/On Netflix, enter[^\n]*?netflix-code[^\n]*?use the result promptly\./gi, "");
  return text
    .split(/\r?\n/)
    .filter((line) => !/netflix-code/i.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function publicNetflixStaffNotes(order, { onlineCodeAvailable = true } = {}) {
  const notes = String(order?.staffNotes || "");
  if (order?.netflixDeliveryMode !== "self_service") return notes;
  // Custom notes may predate the delivery-mode switch and can contain a
  // retained password. Keep them available to staff, but never publish them.
  if (order?.deliveryMessageMode !== "auto") return "";
  const safeNotes = stripNetflixCredentialSecrets(order, notes);
  return onlineCodeAvailable ? safeNotes : stripNetflixSelfServiceInstructions(safeNotes);
}
