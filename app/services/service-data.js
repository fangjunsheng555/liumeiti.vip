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
      ["是否需要登录购买测试套餐", "5元10GB测试套餐可直接下单购买"],
      ["支持哪些客户端", "支持常见订阅工具，订单完成后会提供订阅链接与使用说明"],
    ],
  },
];

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
