// 商品目录「唯一权威默认值」(pure data, 无 React/无 redis, 可被前后端任意引用)。
// 价格(amount)是结账实收的权威来源;后台覆盖层(lm:catalog:overrides)在此之上合并。
// 改这里 = 改默认;站主在后台改 = 写覆盖,前端/结账读合并后的值。
//
// 字段:
//   key/slug 商品标识 · title/subtitle 名称副标题 · image 图 · cycle 默认周期
//   priceText 列表展示价(如「¥128/年起」) · shortIntro 短简介 · highlights 卖点
//   active 上下架 · sort 排序(小在前)
//   plans[] 规格:{ id, label, amount(权威实收价), cycle, desc }
//   defaultPlan 默认选中规格 id
//   flags: needsAccountPassword / needsContact(下单表单用,沿用 order 路由原逻辑)

export const CATALOG_DEFAULTS = [
  {
    key: "spotify", slug: "spotify", title: "Spotify", subtitle: "欧美日高价区多规格订阅",
    image: "/products/spotify.jpg", cycle: "1年", priceText: "¥128/年起", active: true, sort: 10,
    shortIntro: "欧美日高价区订阅，家庭成员、个人、双人与家庭套餐可选",
    highlights: ["高价区订阅", "多规格可选", "售后保障"],
    needsAccountPassword: true, needsContact: true,
    defaultPlan: "member",
    plans: [
      { id: "member", label: "家庭成员", amount: 128, cycle: "1年", desc: "加入高价区家庭计划，适合单人长期听歌" },
      { id: "individual", label: "个人订阅", amount: 388, cycle: "1年", desc: "独立订阅，账号使用边界更清晰" },
      { id: "duo", label: "双人订阅", amount: 488, cycle: "1年", desc: "可邀请 1 个账号免费享用订阅" },
      { id: "family", label: "家庭套餐", amount: 588, cycle: "1年", desc: "可邀请 5 个账号免费享用订阅" },
    ],
  },
  {
    key: "ai", slug: "ai", title: "AI 会员", subtitle: "ChatGPT / Claude 官方会员",
    image: "/products/ai.jpg", cycle: "三个月", priceText: "¥198/三个月起", active: true, sort: 20,
    shortIntro: "ChatGPT 与 Claude 官方会员，官方渠道直充，独立账号，包售后",
    highlights: ["官方充值", "独立账号", "包售后"],
    defaultPlan: "gpt-plus",
    plans: [
      { id: "gpt-plus", label: "GPT Plus", amount: 198, cycle: "三个月", desc: "ChatGPT Plus 官方会员，三个月" },
      { id: "gpt-pro", label: "GPT 5x Pro", amount: 998, cycle: "三个月", desc: "ChatGPT Pro 5x 高额度，三个月" },
      { id: "gpt-20x-pro", label: "GPT 20x Pro", amount: 1888, cycle: "三个月", desc: "ChatGPT Pro 20x 超大额度，三个月" },
      { id: "claude-pro", label: "Claude Pro", amount: 198, cycle: "三个月", desc: "Claude Pro 官方会员，三个月" },
      { id: "claude-max", label: "Claude 5x Max", amount: 998, cycle: "三个月", desc: "Claude Max 5x 高额度，三个月" },
      { id: "claude-20x-max", label: "Claude 20x Max", amount: 1888, cycle: "三个月", desc: "Claude Max 20x 超大额度，三个月" },
    ],
  },
  {
    key: "netflix", slug: "netflix", title: "Netflix", subtitle: "全球可用4K杜比车位/整号",
    image: "/products/netflix.jpg", cycle: "1年", priceText: "¥168/年起", active: true, sort: 30,
    shortIntro: "全球可用最高级别 4K 杜比套餐，单独车位或整号购买",
    highlights: ["4K 杜比", "车位/整号", "售后保障"],
    defaultPlan: "seat",
    plans: [
      { id: "seat", label: "单独车位", amount: 168, cycle: "1年", desc: "一人独享一个用户档案，可设置 PIN 锁，高峰不排队不被挤" },
      { id: "full", label: "整号购买", amount: 588, cycle: "1年", desc: "最多支持 5 个用户档案/车位，适合家庭或多人长期稳定使用" },
    ],
  },
  {
    key: "disney", slug: "disney", title: "Disney+", subtitle: "全球可用4K杜比车位/整号",
    image: "/products/disney.jpg", cycle: "1年", priceText: "¥108/年起", active: true, sort: 40,
    shortIntro: "全球可用最高级别 4K 杜比套餐，单独车位或整号购买",
    highlights: ["4K 杜比", "车位/整号", "售后保障"],
    defaultPlan: "seat",
    plans: [
      { id: "seat", label: "单独车位", amount: 108, cycle: "1年", desc: "一人一位置互不干扰" },
      { id: "full", label: "整号购买", amount: 588, cycle: "1年", desc: "最多支持 7 个用户档案/车位，适合家庭共享与长期使用" },
    ],
  },
  {
    key: "max", slug: "max", title: "HBO Max", subtitle: "全球可用4K杜比车位/整号",
    image: "/products/hbomax.jpg", cycle: "1年", priceText: "¥148/年起", active: true, sort: 50,
    shortIntro: "全球可用最高级别 4K 杜比套餐，单独车位或整号购买",
    highlights: ["4K 杜比", "车位/整号", "售后保障"],
    defaultPlan: "seat",
    plans: [
      { id: "seat", label: "单独车位", amount: 148, cycle: "1年", desc: "一人独享一个用户档案" },
      { id: "full", label: "整号购买", amount: 588, cycle: "1年", desc: "最多支持多个用户档案/车位，适合家庭或多人长期使用" },
    ],
  },
  {
    key: "rocket", slug: "rocket", title: "机场节点", subtitle: "稳定高速科学上网节点",
    image: "/products/rocket.jpg", cycle: "1年", priceText: "¥128/年起", active: true, sort: 60,
    shortIntro: "多套餐可选的稳定高速节点订阅，含 5 元测试套餐",
    highlights: ["稳定高速", "多套餐", "可先测试"],
    defaultPlan: "basic",
    plans: [
      { id: "basic", label: "普通套餐", amount: 128, cycle: "1年", desc: "日常浏览与流媒体，性价比之选" },
      { id: "pro", label: "高级套餐", amount: 198, cycle: "1年", desc: "更高带宽与更多节点" },
      { id: "luxury", label: "豪华套餐", amount: 398, cycle: "1年", desc: "大带宽、低延迟、优先线路" },
      { id: "unlimited", label: "无限套餐", amount: 698, cycle: "1年", desc: "无限流量，重度用户首选" },
      { id: "trial", label: "5元10GB测试", amount: 5, cycle: "次", desc: "5 元 10GB 体验，先测速再决定", requiresLogin: false, onePerUser: false },
    ],
  },
  {
    key: "proxy-pay", slug: "proxy-payment", title: "全球代付", subtitle: "海外网站与平台人工代付",
    image: "/products/proxy-pay.jpg", cycle: "人工报价", priceText: "3折起", active: true, sort: 70,
    shortIntro: "代付海外网站与平台，中国大陆网站除外",
    highlights: ["海外平台可用", "人工核价", "报价后付款"],
    quoteOnly: true,
    defaultPlan: "quote",
    plans: [
      { id: "quote", label: "人工报价", amount: 0, cycle: "按单", desc: "提交需求后核价，确认报价再付款" },
    ],
  },
];

// 便捷映射（按 key）
export function catalogByKey(list = CATALOG_DEFAULTS) {
  const map = {};
  for (const p of list) map[p.key] = p;
  return map;
}
