import { SERVICE_PAGES } from "./services/service-data.js";
import { GUIDES } from "./guides/guides-data.js";

const SITE_URL = "https://www.liumeiti.vip";

function item(path, changeFrequency, priority, lastModified) {
  const entry = {
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  };

  if (lastModified) entry.lastModified = new Date(`${lastModified}T00:00:00+08:00`);
  return entry;
}

export default function sitemap() {
  return [
    item("/", "daily", 1),
    item("/shop", "daily", 0.9),
    item("/service-center", "weekly", 0.8),
    item("/legal", "monthly", 0.8),
    item("/announcements", "weekly", 0.7),
    item("/guides", "weekly", 0.7),
    ...SERVICE_PAGES.map((service) => item(`/services/${service.slug}`, "weekly", 0.8)),
    ...GUIDES.map((g) => item(`/guides/${g.slug}`, "monthly", 0.6, g.updated)),
  ];
}
