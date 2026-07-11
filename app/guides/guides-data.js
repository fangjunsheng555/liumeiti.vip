// Bilingual purchase and usage guides. Copy must follow the actual catalog,
// checkout fields and fulfilment flow; avoid hard-coded prices that can change
// in the admin catalog.

export const GUIDES = [
  {
    slug: "how-to-buy-spotify-premium",
    service: "spotify",
    updated: "2026-07-11",
    title: "Spotify 高价区会员购买指南：家庭成员、个人、双人和家庭套餐怎么选",
    titleEn: "Spotify Premium Buying Guide: Family Member, Individual, Duo or Family",
    desc: "按本站实际在售规格说明 Spotify 家庭成员、个人订阅、双人订阅与家庭套餐的区别，以及账号填写和开通流程。",
    descEn: "A practical guide to our Spotify Family Member, Individual, Duo and Family plans, including account requirements and activation.",
    intro: "本站提供四种 Spotify 高价区 Premium 规格。所有规格均可使用客户自己的 Spotify 账号；如需由我们提供账号，请在下单前联系确认。",
    introEn: "We offer four premium-region Spotify Premium plans. Every plan can be activated on your existing Spotify account. If you need us to supply an account, contact support before ordering.",
    steps: [
      ["选择合适规格", "家庭成员性价比最高，使用体验与个人订阅无异，建议单人用户优先选择。个人订阅价格较高，一般不建议；双人或家庭套餐适合邀请他人共享。"],
      ["准备开通账号", "使用自有账号时，填写需要开通的 Spotify 账号与密码。如需由我们提供账号，请先联系确认填写方式。"],
      ["提交并核对订单", "填写接收通知的邮箱和有效联系方式，确认所选规格及应付金额后，按结算页提示完成付款。"],
      ["完成开通", "工作人员核对订单后按所选规格处理。家庭成员会加入家庭计划；双人和家庭套餐按开通说明完成成员邀请。"],
    ],
    stepsEn: [
      ["Choose the right plan", "Family Member offers the best value and the same day-to-day Premium experience as Individual, so it is our recommendation for one listener. Individual is a higher-priced standalone plan; Duo and Family are for inviting other users."],
      ["Prepare the account", "For your own account, enter the Spotify login and password to be activated. If you need an account supplied, contact us first for the correct ordering instructions."],
      ["Review and place the order", "Enter a delivery email and valid contact, confirm the plan and payable amount, then follow the checkout instructions."],
      ["Complete activation", "After the order is checked, we fulfil the selected plan. Family Member is added to a family plan; Duo and Family follow the supplied member-invitation instructions."],
    ],
    faq: [
      ["家庭成员和个人订阅有什么区别？", "日常 Premium 使用体验无异。家庭成员性价比更高；个人订阅是独立订阅，但价格较高。"],
      ["可以使用自己的 Spotify 账号吗？", "可以，四种规格均支持自有账号。如需我们提供账号，请在下单前联系确认。"],
      ["单人用户推荐哪种规格？", "建议优先选择家庭成员；只有明确需要独立订阅时再考虑个人订阅。"],
    ],
    faqEn: [
      ["How do Family Member and Individual differ?", "The everyday Premium experience is the same. Family Member is better value; Individual is a standalone subscription at a higher price."],
      ["Can I use my own Spotify account?", "Yes. All four plans support an existing account. Contact us before ordering if you need an account supplied."],
      ["Which plan is best for one listener?", "We recommend Family Member. Choose Individual only when a standalone subscription is specifically required."],
    ],
  },
  {
    slug: "how-to-pay-overseas-websites",
    service: "proxy-payment",
    updated: "2026-07-11",
    title: "全球代付使用指南：海外网站与平台如何提交代付",
    titleEn: "Global Proxy Payment Guide for Overseas Websites and Platforms",
    desc: "说明全球代付的适用范围、四项必填资料、人工报价、邮件付款和订单查询流程。中国大陆网站除外。",
    descEn: "How to submit an overseas payment request, receive a manual quote, pay through the emailed link and track the order. Mainland China websites are excluded.",
    intro: "全球代付适用于支持在线结算的海外网站与平台。提交需求时无需付款；工作人员确认平台和商品可代付后发送报价，客户确认金额再付款。中国大陆网站暂不支持。",
    introEn: "Global Proxy Payment covers overseas websites and platforms with online checkout. There is no charge when you submit a request. We first verify the platform and item, then email a quote for your approval. Mainland China websites are not supported.",
    steps: [
      ["提交四项必填资料", "填写接收报价的邮箱、网站链接或平台、商品标价和联系方式；特殊要求可写在备注。"],
      ["等待人工核价", "工作人员核验平台、商品、币种与可付款条件。确认可处理后，订单进入待付款并向填写的邮箱发送报价。"],
      ["通过专属链接付款", "打开邮件中的付款链接，核对报价和订单号后选择页面提供的支付方式。付款链接有效期为 7 天，请勿转发。"],
      ["查询处理进度", "付款提交后订单显示为已收到，工作人员继续处理代付；可在服务中心凭订单号查询。"],
    ],
    stepsEn: [
      ["Submit four required details", "Provide the email for the quote, website or platform link, listed price and contact details. Add any special requirement in Notes."],
      ["Wait for manual review", "We verify the platform, item, currency and payment conditions. Once accepted, the order moves to Awaiting Payment and the quote is emailed."],
      ["Pay through your private link", "Open the emailed payment link, verify the quote and order ID, then choose an available payment method. The link is valid for seven days and should not be shared."],
      ["Track fulfilment", "After payment is submitted, the order is marked Received and processing begins. Track it by order ID in the Service Center."],
    ],
    faq: [
      ["支持哪些代付场景？", "支持大多数可在线结算的海外网购、数字订阅、酒店机票、话费充值及其他海外平台订单，最终以人工审核为准。"],
      ["提交申请时需要付款吗？", "不需要。确认可代付并收到报价后，再通过邮件中的专属链接付款。"],
      ["中国大陆网站可以代付吗？", "暂不支持中国大陆网站与平台。"],
    ],
    faqEn: [
      ["What can be paid?", "Most overseas online purchases, digital subscriptions, hotels and flights, mobile top-ups and other online platform orders are eligible, subject to manual review."],
      ["Do I pay when submitting?", "No. Pay only after the request is accepted and the quote arrives by email."],
      ["Are mainland China websites supported?", "No. Mainland China websites and platforms are currently excluded."],
    ],
  },
  {
    slug: "netflix-4k-seat-vs-full-account",
    service: "netflix",
    updated: "2026-07-11",
    title: "Netflix 4K 会员购买指南：单独车位与整号怎么选",
    titleEn: "Netflix 4K Buying Guide: Dedicated Profile or Full Account",
    desc: "说明 Netflix 4K 杜比单独车位和整号的账号归属、档案数量、适用场景与交付方式。",
    descEn: "How our Netflix 4K Dolby dedicated-profile and full-account plans differ in access, profile count, use case and delivery.",
    intro: "本站提供 Netflix 最高级别 4K 杜比套餐。单独车位是由我们提供的共享账号中的独立用户档案，可设置 PIN；整号为完整账号，最多可建立 5 个用户档案。",
    introEn: "We provide Netflix's top 4K Dolby tier. A Dedicated Profile is your own PIN-lockable profile on an account we supply. A Full Account gives you the complete account with up to five profiles.",
    steps: [
      ["按使用人数选择", "单人长期观看选择单独车位更划算；家庭、多用户或需要完整账号管理权时选择整号。"],
      ["提交订单", "选择规格，填写接收交付信息的邮箱；联系方式与备注可按实际需要填写。"],
      ["接收登录资料", "工作人员核对订单后提供账号、对应车位或整号信息及使用说明。"],
      ["登录并检查播放条件", "在 Netflix 官方应用或网页端登录。4K 与杜比效果取决于片源、设备、套餐支持和网络条件。"],
    ],
    stepsEn: [
      ["Choose by number of viewers", "A Dedicated Profile is the better-value option for one viewer. Choose a Full Account for a household, multiple users or full account control."],
      ["Place the order", "Select the plan and provide the email that should receive delivery details. Contact and notes can be added when needed."],
      ["Receive access details", "After checking the order, we provide the account, assigned profile or full-account details, and usage instructions."],
      ["Sign in and check playback requirements", "Use the official Netflix app or website. 4K and Dolby availability depends on the title, device, plan support and network conditions."],
    ],
    faq: [
      ["单独车位是独立账号吗？", "不是。车位是共享账号内分配给一位用户的独立档案，可设置 PIN，观看记录与其他档案分开。"],
      ["整号可以建立几个档案？", "当前整号规格最多支持 5 个用户档案。"],
      ["是否需要提供自己的 Netflix 账号？", "不需要，登录资料由我们按所选规格提供。"],
    ],
    faqEn: [
      ["Is a Dedicated Profile a separate account?", "No. It is an assigned profile on a shared account. It can be PIN-locked and keeps viewing history separate from other profiles."],
      ["How many profiles does a Full Account support?", "The current Full Account plan supports up to five profiles."],
      ["Do I provide my own Netflix account?", "No. We supply the access details for the plan you order."],
    ],
  },
  {
    slug: "how-to-get-chatgpt-claude-membership",
    service: "ai",
    updated: "2026-07-11",
    title: "AI 会员购买指南：ChatGPT 与 Claude 套餐怎么选",
    titleEn: "AI Membership Buying Guide: Choosing a ChatGPT or Claude Plan",
    desc: "按本站实际在售的 ChatGPT、Claude 三个月会员规格，说明基础套餐与 5x、20x 高额度套餐的选择及交付流程。",
    descEn: "A guide to our three-month ChatGPT and Claude plans, including standard, 5x and 20x higher-limit options and the fulfilment process.",
    intro: "AI 会员分为 ChatGPT 与 Claude 两个平台，均提供基础规格及 5x、20x 高额度规格，周期为三个月。商品按独立、非共享账号交付，价格以服务页和结算页实时显示为准。",
    introEn: "AI Membership covers ChatGPT and Claude. Each platform has a standard plan plus 5x and 20x higher-limit options, all for three months. Delivery uses a private, non-shared account; current pricing is shown on the service and checkout pages.",
    steps: [
      ["先选择平台", "根据日常使用的模型与工作流选择 ChatGPT 或 Claude，不建议仅凭套餐名称跨平台比较。"],
      ["再选择额度", "一般使用选择基础规格；连续高强度使用或明确需要更高额度时，再选择 5x 或 20x 规格。"],
      ["提交订单", "选择具体规格并填写接收订单与交付通知的邮箱，核对实时价格后完成付款。"],
      ["配合完成开通", "工作人员按订单规格联系并完成开通，交付信息通过订单记录和邮件同步。"],
    ],
    stepsEn: [
      ["Choose the platform first", "Select ChatGPT or Claude based on the models and workflow you actually use. Do not compare tiers across platforms by name alone."],
      ["Choose the required limit", "The standard plan suits regular use. Select a 5x or 20x option only for sustained heavy use or a defined higher-limit requirement."],
      ["Place the order", "Choose the exact plan, enter the email for order and delivery notices, review the live price and complete checkout."],
      ["Complete activation", "Our team follows the selected order plan, contacts you as needed and records delivery through the order and email notifications."],
    ],
    faq: [
      ["这些是共享账号吗？", "不是，AI 会员按独立、非共享账号交付。"],
      ["结算页为什么没有填写平台账号密码？", "该服务不要求在结算页提交平台密码，工作人员会按订单通知完成后续开通与交付。"],
      ["基础、5x 和 20x 怎么选？", "没有持续高额度需求时选择基础规格；5x、20x 适合明确需要更高使用额度的用户。"],
    ],
    faqEn: [
      ["Are these shared accounts?", "No. AI Membership is delivered through a private, non-shared account."],
      ["Why does checkout not ask for the platform password?", "This service does not require a platform password at checkout. Our team handles the remaining activation and delivery through the order workflow."],
      ["Standard, 5x or 20x?", "Choose the standard plan unless you have a sustained higher-limit requirement. The 5x and 20x options are for heavier use."],
    ],
  },
  {
    slug: "how-to-use-vpn-node",
    service: "airport-node",
    updated: "2026-07-11",
    title: "机场节点购买与导入指南：Shadowrocket、Clash Meta、Clash Verge",
    titleEn: "VPN Node Buying and Import Guide: Shadowrocket, Clash Meta and Clash Verge",
    desc: "说明 50GB、100GB、200GB、无限流量与 10GB 测试规格，并介绍主流客户端的订阅链接导入流程。",
    descEn: "How to choose among 50 GB, 100 GB, 200 GB, Unlimited and 10 GB Trial plans, then import the subscription into common clients.",
    intro: "机场节点按月流量提供普通、高级、豪华和无限四档年付规格，另有 10GB 测试规格。订单完成后会生成订阅链接，将链接导入兼容客户端即可使用。",
    introEn: "VPN nodes are offered as annual Standard, Plus, Premium and Unlimited plans, plus a 10 GB Trial. Once the order is completed, import the supplied subscription URL into a compatible client.",
    steps: [
      ["按月流量选择规格", "普通为 50GB/月，高级为 100GB/月，豪华为 200GB/月，无限规格不设月流量上限；首次使用可先选 10GB 测试。"],
      ["提交订单", "选择规格并填写接收订单通知的邮箱，核对应付金额后按结算页提示完成付款。"],
      ["复制订阅链接", "订单提交后可在完成页、订单详情或通知邮件中查看订阅链接，请完整复制，不要遗漏字符。"],
      ["导入客户端", "iPhone/iPad 可用 Shadowrocket，Android 可用 Clash Meta，Windows/macOS 可用 Clash Verge；在客户端新增订阅并粘贴链接。"],
    ],
    stepsEn: [
      ["Choose by monthly traffic", "Standard includes 50 GB/month, Plus 100 GB/month, Premium 200 GB/month, and Unlimited has no monthly traffic cap. New users can start with the 10 GB Trial."],
      ["Place the order", "Select the plan, enter the email for order notices, review the payable amount and follow the checkout instructions."],
      ["Copy the subscription URL", "After submitting the order, find the URL on the completion page, in order details or in the notification email. Copy it in full."],
      ["Import into a client", "Use Shadowrocket on iPhone/iPad, Clash Meta on Android, or Clash Verge on Windows/macOS. Add a subscription and paste the URL."],
    ],
    faq: [
      ["首次购买建议哪种规格？", "不确定线路适配时可先选 10GB 测试；确认使用稳定后，再按每月流量选择年付规格。"],
      ["订阅链接在哪里查看？", "可在订单完成页、订单详情和订单通知邮件中查看。"],
      ["导入后没有节点怎么办？", "先确认链接复制完整并在客户端更新订阅；仍无法加载时，凭订单号联系在线客服。"],
    ],
    faqEn: [
      ["Which plan should a first-time buyer choose?", "Start with the 10 GB Trial if compatibility is uncertain. Move to an annual plan after confirming the connection works for you."],
      ["Where is the subscription URL?", "It is available on the order completion page, in order details and in the order notification email."],
      ["What if no nodes appear after import?", "Check that the full URL was copied and refresh the subscription in the client. If it still fails, contact support with the order ID."],
    ],
  },
  {
    slug: "disney-plus-seat-vs-full-account",
    service: "disney",
    updated: "2026-07-11",
    title: "Disney+ 4K 会员购买指南：单独车位与整号怎么选",
    titleEn: "Disney+ 4K Buying Guide: Dedicated Profile or Full Account",
    desc: "说明 Disney+ 4K 杜比单独车位和整号的区别、最多 7 个档案的使用方式及交付流程。",
    descEn: "How our Disney+ 4K Dolby dedicated-profile and full-account plans differ, including profile capacity and delivery.",
    intro: "本站提供 Disney+ 最高级别 4K 杜比套餐。单独车位是由我们提供的账号中的独立用户档案；整号为完整账号，最多可建立 7 个用户档案。",
    introEn: "We provide Disney+'s top 4K Dolby tier. A Dedicated Profile is an assigned profile on an account we supply. A Full Account gives you the complete account with up to seven profiles.",
    steps: [
      ["选择车位或整号", "单人观看优先选择单独车位；家庭、多用户或需要自行管理全部档案时选择整号。"],
      ["填写接收邮箱", "选择规格后填写用于接收订单和交付信息的邮箱，确认金额并完成结算。"],
      ["接收登录资料", "工作人员核对订单后提供账号、对应档案或整号信息及登录说明。"],
      ["在官方客户端登录", "使用 Disney+ 官方应用或网页端登录。4K 与杜比效果取决于内容、设备和网络条件。"],
    ],
    stepsEn: [
      ["Choose a profile or full account", "A Dedicated Profile is the preferred option for one viewer. Choose a Full Account for a household, multiple users or full profile management."],
      ["Enter the delivery email", "Select the plan, provide the email for order and access details, review the amount and complete checkout."],
      ["Receive access details", "After checking the order, we provide the account, assigned profile or full-account details and sign-in instructions."],
      ["Use the official client", "Sign in through the official Disney+ app or website. 4K and Dolby availability depends on the content, device and network conditions."],
    ],
    faq: [
      ["单独车位会与他人共用观看记录吗？", "不会。每个车位使用独立用户档案，观看记录与推荐内容分别保存。"],
      ["整号最多支持几个档案？", "当前整号规格最多支持 7 个用户档案。"],
      ["是否需要提供自己的 Disney+ 账号？", "不需要，登录资料由我们按所选规格提供。"],
    ],
    faqEn: [
      ["Does a Dedicated Profile share watch history?", "No. Each assigned profile keeps its own watch history and recommendations."],
      ["How many profiles does a Full Account support?", "The current Full Account plan supports up to seven profiles."],
      ["Do I provide my own Disney+ account?", "No. We supply the access details for the selected plan."],
    ],
  },
  {
    slug: "hbo-max-seat-vs-full-account",
    service: "hbo-max",
    updated: "2026-07-11",
    title: "HBO Max 4K 会员购买指南：单独车位与整号怎么选",
    titleEn: "HBO Max 4K Buying Guide: Dedicated Profile or Full Account",
    desc: "说明 HBO Max 4K 杜比单独车位和整号的区别、最多 5 个档案的使用方式及交付流程。",
    descEn: "How our HBO Max 4K Dolby dedicated-profile and full-account plans differ, including profile capacity and delivery.",
    intro: "本站提供 HBO Max 最高级别 4K 杜比套餐。单独车位是由我们提供的账号中的独立用户档案；整号为完整账号，最多可建立 5 个用户档案。",
    introEn: "We provide HBO Max's top 4K Dolby tier. A Dedicated Profile is an assigned profile on an account we supply. A Full Account gives you the complete account with up to five profiles.",
    steps: [
      ["选择车位或整号", "单人观看选择单独车位更合适；家庭、多用户或需要完整账号管理权时选择整号。"],
      ["填写接收邮箱", "选择规格后填写用于接收订单和交付信息的邮箱，确认金额并完成结算。"],
      ["接收登录资料", "工作人员核对订单后提供账号、对应档案或整号信息及登录说明。"],
      ["在官方客户端登录", "使用 HBO Max 官方应用或网页端登录。4K 与杜比效果取决于内容、设备和网络条件。"],
    ],
    stepsEn: [
      ["Choose a profile or full account", "A Dedicated Profile is the better fit for one viewer. Choose a Full Account for a household, multiple users or full account control."],
      ["Enter the delivery email", "Select the plan, provide the email for order and access details, review the amount and complete checkout."],
      ["Receive access details", "After checking the order, we provide the account, assigned profile or full-account details and sign-in instructions."],
      ["Use the official client", "Sign in through the official HBO Max app or website. 4K and Dolby availability depends on the content, device and network conditions."],
    ],
    faq: [
      ["单独车位是独立账号吗？", "不是。车位是共享账号内分配给一位用户的独立档案，观看记录与其他档案分开。"],
      ["整号最多支持几个档案？", "当前整号规格最多支持 5 个用户档案。"],
      ["是否需要提供自己的 HBO Max 账号？", "不需要，登录资料由我们按所选规格提供。"],
    ],
    faqEn: [
      ["Is a Dedicated Profile a separate account?", "No. It is an assigned profile on a shared account, with viewing history kept separate from other profiles."],
      ["How many profiles does a Full Account support?", "The current Full Account plan supports up to five profiles."],
      ["Do I provide my own HBO Max account?", "No. We supply the access details for the selected plan."],
    ],
  },
];

export function getGuide(slug) {
  return GUIDES.find((guide) => guide.slug === slug) || null;
}

export function localizeGuide(guide, locale) {
  if (locale !== "en") return guide;
  return {
    ...guide,
    title: guide.titleEn,
    desc: guide.descEn,
    intro: guide.introEn,
    steps: guide.stepsEn,
    faq: guide.faqEn,
  };
}
