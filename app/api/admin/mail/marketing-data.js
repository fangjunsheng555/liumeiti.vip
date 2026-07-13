export async function buildMarketingArgs(brandName, siteDomain, siteUrl) {
  const origin = String(siteUrl || "https://www.liumeiti.vip").replace(/\/$/, "");
  const base = { brandName, siteDomain, siteUrl };
  try {
    const [{ getMergedCatalog }, { getSettings }] = await Promise.all([
      import("../../_catalog.js"),
      import("../../_settings.js"),
    ]);
    const [catalog, settings] = await Promise.all([getMergedCatalog(), getSettings()]);
    const byKey = Object.fromEntries(catalog.map((product) => [product.key, product]));
    const makeProduct = (key, name, subtitle, href, icon) => ({
      key,
      name,
      subtitle,
      price: byKey[key]?.active !== false ? (byKey[key]?.priceText || "查看实时价格") : "查看实时价格",
      href: origin + href,
      icon,
    });
    return {
      ...base,
      support: settings.support,
      products: [
        makeProduct("spotify", "Spotify", "家庭成员、个人、双人及家庭套餐", "/services/spotify", "spotify.jpg"),
        makeProduct("rocket", "机场节点", "多档真实流量与全年无限套餐", "/services/airport-node", "rocket.jpg"),
        makeProduct("ai", "AI 会员", "ChatGPT 与 Claude 多档会员", "/services/ai", "ai.jpg"),
        makeProduct("netflix", "Netflix", "4K 杜比车位或整号", "/services/netflix", "netflix.jpg"),
        makeProduct("disney", "Disney+", "4K 杜比车位或整号", "/services/disney", "disney.jpg"),
        makeProduct("max", "HBO Max", "4K 杜比车位或整号", "/services/hbo-max", "hbomax.jpg"),
        makeProduct("proxy-pay", "全球代付", "海外网站与平台人工代付", "/services/proxy-payment", "proxy-pay.jpg"),
      ],
    };
  } catch (e) {
    return base;
  }
}
