// SEO 长尾教程页数据(中英双语)。每篇针对一个高频搜索意图,内链到对应服务页。
// 文案保持简洁专业、步骤清晰,不啰嗦。新增服务时可加一篇。

export const GUIDES = [
  {
    slug: "how-to-buy-spotify-premium",
    service: "spotify",
    updated: "2026-07",
    title: "如何购买 Spotify 高价区会员(个人/家庭/双人)",
    titleEn: "How to Buy Spotify Premium (Individual / Duo / Family)",
    desc: "Spotify 高价区会员怎么买、家庭成员和个人订阅怎么选、开通要多久、能不能用自己账号——一篇讲清楚。",
    descEn: "How to buy Spotify Premium on a premium region, choosing between Family member, Individual and Duo, delivery time and whether you can use your own account.",
    intro: "Spotify 高价区订阅音质更稳、歌单与 AI DJ 全开,价格也更划算。下面按「选规格 → 下单 → 开通」三步说明,并解答账号归属、时长、售后等常见疑问。",
    introEn: "Premium-region Spotify plans give you the full catalog, AI DJ and stable playback at a better price. Below is a simple pick-a-plan → order → activation walkthrough, plus answers on account ownership, duration and after-sales.",
    steps: [
      ["选择规格", "家庭成员(性价比,适合单人长期听)、个人订阅(独立账号边界清晰)、双人/家庭(可邀请他人共享)。不确定就先选家庭成员。"],
      ["下单填信息", "在服务页点『立即选购』,填写联系邮箱与联系方式,支付宝或 USDT(9 折)付款。"],
      ["等待开通", "付款后工作人员核对到账即开通,通常很快。开通信息与订单确认会发送到你填写的邮箱。"],
      ["登录使用", "按开通说明登录 Spotify 即可,手机/桌面/网页端都支持。"],
    ],
    stepsEn: [
      ["Pick a plan", "Family member (best value for one long-term listener), Individual (your own private account), or Duo/Family (invite others). Unsure? Start with Family member."],
      ["Place the order", "On the service page tap 'Order now', enter your email and contact, and pay by Alipay or USDT (10% off)."],
      ["Wait for activation", "We activate once payment is confirmed — usually fast. Activation details and the order confirmation are emailed to you."],
      ["Log in", "Sign in to Spotify following the activation note — mobile, desktop and web all work."],
    ],
    faq: [
      ["能用我自己的账号吗?", "个人订阅可独立使用;家庭/车位类为共享计划,按开通说明操作即可。"],
      ["开通要多久?", "付款到账后即处理,通常很快,不用长时间等待。"],
      ["出问题怎么办?", "订单完成后可在服务中心凭订单号查询,也可通过在线客服继续沟通。"],
    ],
    faqEn: [
      ["Can I use my own account?", "Individual plans are used privately; family/seat plans are shared — just follow the activation note."],
      ["How long does activation take?", "We process right after payment is confirmed — usually quick."],
      ["What if something goes wrong?", "Look up your order by ID in the Service Center, or reach our online support."],
    ],
  },
  {
    slug: "how-to-pay-overseas-websites",
    service: "proxy-payment",
    updated: "2026-07",
    title: "海外网站/平台无法付款?全球代付怎么用",
    titleEn: "Can't Pay an Overseas Website? How Proxy Payment Works",
    desc: "境外网站只收海外卡、支付一直失败怎么办。全球代付支持海外购物、订酒店机票、充值话费、虚拟会员等,人工核价后付款,中国大陆网站除外。",
    descEn: "When an overseas site only takes foreign cards and your payment keeps failing, proxy payment covers overseas shopping, hotels/flights, top-ups and memberships — quoted manually, mainland China sites excluded.",
    intro: "很多海外网站只接受境外银行卡或本地支付方式,国内卡刷不过。全球代付由工作人员代为完成付款:你提交链接与标价,人工核价后通过邮件发来专属付款链接,确认金额再付款。",
    introEn: "Many overseas sites only accept foreign cards or local methods that mainland cards can't use. With proxy payment our team pays on your behalf: submit the link and listed price, we review and email a secure payment link, and you pay only after confirming the amount.",
    steps: [
      ["提交需求", "在全球代付页点『立即申请』,填写邮箱、网站/平台链接、商品标价、联系方式(均必填),需要说明的写在备注。"],
      ["等待人工报价", "工作人员核验平台与商品后,把报价通过邮件发送到你填写的邮箱。"],
      ["确认并付款", "邮件里有专属付款链接,核对金额后用支付宝或 USDT(9 折)付款,链接 7 天内有效。"],
      ["处理与查询", "付款后订单转为『已收到』,工作人员开始处理;可在服务中心凭订单号查询进度。"],
    ],
    stepsEn: [
      ["Submit a request", "On the Proxy Pay page tap 'Apply now' and fill in email, website/platform link, listed price and contact (all required). Add notes if needed."],
      ["Wait for a quote", "Our team verifies the platform and item, then emails the quote to you."],
      ["Confirm and pay", "The email has a secure payment link — confirm the amount and pay by Alipay or USDT (10% off). The link is valid for 7 days."],
      ["Processing & tracking", "After payment the order becomes 'Received' and we start processing. Track it by order ID in the Service Center."],
    ],
    faq: [
      ["支持哪些场景?", "海外网购服装日用、订酒店机票、充值话费、虚拟物品与会员等支持在线支付的场景大多可代付。"],
      ["中国大陆网站可以吗?", "中国大陆网站暂不支持。"],
      ["需要先付款吗?", "不需要。人工核价、你确认报价后才付款。"],
    ],
    faqEn: [
      ["What scenarios are supported?", "Most online-payable cases: overseas shopping, hotels/flights, phone top-ups, digital goods and memberships."],
      ["Are mainland China sites supported?", "Mainland China websites are not supported."],
      ["Do I pay upfront?", "No. We quote manually and you pay only after confirming the amount."],
    ],
  },
  {
    slug: "netflix-4k-seat-vs-full-account",
    service: "netflix",
    updated: "2026-07",
    title: "Netflix 车位和整号怎么选?4K 会员购买指南",
    titleEn: "Netflix 4K Seat vs Full Account — Which to Buy",
    desc: "Netflix 4K 会员车位是什么、和整号有什么区别、哪个更适合我——按使用场景选。",
    descEn: "What a Netflix 4K seat is, how it differs from a full account, and which fits your use case.",
    intro: "Netflix 4K 会员有两种买法:『车位』是共享一个高级账号里的独立用户档案,一人一位互不干扰、更便宜;『整号』是整个账号归你,适合家庭或多人长期使用。",
    introEn: "There are two ways to buy Netflix 4K: a 'seat' is your own profile on a shared premium account — private and cheaper; a 'full account' is the whole account, ideal for families or long-term multi-user use.",
    steps: [
      ["按场景选规格", "单人观看选车位更划算;家庭/多人或想完全掌控账号选整号。"],
      ["下单付款", "服务页选好规格,填联系方式,支付宝或 USDT(9 折)付款。"],
      ["等待开通并登录", "到账后开通,信息发到邮箱,按说明登录即可,支持手机/平板/电视/网页。"],
    ],
    stepsEn: [
      ["Choose by use case", "Watching solo? A seat is cheaper. Family/multi-user or want full control? Pick a full account."],
      ["Order and pay", "Choose the plan on the service page, add your contact, pay by Alipay or USDT (10% off)."],
      ["Activate and log in", "We activate after payment and email the details — sign in on mobile, tablet, TV or web."],
    ],
    faq: [
      ["车位安全吗?", "车位是账号内独立用户档案,一人一位,互不干扰。"],
      ["能看 4K 吗?", "提供最高级别 4K 套餐,设备与网络支持即可观看。"],
      ["售后怎么处理?", "凭订单号在服务中心查询,或联系在线客服。"],
    ],
    faqEn: [
      ["Is a seat safe?", "A seat is your own profile on the account — one person per seat, no interference."],
      ["Can I watch in 4K?", "Top-tier 4K plans are provided; you'll get 4K if your device and network support it."],
      ["After-sales?", "Look up your order by ID in the Service Center, or contact support."],
    ],
  },
  {
    slug: "how-to-get-chatgpt-claude-membership",
    service: "ai",
    updated: "2026-07",
    title: "ChatGPT Plus / Claude Pro 怎么开通(官方会员)",
    titleEn: "How to Get ChatGPT Plus & Claude Pro (Official)",
    desc: "国内怎么开通 ChatGPT Plus、Claude Pro,官方渠道充值、独立账号、更高额度套餐怎么选。",
    descEn: "How to get ChatGPT Plus and Claude Pro via official channels, with independent accounts and higher-quota plans explained.",
    intro: "AI 会员提供 ChatGPT 与 Claude 官方会员,官方渠道直充、独立账号。除基础 Plus/Pro 外,还有 5x、20x 高额度套餐,适合重度使用。",
    introEn: "Our AI membership covers official ChatGPT and Claude plans via official channels with independent accounts. Beyond base Plus/Pro, there are 5x and 20x high-quota plans for heavy users.",
    steps: [
      ["选择套餐", "GPT Plus / Claude Pro 为基础版;需要更高额度选 5x / 20x Pro/Max。"],
      ["下单付款", "服务页选套餐,填邮箱与联系方式,支付宝或 USDT(9 折)付款。"],
      ["等待开通", "官方渠道处理,到账后开通,账号信息发到你的邮箱。"],
    ],
    stepsEn: [
      ["Pick a plan", "GPT Plus / Claude Pro are the base tiers; need more quota? Choose 5x / 20x Pro/Max."],
      ["Order and pay", "Select the plan, enter email and contact, pay by Alipay or USDT (10% off)."],
      ["Wait for activation", "Handled via official channels; account details are emailed after payment."],
    ],
    faq: [
      ["是官方会员吗?", "官方渠道充值,独立账号。"],
      ["额度不够怎么办?", "可选 5x / 20x 高额度套餐。"],
      ["能包售后吗?", "订单完成后可在服务中心查询,售后由客服跟进。"],
    ],
    faqEn: [
      ["Are these official?", "Topped up via official channels, with independent accounts."],
      ["Not enough quota?", "Choose the 5x / 20x high-quota plans."],
      ["Is after-sales included?", "Track your order in the Service Center; support follows up."],
    ],
  },
  {
    slug: "how-to-use-vpn-node",
    service: "airport-node",
    updated: "2026-07",
    title: "机场节点怎么用?订阅链接导入教程(小火箭/Clash)",
    titleEn: "How to Use a VPN Node — Import Your Subscription (Shadowrocket / Clash)",
    desc: "机场节点订阅链接怎么导入,iPhone 小火箭、安卓 Clash、电脑 Clash Verge 怎么配置,套餐怎么选。",
    descEn: "How to import a node subscription in Shadowrocket (iPhone), Clash (Android) and Clash Verge (desktop), and how to pick a plan.",
    intro: "机场节点提供多线路真实流量套餐,解锁流媒体、AI 工具与社交软件。下单后会拿到一条订阅链接,导入客户端即可使用。",
    introEn: "Our nodes offer multi-line, real-traffic plans that unlock streaming, AI tools and social apps. After ordering you'll get a subscription link to import into a client.",
    steps: [
      ["选择套餐", "普通/高级/豪华/无限按流量与带宽区分;不确定可先买 5 元 10GB 测试套餐测速。"],
      ["下单付款", "服务页选套餐,填用户名与联系方式,支付宝或 USDT(9 折)付款。"],
      ["导入订阅", "iPhone 用 Shadowrocket 小火箭、安卓用 Clash Meta、电脑用 Clash Verge,粘贴订阅链接导入。"],
      ["选节点使用", "在客户端选择合适节点连接即可;订单里附有订阅链接与使用说明。"],
    ],
    stepsEn: [
      ["Choose a plan", "Basic/Pro/Deluxe/Unlimited differ by traffic and bandwidth; unsure? Try the ¥5 / 10GB test plan first."],
      ["Order and pay", "Pick a plan, enter a username and contact, pay by Alipay or USDT (10% off)."],
      ["Import the subscription", "iPhone: Shadowrocket; Android: Clash Meta; desktop: Clash Verge — paste the subscription link to import."],
      ["Pick a node", "Select a suitable node in the client and connect; the order includes the link and instructions."],
    ],
    faq: [
      ["能先测试吗?", "有 5 元 10GB 测试套餐,先测速再决定。"],
      ["支持哪些客户端?", "支持主流订阅工具,订单完成后提供订阅链接与说明。"],
      ["能解锁流媒体吗?", "多线路覆盖,可解锁主流流媒体与 AI 工具。"],
    ],
    faqEn: [
      ["Can I test first?", "Yes — a ¥5 / 10GB test plan lets you check speed first."],
      ["Which clients work?", "Common subscription tools; the order includes the link and instructions."],
      ["Does it unlock streaming?", "Multi-line coverage unlocks major streaming and AI tools."],
    ],
  },
];

export function getGuide(slug) {
  return GUIDES.find((g) => g.slug === slug) || null;
}

export function localizeGuide(g, locale) {
  if (locale !== "en") return g;
  return {
    ...g,
    title: g.titleEn, desc: g.descEn, intro: g.introEn,
    steps: g.stepsEn, faq: g.faqEn,
  };
}
