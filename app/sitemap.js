import { SERVICE_PAGES } from "./services/service-data.js";

const SITE_URL = "https://www.liumeiti.vip";

function item(path, changeFrequency, priority) {
  return {
    url: `${SITE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency,
    priority,
  };
}

export default function sitemap() {
  return [
    item("/", "daily", 1),
    item("/shop", "daily", 0.9),
    item("/service-center", "weekly", 0.8),
    item("/legal", "monthly", 0.8),
    ...SERVICE_PAGES.map((service) => item(`/services/${service.slug}`, "weekly", 0.8)),
  ];
}
