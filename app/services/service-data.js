export const SERVICE_PAGES = [
  {
    slug: "spotify",
    key: "spotify",
    title: "Spotify 会员服务",
    shortTitle: "Spotify",
    subtitle: "欧美日高价区多规格订阅",
    price: "¥128/年起",
    image: "/products/spotify.jpg",
    description: "提供 Spotify 家庭成员、个人订阅、双人订阅与家庭套餐，均为欧美日高价区订阅，支持无损音质、播客、AIDJ、离线下载与完整曲库",
    highlights: ["欧美日高价区", "个人/双人/家庭多规格", "订单完成后邮件同步"],
    plans: [
      ["家庭成员", "¥128/年", "加入高价区家庭计划，适合单人长期听歌"],
      ["个人订阅", "¥388/年", "独立订阅，账号使用边界更清晰"],
      ["双人订阅", "¥488/年", "可邀请 1 个账号免费享用订阅"],
      ["家庭套餐", "¥588/年", "可邀请 5 个账号免费享用订阅"],
    ],
    faq: [
      ["支持哪些功能", "支持无损音质、播客、AIDJ、离线下载、合辑歌单与完整曲库"],
      ["如何使用服务", "下载 Spotify app 或使用网页登录您的账号，即可开始使用"],
      ["适合什么用户", "适合长期听歌、家庭共享或需要高价区订阅权益的用户"],
    ],
  },
  {
    slug: "netflix",
    key: "netflix",
    title: "Netflix 4K 杜比会员",
    shortTitle: "Netflix",
    subtitle: "全球可用 4K 杜比车位/整号",
    price: "¥168/年起",
    image: "/products/netflix.jpg",
    description: "提供 Netflix 最高级别 4K 杜比套餐，支持单独车位与整号购买，单独车位可设置 PIN 锁，整号最多支持 5 个用户档案/车位",
    highlights: ["4K 杜比画质", "单独车位可上锁", "整号最多 5 个档案"],
    plans: [
      ["单独车位", "¥168/年", "一人独享一个用户档案，可设置 PIN 锁"],
      ["整号购买", "¥588/年", "最多支持 5 个用户档案/车位"],
    ],
    faq: [
      ["是否支持电视端", "支持常见电视端、手机端与浏览器端登录使用"],
      ["如何使用服务", "下载 Netflix app 或使用网页登录我们提供的账号，即可开始使用"],
      ["车位是否稳定", "单独车位可上锁，减少档案被误用的情况"],
    ],
  },
  {
    slug: "disney",
    key: "disney",
    title: "Disney+ 4K 杜比会员",
    shortTitle: "Disney+",
    subtitle: "全球可用 4K 杜比车位/整号",
    price: "¥108/年起",
    image: "/products/disney.jpg",
    description: "提供 Disney+ 最高级别 4K 杜比套餐，支持独立车位与整号购买，整号最多支持 7 个用户档案/车位，适合家庭共享与长期观看",
    highlights: ["4K 杜比套餐", "车位/整号可选", "最多 7 个用户档案"],
    plans: [
      ["单独车位", "¥108/年", "一人一位置，日常观影互不干扰"],
      ["整号购买", "¥588/年", "最多支持 7 个用户档案/车位"],
    ],
    faq: [
      ["适合什么内容", "适合 Disney、Pixar、Marvel、Star Wars 等内容观看"],
      ["如何使用服务", "下载 Disney+ app 或使用网页登录我们提供的账号，即可开始使用"],
      ["整号如何分配", "整号适合家庭或多人长期使用，可按档案区分观看记录"],
    ],
  },
  {
    slug: "hbo-max",
    key: "max",
    title: "HBO Max 4K 杜比会员",
    shortTitle: "HBO Max",
    subtitle: "全球可用 4K 杜比车位/整号",
    price: "¥148/年起",
    image: "/products/hbomax.jpg",
    description: "提供 HBO Max 最高级别 4K 杜比套餐，支持单独车位与整号购买，整号最多支持 5 个用户档案/车位，适合影迷家庭与多人稳定使用",
    highlights: ["4K 杜比内容", "独立车位", "整号最多 5 个档案"],
    plans: [
      ["单独车位", "¥148/年", "一人独享一个位置，互不干扰"],
      ["整号购买", "¥588/年", "最多支持 5 个用户档案/车位"],
    ],
    faq: [
      ["是否支持多设备", "支持常见手机、平板、电视端与浏览器端使用"],
      ["如何使用服务", "下载 HBO Max app 或使用网页登录我们提供的账号，即可开始使用"],
      ["售后如何处理", "订单完成后可在服务中心查询，也可通过在线客服继续沟通"],
    ],
  },
  {
    slug: "airport-node",
    key: "rocket",
    title: "机场节点服务",
    shortTitle: "机场节点",
    subtitle: "真实流量套餐与多节点加速",
    price: "¥128/年起",
    image: "/products/rocket.jpg",
    description: "提供多档真实流量节点服务，最高速率可达 5Gbps，覆盖港日台韩新美英德法等线路，适合流媒体、AI 工具与日常跨区访问",
    highlights: ["真实流量套餐", "最高 5Gbps", "全加密无日志"],
    plans: [
      ["普通套餐", "¥128/年", "50GB/月真实流量"],
      ["高级套餐", "¥198/年", "100GB/月真实流量"],
      ["豪华套餐", "¥398/年", "200GB/月真实流量"],
      ["无限套餐", "¥698/年", "无限流量"],
      ["5元10GB测试", "¥5/次", "10GB 测试流量"],
    ],
    faq: [
      ["是否支持节点测试", "我们提供 5元10GB 套餐可供测试"],
      ["如何使用服务", "iPhone/iPad 下载 Shadowrocket 小火箭，安卓下载 Clash Meta，Windows/mac 下载 Clash Verge，或使用其他主流客户端代理工具，导入我们的订阅链接即可开始使用"],
      ["支持哪些客户端", "支持常见订阅工具，订单完成后会提供订阅链接与使用说明"],
    ],
  },
];

// 英文翻译（按 locale 覆盖，不改中文原数据）
const SERVICE_EN = {
  spotify: {
    title: "Spotify Premium Membership",
    shortTitle: "Spotify",
    subtitle: "Premium Individual / Duo / Family plans",
    price: "from ¥128/yr",
    description: "Spotify Premium plans — Individual, Duo and Family — on premium regions, with lossless audio, podcasts, AI DJ, offline downloads and the full catalogue.",
    highlights: ["Premium-region accounts", "Individual / Duo / Family", "Emailed once the order completes"],
    plans: [
      ["Premium Family (member)", "¥128/yr", "Join a premium-region family plan — ideal for one long-term listener"],
      ["Premium Individual", "¥388/yr", "Standalone subscription with a clearer account boundary"],
      ["Premium Duo", "¥488/yr", "Invite 1 account to enjoy the subscription free"],
      ["Premium Family", "¥588/yr", "Invite up to 5 accounts to enjoy the subscription free"],
    ],
    faq: [
      ["What features are included", "Lossless audio, podcasts, AI DJ, offline downloads, playlists and the full catalogue"],
      ["How to use the service", "Download the Spotify app or sign in on the web with your account to start"],
      ["Who is it for", "Great for long-term listeners, family sharing, or anyone needing premium-region benefits"],
    ],
  },
  netflix: {
    title: "Netflix 4K Dolby Membership",
    shortTitle: "Netflix",
    subtitle: "Global 4K Dolby — Profile / full account",
    price: "from ¥168/yr",
    description: "Netflix's top 4K Dolby tier, available as a dedicated Profile or a full account. A dedicated Profile can be PIN-locked; a full account supports up to 5 user profiles.",
    highlights: ["4K Dolby quality", "Lockable dedicated Profile", "Up to 5 profiles per account"],
    plans: [
      ["Dedicated Profile", "¥168/yr", "One person, one profile — PIN lock supported"],
      ["Full account", "¥588/yr", "Supports up to 5 user profiles"],
    ],
    faq: [
      ["Does it work on TV", "Works on common TVs, phones and browsers"],
      ["How to use the service", "Download the Netflix app or sign in on the web with the account we provide"],
      ["Is the Profile stable", "A dedicated Profile can be PIN-locked to reduce misuse"],
    ],
  },
  disney: {
    title: "Disney+ 4K Dolby Membership",
    shortTitle: "Disney+",
    subtitle: "Global 4K Dolby — Profile / full account",
    price: "from ¥108/yr",
    description: "Disney+'s top 4K Dolby tier, available as a dedicated Profile or full account; a full account supports up to 7 profiles — ideal for family sharing and long-term viewing.",
    highlights: ["4K Dolby plan", "Profile or full account", "Up to 7 profiles"],
    plans: [
      ["Dedicated Profile", "¥108/yr", "One spot per person — watch without interference"],
      ["Full account", "¥588/yr", "Supports up to 7 user profiles"],
    ],
    faq: [
      ["What content is included", "Great for Disney, Pixar, Marvel, Star Wars and more"],
      ["How to use the service", "Download the Disney+ app or sign in on the web with the account we provide"],
      ["How are profiles assigned", "A full account suits families or long-term multi-user use; profiles keep watch history separate"],
    ],
  },
  "hbo-max": {
    title: "HBO Max 4K Dolby Membership",
    shortTitle: "HBO Max",
    subtitle: "Global 4K Dolby — Profile / full account",
    price: "from ¥148/yr",
    description: "HBO Max's top 4K Dolby tier, available as a dedicated Profile or full account; a full account supports up to 5 profiles — great for film-lover families and stable multi-user use.",
    highlights: ["4K Dolby content", "Dedicated Profile", "Up to 5 profiles per account"],
    plans: [
      ["Dedicated Profile", "¥148/yr", "One spot per person — no interference"],
      ["Full account", "¥588/yr", "Supports up to 5 user profiles"],
    ],
    faq: [
      ["Multiple devices supported", "Works on common phones, tablets, TVs and browsers"],
      ["How to use the service", "Download the HBO Max app or sign in on the web with the account we provide"],
      ["How is after-sales handled", "Check the Service Center after your order, or reach our online support"],
    ],
  },
  "airport-node": {
    title: "VPN Service",
    shortTitle: "VPN",
    subtitle: "Real-traffic plans & multi-node speed",
    price: "from ¥128/yr",
    description: "Multiple real-traffic node plans up to 5 Gbps, covering HK, JP, TW, KR, SG, US, UK, DE, FR and more — ideal for streaming, AI tools and everyday cross-region access.",
    highlights: ["Real-traffic plans", "Up to 5 Gbps", "Fully encrypted, no logs"],
    plans: [
      ["Basic", "¥128/yr", "50 GB/mo real traffic"],
      ["Premium", "¥198/yr", "100 GB/mo real traffic"],
      ["Deluxe", "¥398/yr", "200 GB/mo real traffic"],
      ["Unlimited", "¥698/yr", "Unlimited traffic"],
      ["¥5 / 10 GB trial", "¥5/once", "10 GB trial traffic"],
    ],
    faq: [
      ["Can I test a node", "Yes — the ¥5 / 10 GB plan is available for testing"],
      ["How to use the service", "On iPhone/iPad install Shadowrocket; on Android install Clash Meta; on Windows/Mac install Clash Verge (or another mainstream proxy client), then import our subscription link to start"],
      ["Which clients are supported", "Common subscription tools are supported; the subscription link and instructions are provided once the order completes"],
    ],
  },
};

export function localizeService(service, locale) {
  if (!service || locale !== "en") return service;
  const en = SERVICE_EN[service.slug];
  return en ? { ...service, ...en } : service;
}

export const SERVICE_ALIASES = {
  spotify: "spotify",
  netflix: "netflix",
  disney: "disney",
  "hbo-max": "hbo-max",
  max: "hbo-max",
  hbomax: "hbo-max",
  rocket: "airport-node",
  "airport-node": "airport-node",
};

export const SERVICE_SLUG_BY_KEY = SERVICE_PAGES.reduce((acc, item) => {
  acc[item.key] = item.slug;
  return acc;
}, {});

export function getServiceBySlug(slug) {
  const canonical = SERVICE_ALIASES[String(slug || "").toLowerCase()] || "";
  return SERVICE_PAGES.find((item) => item.slug === canonical) || null;
}
