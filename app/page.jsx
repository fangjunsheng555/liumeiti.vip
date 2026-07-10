"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Clock,
  Headphones,
  Lock,
  Megaphone,
  ShieldCheck,
  ShoppingBag,
  TrendingUp,
  Users,
  Award,
  Zap,
  Star,
} from "lucide-react";
import MobileNav from "./components/MobileNav";
import RedeemCard from "./components/RedeemCard";
import FloatingSupport from "./components/FloatingSupport";
import { SERVICE_PAGES } from "./services/service-data";
import { useCatalogSync, getCatalogProducts, catalogOverrideLoaded, useSiteSettings } from "./lib/store";
import LanguageSwitcher from "./components/LanguageSwitcher";
import { useLocale } from "./components/LocaleProvider";
import { localizeMetric, localizeTime, serviceCardEn } from "./lib/i18n";

const OPERATION_SLOT_MINUTES = 10;
const OPERATION_SLOTS_PER_DAY = 24 * 60 / OPERATION_SLOT_MINUTES;
const OPERATION_INITIAL_METRICS = {
  processedToday: "968单",
  averageResponse: "1分钟内",
  queueCount: "8单",
  serviceYears: "近6年",
};

const HERO_STATS = [
  { metric: "processedToday", labelKey: "hero.metric.processed", icon: TrendingUp },
  { metric: "averageResponse", labelKey: "hero.metric.response", icon: Clock },
  { metric: "queueCount", labelKey: "hero.metric.queue", icon: Users },
  { metric: "serviceYears", labelKey: "hero.metric.years", icon: Award },
];

const TRUST_ITEMS = [
  { icon: ShieldCheck, tKey: "trust.stable.t", dKey: "trust.stable.d" },
  { icon: Users, tKey: "trust.team.t", dKey: "trust.team.d" },
  { icon: BadgeCheck, tKey: "trust.fast.t", dKey: "trust.fast.d" },
  { icon: Lock, tKey: "trust.privacy.t", dKey: "trust.privacy.d" },
];

const LAYOUT_CARDS = [
  ["process.s1.t", "process.s1.d"],
  ["process.s2.t", "process.s2.d"],
  ["process.s3.t", "process.s3.d"],
  ["process.s4.t", "process.s4.d"],
];

const TESTIMONIALS = [
  { name: "宁波 孙**", initial: "孙", region: "宁波", service: "Netflix 整号购买", rating: 5, date: "3 分钟前", text: "整号档案分得很清楚，电视端登录一次就好了。客服把注意事项发得很细，家里人用起来没再问我。" },
  { name: "夏**", initial: "夏", region: "深圳", service: "全球代付 · 海外购物", rating: 5, date: "7 分钟前", text: "买的东西只收海外卡，我把商品页和标价提交后，当天就收到了报价邮件。确认金额再付款，后来查订单也能看到处理进度。" },
  { name: "林*", initial: "林", region: "苏州", service: "机场节点 · 高级套餐", rating: 5, date: "9 分钟前", text: "100GB 每月对我刚好，刷流媒体和临时办公都够用。订阅导入很顺，晚高峰速度也稳。" },
  { name: "Qian**", initial: "Q", region: "上海", service: "AI 会员 · GPT 20x Pro", rating: 5, date: "16 分钟前", text: "额度比普通 Plus 宽很多，做方案和代码问题不用一直卡次数。开通后订单里能看到记录，很放心。" },
  { name: "何*", initial: "何", region: "广州", service: "Spotify 家庭套餐", rating: 5, date: "25 分钟前", text: "家庭名额邀请步骤写得清楚，爸妈和我自己的账号都正常加入，歌单也没丢。" },
  { name: "陈**", initial: "陈", region: "成都", service: "Disney+ 单独车位", rating: 5, date: "38 分钟前", text: "孩子看动画很稳定，4K 画质正常。客服回复速度挺快，遇到登录提示也帮忙排查了。" },
  { name: "Leo***", initial: "L", region: "新加坡", service: "机场节点 · 无限套餐", rating: 5, date: "52 分钟前", text: "设备多所以选无限流量，手机、电脑、电视都在用，速度稳定，售后也不是机器人式回复。" },
  { name: "赵*", initial: "赵", region: "杭州", service: "Netflix + Disney+", rating: 5, date: "1 小时前", text: "组合一起买省心很多，两边账号信息都整理在订单里，后面查状态也方便。" },
  { name: "Wen**", initial: "W", region: "台北", service: "HBO Max 整号", rating: 5, date: "1 小时前", text: "整号档案足够一家人用，杜比和字幕都正常。付款后邮件通知很快到，体验比较正规。" },
  { name: "郑*", initial: "郑", region: "武汉", service: "AI 会员 · Claude 5x Max", rating: 5, date: "2 小时前", text: "长文和代码场景用得多，Max 额度更稳。客服说明了使用边界，没有夸大，这点挺好。" },
  { name: "Nora***", initial: "N", region: "温哥华", service: "Spotify + 机场节点", rating: 5, date: "2 小时前", text: "海外下单也顺，Spotify 和节点一起处理，配置好以后日常听歌、看视频都没问题。" },
  { name: "马**", initial: "马", region: "天津", service: "机场节点 · 普通套餐", rating: 5, date: "3 小时前", text: "50GB 每月够日常使用，价格清楚，订阅链接导入后不用折腾，续费也能在订单里查。" },
  { name: "Ivy***", initial: "I", region: "曼谷", service: "Disney+ 整号", rating: 5, date: "3 小时前", text: "整号开通很快，几个档案都能用。客服把登录地区和注意事项说得明白，省了不少时间。" },
  { name: "周**", initial: "周", region: "绍兴", service: "Spotify 家庭成员", rating: 5, date: "2小时前", text: "客服确认很快，Spotify 开通后歌单和播客都正常，家庭席位价格也合适" },
  { name: "刘*", initial: "刘", region: "洛阳", service: "Netflix 4K 杜比", rating: 5, date: "4小时前", text: "单独车位能上锁，电视端 4K 播放稳定，邮件通知和订单查询都很清楚" },
  { name: "郑**", initial: "郑", region: "南通", service: "机场节点 · 高级套餐", rating: 5, date: "6小时前", text: "晚高峰看流媒体也不卡，节点切换方便，客服把订阅链接和使用方式讲得很明白" },
  { name: "陈***", initial: "陈", region: "宜昌", service: "Disney+ 整号", rating: 5, date: "8小时前", text: "整号档案够家里人用，价格比自己折腾省心很多，售后回复也稳定" },
  { name: "Mia****", initial: "M", region: "深圳", service: "机场节点", rating: 5, date: "9小时前", text: "看流媒体4K 不缓冲，日常使用其他app也很流畅。普通套餐一年 128，50GB/月真实流量够日常用了" },
  { name: "袁**", initial: "袁", region: "嘉兴", service: "HBO Max 单独车位", rating: 5, date: "12小时前", text: "开通速度比预期快，独立车位互不影响，后续查订单也能看到处理状态" },
  { name: "何*", initial: "何", region: "泉州", service: "Spotify 双人订阅", rating: 5, date: "18小时前", text: "双人套餐很适合我和朋友用，账号邀请说明写得清楚，付款后很快就能用了" },
  { name: "张**", initial: "张", region: "盐城", service: "Netflix 整号", rating: 5, date: "一天前", text: "整号购买后给家里分了几个档案，画质和杜比都正常，省了很多沟通成本" },
  { name: "張*", initial: "張", region: "香港", service: "Disney+", rating: 5, date: "一天前", text: "本来还在犹豫，下单完 10 分钟就能用了，体验很顶。已经推荐给好几个朋友" },
  { name: "赵***", initial: "赵", region: "绵阳", service: "机场节点 · 无限套餐", rating: 5, date: "两天前", text: "无限套餐适合多设备使用，速度稳定，遇到使用问题客服直接帮我处理好了" },
  { name: "Yammy***", initial: "Y", region: "伦敦", service: "HBO Max", rating: 5, date: "三天前", text: "第一次买怕被骗，结果非常正规，客服全程指导，账号到现在用了半年都很稳" },
  { name: "孙**", initial: "孙", region: "台州", service: "Spotify 家庭套餐", rating: 5, date: "三天前", text: "家庭套餐邀请名额够用，开通后每个人都能正常听歌，整体流程很顺" },
  { name: "李**", initial: "李", region: "北京", service: "Spotify+Netflix 4K+机场节点", rating: 5, date: "4天前", text: "组合下单还便宜了一些，听歌刷剧和节点服务一站搞定，售后也跟上了，下次还来" },
  { name: "吴***", initial: "吴", region: "柳州", service: "Disney+ 单独车位", rating: 5, date: "4天前", text: "单独车位看动画和电影都稳定，客服发来的说明简单易懂，家里电视一次就登录成功" },
  { name: "Eric***", initial: "E", region: "悉尼", service: "Netflix + 机场节点", rating: 5, date: "4天前", text: "海外使用也没问题，组合服务一次配齐，后续续费应该还会继续在这里买" },
  { name: "黄**", initial: "黄", region: "淄博", service: "HBO Max 整号", rating: 5, date: "5天前", text: "整号档案分配很方便，4K 杜比片源播放正常，客服处理问题很有耐心" },
  { name: "蒋**", initial: "蒋", region: "湖州", service: "Spotify 个人订阅", rating: 5, date: "5天前", text: "个人订阅独立用起来省心，付款后邮件和订单状态都有记录，整体很正规" },
  { name: "唐*", initial: "唐", region: "遵义", service: "Netflix 单独车位", rating: 5, date: "5天前", text: "车位带 PIN 锁，家里电视和 iPad 都能看，客服处理速度比之前买过的平台快" },
  { name: "林**", initial: "林", region: "漳州", service: "机场节点 · 普通套餐", rating: 5, date: "5天前", text: "50GB/月够我刷剧和临时办公，订阅链接一键导入，速度比想象中稳" },
  { name: "韩***", initial: "韩", region: "昆山", service: "Disney+ 4K", rating: 5, date: "6天前", text: "Disney+ 片库正常，4K 画质清楚，遇到登录问题客服很快就帮我解决了" },
  { name: "冯**", initial: "冯", region: "株洲", service: "HBO Max 单独车位", rating: 5, date: "6天前", text: "HBO 的账号一直很稳，订单完成后还能查到开通信息，比较安心" },
  { name: "许*", initial: "许", region: "汕头", service: "Spotify 家庭成员", rating: 5, date: "6天前", text: "价格清楚，邀请流程也讲得明白，家人加入后使用都正常" },
  { name: "梁**", initial: "梁", region: "中山", service: "Netflix 整号", rating: 5, date: "6天前", text: "整号档案多，给家里人分开看互不影响，比单独买会员方便很多" },
  { name: "Kane***", initial: "K", region: "新加坡", service: "机场节点 · 豪华套餐", rating: 5, date: "6天前", text: "跨区看流媒体速度不错，客服能看懂我的使用场景，推荐的套餐刚好合适" },
  { name: "马**", initial: "马", region: "呼和浩特", service: "Disney+ 整号", rating: 5, date: "6天前", text: "整号开通后几个档案都能正常用，邮件通知及时，后续续费也方便" },
  { name: "彭*", initial: "彭", region: "南昌", service: "Spotify + HBO Max", rating: 5, date: "6天前", text: "两个服务一起买省了不少，客服统一处理，到账后信息也很完整" },
  { name: "邓**", initial: "邓", region: "衡阳", service: "机场节点 · 无限套餐", rating: 5, date: "6天前", text: "设备多所以选无限套餐，晚高峰也能正常看视频，稳定性挺好" },
  { name: "Nina***", initial: "N", region: "温哥华", service: "Netflix 4K 杜比", rating: 5, date: "6天前", text: "海外下单也很顺，客服回复快，账号开好后电视端直接能用" },
  { name: "曹**", initial: "曹", region: "泰州", service: "Spotify 家庭套餐", rating: 5, date: "6天前", text: "家庭套餐名额够用，客服把邀请和注意事项都写清楚了，体验很省心" },
  { name: "任*", initial: "任", region: "潍坊", service: "HBO Max 整号", rating: 5, date: "6天前", text: "整号比车位更适合一家人，档案独立，播放没有遇到卡顿" },
  { name: "沈**", initial: "沈", region: "常州", service: "Netflix + Disney+", rating: 5, date: "6天前", text: "组合购买后两个平台都开通了，订单页面能查进度，售后也能接上" },
  { name: "Leo***", initial: "L", region: "吉隆坡", service: "机场节点 · 高级套餐", rating: 5, date: "6天前", text: "节点延迟低，流媒体和 AI 工具都能用，客服给的使用教程很清楚" },
  { name: "顾**", initial: "顾", region: "无锡", service: "Spotify 家庭套餐", rating: 5, date: "2小时前", text: "家人加入很顺，客服把邀请步骤发得很清楚，邮箱里也能看到订单记录" },
  { name: "秦*", initial: "秦", region: "桂林", service: "Disney+ 整号", rating: 5, date: "3小时前", text: "整号档案够用，孩子看动画也稳定，价格和周期写得很明白" },
  { name: "Ray***", initial: "R", region: "多伦多", service: "Netflix + Disney+", rating: 5, date: "4小时前", text: "两项一起买省事很多，海外电视端登录正常，客服回复也及时" },
  { name: "罗**", initial: "罗", region: "江门", service: "Netflix 整号", rating: 5, date: "5小时前", text: "整号比车位更适合家里用，档案独立，后续续费也可以在订单里查" },
  { name: "杨***", initial: "杨", region: "大理", service: "机场节点 · 5元测试", rating: 5, date: "6小时前", text: "先买测试套餐试了一下，订阅导入简单，速度稳定后又准备换年付" },
  { name: "Ari***", initial: "A", region: "曼谷", service: "HBO Max 单独车位", rating: 5, date: "7小时前", text: "单独车位不互相影响，画质稳定，客服说明也没有绕来绕去" },
  { name: "卢**", initial: "卢", region: "岳阳", service: "Disney+ 4K 杜比", rating: 5, date: "8小时前", text: "下单后邮件很快到，电视端 4K 播放正常，整体比临时找人拼车安心" },
  { name: "胡*", initial: "胡", region: "金华", service: "Spotify 个人订阅", rating: 5, date: "9小时前", text: "个人订阅独立使用很省心，付款后客服确认快，歌单都正常" },
  { name: "郭**", initial: "郭", region: "包头", service: "机场节点 · 普通套餐", rating: 5, date: "10小时前", text: "日常刷剧和临时办公够用，线路说明清楚，续费也不麻烦" },
  { name: "H**", initial: "H", region: "新北", service: "Netflix + Disney+", rating: 5, date: "11小时前", text: "两个平台一起处理，邮件记录完整，有问题直接带订单号沟通很方便" },
  { name: "苏**", initial: "苏", region: "厦门", service: "Spotify 双人订阅", rating: 5, date: "昨天", text: "双人套餐刚好适合我和朋友，邀请过程顺，客服提醒也很到位" },
  { name: "叶*", initial: "叶", region: "宁波", service: "HBO Max 整号", rating: 5, date: "昨天", text: "整号开通后全家都能看，档案分开互不影响，价格比单独开划算" },
  { name: "杜**", initial: "杜", region: "合肥", service: "机场节点 · 高级套餐", rating: 5, date: "昨天", text: "高级套餐流量够用，高峰期看视频也稳，订阅链接说明很清楚" },
  { name: "钟***", initial: "钟", region: "佛山", service: "Disney+ 单独车位", rating: 5, date: "昨天", text: "单独车位使用简单，账号信息和售后说明都在邮件里，查起来方便" },
  { name: "魏**", initial: "魏", region: "成都", service: "Netflix 4K 杜比", rating: 5, date: "前天", text: "4K 杜比效果正常，PIN 锁设置好以后家里人用着也不乱" },
  { name: "姚*", initial: "姚", region: "长沙", service: "Spotify 家庭成员", rating: 5, date: "前天", text: "价格透明，流程比想象中简单，提交后很快就收到确认" },
  { name: "Mok***", initial: "M", region: "澳门", service: "机场节点 · 无限套餐", rating: 5, date: "前天", text: "多设备长期在线比较适合无限套餐，客服把注意事项一次说清了" },
  { name: "范**", initial: "范", region: "郑州", service: "HBO Max + Netflix", rating: 5, date: "3天前", text: "组合购买后两个都能用，订单状态和邮件同步，售后沟通不用重复解释" },
  { name: "宋*", initial: "宋", region: "太原", service: "Disney+ 整号", rating: 5, date: "3天前", text: "家里电视和手机都能看，档案足够，客服处理速度挺稳" },
  { name: "陆**", initial: "陆", region: "苏州", service: "Spotify 个人订阅", rating: 5, date: "3天前", text: "个人订阅适合自己用，开通信息清楚，后续查订单也方便" },
  { name: "余***", initial: "余", region: "贵阳", service: "机场节点 · 豪华套餐", rating: 5, date: "4天前", text: "流量给得足，多个设备轮着用也够，速度比之前用的平台稳定" },
  { name: "程**", initial: "程", region: "杭州", service: "AI 会员 · GPT Plus", rating: 5, date: "1小时前", text: "GPT Plus 官方直充，独立账号用着放心，下单后十几分钟就开通了，客服很专业" },
  { name: "Aiden***", initial: "A", region: "硅谷", service: "AI 会员 · Claude Pro", rating: 5, date: "3小时前", text: "Claude Pro 开通很快，写代码和长文都很顺，价格比自己开划算，售后也跟得上" },
  { name: "邹**", initial: "邹", region: "武汉", service: "AI 会员 · GPT 5x Pro", rating: 5, date: "5小时前", text: "5x 额度日常重度使用完全够，账号稳定没掉过，遇到问题带订单号客服直接处理" },
  { name: "白*", initial: "白", region: "西安", service: "AI 会员 · Claude 5x Max", rating: 5, date: "7小时前", text: "Max 高额度跑大项目很顺手，官方渠道靠谱，开通和说明都很清楚，会回购" },
  { name: "Kai**", initial: "K", region: "东京", service: "全球代付 · 酒店预订", rating: 5, date: "40 分钟前", text: "酒店官网的房型只收境外卡，我在备注里写了入住日期。客服核对房型后发来报价，付款完成后订单状态很快更新了。" },
  { name: "汤*", initial: "汤", region: "长沙", service: "全球代付 · 软件订阅", rating: 5, date: "2 小时前", text: "设计工具的年付页面一直刷不过卡，提交官网链接后收到报价邮件。付完后当天续费成功，服务中心也能查到记录。" },
];

const TESTIMONIALS_EN = [
  { name: "Nathan R.", initial: "N", region: "New York", service: "Netflix full account", rating: 5, date: "4 min ago", text: "Profiles were organized clearly and the TV login worked on the first try. Support sent practical notes instead of generic replies." },
  { name: "Oliver P.", initial: "O", region: "Vancouver", service: "Proxy Pay · overseas shopping", rating: 5, date: "8 min ago", text: "The store only accepted overseas cards. I sent the item page and listed price, received the quote by email that day, then tracked the request after paying." },
  { name: "Claire T.", initial: "C", region: "Sydney", service: "VPN · Plus", rating: 5, date: "11 min ago", text: "100GB per month is enough for streaming and a little remote work. Importing the subscription was simple and peak-hour speed stayed steady." },
  { name: "Ryan H.", initial: "R", region: "Toronto", service: "AI Membership · GPT 20x Pro", rating: 5, date: "22 min ago", text: "The higher quota makes daily heavy use much easier. Activation was fast, and the order page kept the records clear." },
  { name: "Emily S.", initial: "E", region: "Los Angeles", service: "Spotify Premium Family", rating: 5, date: "35 min ago", text: "Family invites were explained clearly. Everyone joined without losing playlists, and support checked in after activation." },
  { name: "Kenji M.", initial: "K", region: "Tokyo", service: "Disney+ Profile", rating: 5, date: "48 min ago", text: "4K playback is stable and the dedicated profile is tidy. When I had a login prompt, support helped me solve it quickly." },
  { name: "Sofia A.", initial: "S", region: "Madrid", service: "VPN · Unlimited", rating: 5, date: "1 hour ago", text: "Multiple devices are online most of the day, so unlimited works better for me. Speed is steady and support feels real." },
  { name: "Oliver P.", initial: "O", region: "Auckland", service: "Netflix + Disney+", rating: 5, date: "2 hours ago", text: "Buying both together saved time. Account details for each service were organized in the order, which makes later checks easy." },
  { name: "Iris W.", initial: "I", region: "Taipei", service: "HBO Max full account", rating: 5, date: "2 hours ago", text: "A full account is enough for the whole family. Dolby and subtitles work normally, and the email update arrived quickly." },
  { name: "James W.", initial: "J", region: "London", service: "Spotify Premium Family", rating: 5, date: "2 hours ago", text: "Support confirmed quickly. Spotify worked right away — playlists and podcasts all fine, and the family plan was great value." },
  { name: "Mia C.", initial: "M", region: "Singapore", service: "Netflix 4K Dolby", rating: 5, date: "4 hours ago", text: "My own profile can be PIN-locked, 4K playback on the TV is rock solid, and order updates were clear." },
  { name: "Ethan R.", initial: "E", region: "Sydney", service: "VPN · Premium", rating: 5, date: "6 hours ago", text: "No buffering even at peak hours. Switching nodes is easy and support explained the setup clearly." },
  { name: "Olivia P.", initial: "O", region: "Vancouver", service: "Disney+ full account", rating: 5, date: "8 hours ago", text: "A full account is plenty for the family — much less hassle than doing it myself, and after-sales is reliable." },
  { name: "Liam H.", initial: "L", region: "Toronto", service: "HBO Max Profile", rating: 5, date: "12 hours ago", text: "Set up faster than expected, the dedicated profile doesn't interfere with anyone, and I can track the order status." },
  { name: "Sophia L.", initial: "S", region: "Kuala Lumpur", service: "Spotify Premium Duo", rating: 5, date: "18 hours ago", text: "The Duo plan suits me and a friend perfectly. The invite instructions were clear and it worked right after payment." },
  { name: "Noah K.", initial: "N", region: "Bangkok", service: "Netflix full account", rating: 5, date: "yesterday", text: "Bought the full account and split profiles for the family — picture quality and Dolby are perfect, saved a lot of back-and-forth." },
  { name: "Ava M.", initial: "A", region: "New Taipei", service: "Disney+", rating: 5, date: "yesterday", text: "I was hesitant at first, but it was up within 10 minutes. Great experience — already recommended it to friends." },
  { name: "Lucas B.", initial: "L", region: "Tokyo", service: "VPN · Unlimited", rating: 5, date: "2 days ago", text: "Unlimited works well for multiple devices, the speed is stable, and support sorted out my questions directly." },
  { name: "Emma T.", initial: "E", region: "Melbourne", service: "HBO Max", rating: 5, date: "3 days ago", text: "First purchase and I worried about scams — turned out very legit, support guided me through, and it's been stable for half a year." },
  { name: "Daniel S.", initial: "D", region: "Auckland", service: "Spotify Premium Family", rating: 5, date: "3 days ago", text: "Plenty of family invite slots. After setup everyone could stream fine — the whole flow was smooth." },
  { name: "Grace Y.", initial: "G", region: "Hong Kong", service: "Spotify + Netflix + VPN", rating: 5, date: "4 days ago", text: "Bundling was a bit cheaper too. Music, streaming and VPN in one place, after-sales kept up. I'll be back." },
  { name: "Henry F.", initial: "H", region: "Seoul", service: "Disney+ Profile", rating: 5, date: "4 days ago", text: "The dedicated profile is stable for movies and animation, the instructions were simple, and the TV logged in first try." },
  { name: "Chloe D.", initial: "C", region: "Manila", service: "Netflix + VPN", rating: 5, date: "5 days ago", text: "Works fine from overseas too, everything configured at once. I'll likely keep renewing here." },
  { name: "Mason K.", initial: "M", region: "San Francisco", service: "AI Membership · GPT Plus", rating: 5, date: "2 hours ago", text: "Official top-up and a private account I don't have to share — activated within minutes, and support was sharp." },
  { name: "Ivy L.", initial: "I", region: "Singapore", service: "AI Membership · Claude Pro", rating: 5, date: "6 hours ago", text: "Claude Pro was up fast and stayed stable for long writing and coding. Cheaper than doing it myself, with real after-sales." },
  { name: "Mia S.", initial: "M", region: "London", service: "Proxy Pay · hotel booking", rating: 5, date: "1 hour ago", text: "The hotel rate only accepted a foreign card. I added the dates in my note, received a quote after they checked the room, and saw the order update after payment." },
  { name: "Ethan W.", initial: "E", region: "Sydney", service: "Proxy Pay · software subscription", rating: 5, date: "3 hours ago", text: "My annual software renewal kept declining at checkout. I submitted the official page, paid through the emailed quote, and the renewal was active later that day." },
];

const TESTIMONIALS_PER_PAGE = 4;
const TESTIMONIALS_STEP = 2;
const TESTIMONIALS_INTERVAL_MS = 5500;

const LIVE_ORDER_CITIES = [
  "宁波", "嘉兴", "绍兴", "洛阳", "南通", "宜昌", "泉州", "盐城", "绵阳", "台州",
  "桂林", "江门", "大理", "岳阳", "金华", "包头", "衡阳", "珠海", "澳门", "新加坡",
  "上海", "北京", "广州", "深圳", "杭州", "南京", "成都", "重庆", "武汉", "西安",
  "苏州", "天津", "长沙", "郑州", "青岛", "宁波", "厦门", "福州", "无锡", "合肥",
  "佛山", "东莞", "珠海", "中山", "泉州", "南昌", "贵阳", "昆明", "南宁", "哈尔滨",
  "沈阳", "大连", "长春", "济南", "太原", "石家庄", "呼和浩特", "乌鲁木齐", "兰州", "西宁",
  "银川", "海口", "三亚", "香港", "澳门", "台北", "新北", "新加坡", "悉尼", "温哥华",
];

const LIVE_ORDER_NAMES = [
  "孙**", "李*", "夜鹿3166", "林*", "钱**", "何*", "赵*", "Wen**", "郑*", "Nora***",
  "马**", "Ivy***", "周*", "阿杰**", "小陈*", "Ray***", "Leo***", "Ari***", "H**", "Mok***",
  "陈**", "林*", "王***", "李**", "张*", "刘**", "黄***", "赵**", "吴*", "周**",
  "徐***", "孙**", "胡*", "朱**", "高***", "何**", "郭*", "马**", "罗***", "梁**",
  "宋*", "郑**", "谢***", "唐**", "韩*", "曹**", "许***", "邓**", "冯*", "曾**",
  "彭***", "萧**", "蔡*", "潘**", "田***", "董**", "袁*", "于**", "余***", "叶**",
  "苏*", "魏**", "姚***", "卢**", "钟*", "严**", "Kane***", "Mia***", "Ray***", "Nina***",
];

const LIVE_ORDER_PRODUCTS = [
  "Netflix 整号购买", "Netflix 4K 杜比车位", "Disney+ 单独车位", "Disney+ 整号购买",
  "Spotify 家庭套餐", "Spotify 双人订阅", "Spotify 个人订阅",
  "HBO Max 整号购买", "HBO Max 单独车位",
  "机场节点 · 普通套餐", "机场节点 · 高级套餐", "机场节点 · 豪华套餐", "机场节点 · 无限套餐", "机场节点 · 5元10GB测试",
  "AI 会员 · GPT Plus", "AI 会员 · GPT 5x Pro", "AI 会员 · GPT 20x Pro", "AI 会员 · Claude Pro", "AI 会员 · Claude 5x Max", "AI 会员 · Claude 20x Max",
  "Spotify + Netflix", "Netflix + Disney+", "Spotify + 机场节点", "AI 会员 + 机场节点", "HBO Max + Netflix",
  "Spotify 家庭成员", "Spotify 个人订阅", "Spotify 双人订阅", "Spotify 家庭套餐",
  "Netflix 4K 单独车位", "Netflix 整号购买",
  "Disney+ 单独车位", "Disney+ 整号购买",
  "HBO Max 单独车位", "HBO Max 整号购买",
  "机场节点 · 普通套餐", "机场节点 · 高级套餐", "机场节点 · 豪华套餐", "机场节点 · 无限套餐", "机场节点 · 5元10GB测试",
  "AI 会员 · GPT Plus", "AI 会员 · GPT 5x Pro", "AI 会员 · GPT 20x Pro", "AI 会员 · Claude Pro", "AI 会员 · Claude 5x Max", "AI 会员 · Claude 20x Max",
  "Spotify + Netflix", "Netflix + Disney+", "Spotify + HBO Max", "机场节点 + Netflix", "Spotify + 机场节点", "AI 会员 + Netflix",
  "全球代付 · 海外购物", "全球代付 · 订酒店机票", "全球代付 · 充值话费", "全球代付 · 虚拟会员", "全球代付 · 海外服装日用",
];

const LIVE_ORDER_TIMES = [
  "刚刚", "1 分钟前", "2 分钟前", "3 分钟前", "5 分钟前", "8 分钟前", "10 分钟前", "12 分钟前",
  "15 分钟前", "18 分钟前", "22 分钟前", "26 分钟前", "31 分钟前", "36 分钟前", "45 分钟前", "52 分钟前",
];

function seededUnit(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function beijingParts(date = new Date()) {
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
  };
}

function daySeed(parts) {
  return parts.year * 10000 + parts.month * 100 + parts.day;
}

function operationWeight(hour) {
  if (hour >= 0 && hour < 6) return 0.16;
  if (hour >= 6 && hour < 8) return 0.55;
  if (hour >= 8 && hour < 11) return 1.32;
  if (hour >= 11 && hour < 14) return 0.82;
  if (hour >= 14 && hour < 17) return 0.96;
  if (hour >= 17 && hour < 21) return 1.42;
  if (hour >= 21 && hour < 23) return 0.78;
  return 0.28;
}

function slotWeight(slot, seed) {
  const hour = Math.floor((slot * OPERATION_SLOT_MINUTES) / 60);
  const jitter = 0.74 + seededUnit(seed + slot * 17) * 0.52;
  return operationWeight(hour) * jitter;
}

function dailyOrderTarget(seed) {
  return Math.min(1500, Math.floor(1080 + seededUnit(seed + 91) * 390));
}

function processedOrderCount(parts) {
  const seed = daySeed(parts);
  const target = dailyOrderTarget(seed);
  const currentSlot = Math.min(OPERATION_SLOTS_PER_DAY - 1, Math.floor((parts.hour * 60 + parts.minute) / OPERATION_SLOT_MINUTES));
  const slotProgress = (parts.minute % OPERATION_SLOT_MINUTES) / OPERATION_SLOT_MINUTES;
  let fullDayWeight = 0;
  let elapsedWeight = 0;
  for (let slot = 0; slot < OPERATION_SLOTS_PER_DAY; slot += 1) {
    const weight = slotWeight(slot, seed);
    fullDayWeight += weight;
    if (slot < currentSlot) elapsedWeight += weight;
    if (slot === currentSlot) elapsedWeight += weight * slotProgress;
  }
  return Math.min(1500, Math.floor(target * (elapsedWeight / fullDayWeight)));
}

function queueCount(parts, processed) {
  const seed = daySeed(parts);
  const slot = Math.floor((parts.hour * 60 + parts.minute) / 5);
  const peak = operationWeight(parts.hour);
  const wave = seededUnit(seed + slot * 31 + 701);
  const target = dailyOrderTarget(seed);
  const processedRatio = processed / Math.max(1, target);
  if (processed < 40) return 0;
  if (peak < 0.5) return processed < 220 ? 0 : (wave > 0.82 ? 1 : 0);
  if (processed < 90) return wave > 0.88 ? 1 : 0;
  if (processed < 180 && peak < 1) return wave > 0.72 ? 1 : 0;
  const demand = peak * Math.min(1, processedRatio * 1.25);
  const cap = demand < 0.16 ? 2 : demand < 0.32 ? 5 : demand < 0.55 ? 9 : (peak >= 1.3 ? 20 : 13);
  const floor = peak >= 1.3 && processed > 320 ? 3 : peak >= 0.9 && processed > 260 ? 1 : 0;
  const value = Math.round(floor + wave * cap);
  if (processed < 180) return Math.min(value, 2);
  if (processed < 320) return Math.min(value, 5);
  return Math.max(0, Math.min(32, value));
}

function buildOperationMetrics(date = new Date()) {
  const parts = beijingParts(date);
  const processed = processedOrderCount(parts);
  const queued = queueCount(parts, processed);
  const seed = daySeed(parts) + Math.floor((parts.hour * 60 + parts.minute) / 10);
  const wave = seededUnit(seed + 505);
  let response = "<1分钟";
  if (queued <= 0) response = wave > 0.72 ? "1分钟内" : "<1分钟";
  else if (queued <= 3) response = wave > 0.55 ? "2分钟内" : "1分钟内";
  else if (queued <= 8) response = wave > 0.4 ? "3分钟内" : "2分钟内";
  else if (queued <= 16) response = wave > 0.5 ? "4分钟内" : "3分钟内";
  else response = "5分钟内";
  return {
    processedToday: `${processed.toLocaleString("zh-CN")}单`,
    averageResponse: response,
    queueCount: `${queued}单`,
    serviceYears: "近6年",
  };
}

const EN_LIVE_ORDER_CITIES = [
  "San Francisco", "Los Angeles", "Chicago", "Seattle", "Boston", "Vancouver", "Montreal", "Taipei", "Macau", "Jakarta",
  "Ho Chi Minh City", "Hanoi", "Kuala Lumpur", "Dubai", "Doha", "Zurich", "Milan", "Stockholm", "Dublin", "Vienna",
  "London", "Singapore", "Sydney", "Toronto", "New York", "Tokyo", "Seoul", "Bangkok",
  "Vancouver", "Melbourne", "Auckland", "Hong Kong", "Kuala Lumpur", "Manila", "Dubai",
  "Berlin", "Paris", "Amsterdam", "Madrid", "Osaka", "Taipei", "New Taipei", "Macau", "Los Angeles",
];
const EN_LIVE_ORDER_NAMES = [
  "Nathan R.", "Claire T.", "Ryan H.", "Emily S.", "Kenji M.", "Sofia A.", "Oliver P.", "Iris W.",
  "Aaron L.", "Bella K.", "Miles C.", "Nora P.", "Theo G.", "Ivy W.", "Kai S.", "Rina M.",
  "James W.", "Mia C.", "Ethan R.", "Olivia P.", "Liam H.", "Sophia L.", "Noah K.", "Ava M.",
  "Lucas B.", "Emma T.", "Daniel S.", "Grace Y.", "Henry F.", "Chloe D.", "Jack M.", "Lily Z.",
  "Owen K.", "Zoe R.", "Leo P.", "Nina S.",
];
const EN_LIVE_ORDER_PRODUCTS = [
  "Netflix full account", "Netflix 4K Dolby profile", "Disney+ dedicated profile", "Disney+ full account",
  "Spotify Premium Family", "Spotify Premium Duo", "Spotify Premium Individual",
  "HBO Max full account", "HBO Max dedicated profile",
  "VPN · Standard", "VPN · Plus", "VPN · Premium", "VPN · Unlimited", "VPN · 10GB trial",
  "AI Membership · GPT Plus", "AI Membership · GPT 5x Pro", "AI Membership · GPT 20x Pro",
  "AI Membership · Claude Pro", "AI Membership · Claude 5x Max", "AI Membership · Claude 20x Max",
  "Spotify + Netflix", "Netflix + Disney+", "Spotify + VPN", "AI Membership + VPN", "HBO Max + Netflix",
  "Spotify Premium Family", "Spotify Premium Individual", "Spotify Premium Duo", "Netflix 4K Profile", "Netflix full account",
  "Disney+ Profile", "Disney+ full account", "HBO Max Profile", "HBO Max full account",
  "VPN · Standard", "VPN · Plus", "VPN · Premium", "VPN · Unlimited",
  "AI Membership · GPT Plus", "AI Membership · GPT 5x Pro", "AI Membership · GPT 20x Pro", "AI Membership · Claude Pro", "AI Membership · Claude 5x Max", "AI Membership · Claude 20x Max",
  "Spotify + Netflix", "Netflix + Disney+", "Spotify + VPN", "AI Membership + Netflix",
  "Proxy Pay · overseas shopping", "Proxy Pay · hotels & flights", "Proxy Pay · mobile top-up", "Proxy Pay · digital membership", "Proxy Pay · overseas apparel",
];
const EN_LIVE_ORDER_TIMES = [
  "just now", "1 min ago", "2 min ago", "3 min ago", "5 min ago", "8 min ago", "10 min ago", "12 min ago",
  "15 min ago", "18 min ago", "22 min ago", "26 min ago", "31 min ago", "36 min ago", "45 min ago", "52 min ago",
];

function liveOrderAt(index, locale) {
  const en = locale === "en";
  const cities = en ? EN_LIVE_ORDER_CITIES : LIVE_ORDER_CITIES;
  const names = en ? EN_LIVE_ORDER_NAMES : LIVE_ORDER_NAMES;
  const products = en ? EN_LIVE_ORDER_PRODUCTS : LIVE_ORDER_PRODUCTS;
  const times = en ? EN_LIVE_ORDER_TIMES : LIVE_ORDER_TIMES;
  const seed = 20260602 + index * 97;
  const city = cities[Math.floor(seededUnit(seed + 11) * cities.length) % cities.length];
  const name = names[Math.floor(seededUnit(seed + 23) * names.length) % names.length];
  const product = products[Math.floor(seededUnit(seed + 37) * products.length) % products.length];
  const time = times[Math.floor(seededUnit(seed + 51) * times.length) % times.length];
  return { city, name, product, time };
}

function LiveOrderTicker() {
  const { t, locale } = useLocale();
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const cycleLength = Math.max(
      LIVE_ORDER_CITIES.length,
      LIVE_ORDER_NAMES.length,
      LIVE_ORDER_PRODUCTS.length,
      EN_LIVE_ORDER_CITIES.length,
      EN_LIVE_ORDER_NAMES.length,
      EN_LIVE_ORDER_PRODUCTS.length
    ) * 5;
    const timer = setInterval(() => setIdx((i) => (i + 1) % cycleLength), 3200);
    return () => clearInterval(timer);
  }, []);
  const order = liveOrderAt(idx, locale);
  return (
    <div className="home-announcement-row" role="status" aria-live="polite" key={idx}>
      <Megaphone size={15} />
      <span>
        <b>{order.city}</b> {order.name} {t("ticker.ordered")} {order.product} · {order.time}
      </span>
      <ArrowRight size={14} />
    </div>
  );
}

function HomeTestimonials() {
  const { locale } = useLocale();
  const list = locale === "en" ? TESTIMONIALS_EN : TESTIMONIALS;
  const [start, setStart] = useState(0);
  useEffect(() => {
    setStart(0);
    const timer = setInterval(() => {
      setStart((value) => (value + TESTIMONIALS_STEP) % list.length);
    }, TESTIMONIALS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [list.length]);
  const visible = Array.from({ length: TESTIMONIALS_PER_PAGE }, (_, i) => list[(start + i) % list.length]);
  return (
    <div className="testimonials-grid testimonials-rotator home-testimonials-grid" key={start}>
      {visible.map((t, i) => (
        <article key={`${start}-${i}-${t.name}-${t.date}`} className="glass-card testimonial-card">
          <div className="testimonial-head">
            <div className="testimonial-avatar">{t.initial}</div>
            <div>
              <div className="testimonial-name">{t.name}</div>
              <div className="testimonial-meta">{t.region} · {t.service}</div>
            </div>
            <div className="testimonial-stars">
              {[...Array(t.rating)].map((_, j) => (
                <Star key={j} size={13} fill="currentColor" />
              ))}
            </div>
          </div>
          <div className="testimonial-text">"{t.text}"</div>
          <div className="testimonial-date">{t.date}</div>
        </article>
      ))}
    </div>
  );
}

export default function Page() {
  const [metrics, setMetrics] = useState(OPERATION_INITIAL_METRICS);
  const [authUser, setAuthUser] = useState(null);
  const { locale, t } = useLocale();
  const catalogVersion = useCatalogSync(); // 后台商品/价格覆盖(上下架/改价同步)
  const siteSettings = useSiteSettings();   // 站点设置(页脚公司信息/版权同步)
  const footerCfg = siteSettings.footer;
  const catByKey = {};
  getCatalogProducts().forEach((p) => { catByKey[p.key] = p; });
  // 首页固定 6 张卡:HBO Max 不上首页(选购页/服务页仍正常售卖)。两个分支都排除,避免加载闪现。
  // 顺序跟随合并目录(后台「商品价格」的排序字段改了,首页/选购页同步变)。
  const HOME_HIDDEN_KEYS = ["max"];
  const homeBase = SERVICE_PAGES.filter((s) => !HOME_HIDDEN_KEYS.includes(s.key));
  const homeServices = catalogOverrideLoaded()
    ? getCatalogProducts().map((p) => homeBase.find((s) => s.key === p.key)).filter(Boolean) // 目录序+仅上架
    : homeBase;

  useEffect(() => {
    const update = () => setMetrics(buildOperationMetrics());
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setAuthUser(data.ok ? data : false))
      .catch(() => setAuthUser(false));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const redeem = params.get("redeem");
    const order = params.get("order");
    const auth = params.get("auth");
    if (redeem) {
      window.history.replaceState(null, "", `/?redeem=${encodeURIComponent(redeem)}#redeem`);
    } else if (order) {
      window.location.replace(`/service-center?order=${encodeURIComponent(order)}`);
    } else if (auth) {
      window.location.replace(`/account?auth=${encodeURIComponent(auth)}`);
    }
  }, []);

  return (
    <div className="page-shell home-page-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify([
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "冒央会社",
              alternateName: "Maoyang Taiwan Inc",
              url: "https://www.liumeiti.vip",
              logo: "https://www.liumeiti.vip/icon-512.png",
              address: {
                "@type": "PostalAddress",
                streetAddress: "远东路1号3-218",
                addressLocality: "板桥区",
                addressRegion: "新北市",
                addressCountry: "TW",
              },
            },
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "冒央会社",
              url: "https://www.liumeiti.vip",
            },
          ]),
        }}
      />
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="冒央会社 Maoyang Taiwan Inc">
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <div className="mobile-header-actions" aria-label={locale === "en" ? "Quick links" : "快捷入口"}>
            <LanguageSwitcher />
            <Link href="/service-center" aria-label={t("nav.support")}>
              <Headphones size={16} />
              <span>{t("nav.support")}</span>
            </Link>
          </div>
          <nav className="desktop-nav">
            <Link href="/shop">{t("nav.services")}</Link>
            <Link href="/#layout">{t("nav.process")}</Link>
            <Link href="/service-center#order-query">{t("nav.orderQuery")}</Link>
            <Link href="/legal">{t("nav.legal")}</Link>
            <Link href="/service-center#faq">{t("nav.faq")}</Link>
            <LanguageSwitcher className="desktop-lang" />
          </nav>
        </div>
      </header>

      <main id="top" className="main-content home-main">
        <section className="home-hero-card container">
          <div className="home-hero-logo-wrap">
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="home-hero-full-logo" />
            <h1 className="sr-only">{locale === "en" ? "Maoyang Taiwan Inc · Streaming memberships" : "冒央会社 · 流媒体服务"}</h1>
          </div>
          <p>{t("hero.tagline")}</p>
          <div className="home-hero-badges">
            <span><Zap size={14} />{t("hero.badge.instant")}</span>
            <span><ShieldCheck size={14} />{t("hero.badge.refund")}</span>
            <span><BadgeCheck size={14} />{t("hero.badge.lowest")}</span>
          </div>
          <div className="home-hero-actions">
            <Link href="/shop" className="hero-pair-btn primary">
              <Zap size={16} />{t("hero.cta.start")}
            </Link>
            <Link href={authUser === false ? "/account?auth=login" : "/account"} className={`hero-pair-btn secondary${authUser === false ? " with-auth-tip" : ""}`}>
              <Users size={16} />{authUser === false ? t("hero.cta.login") : t("hero.cta.account")}
              {authUser === false && <span className="hero-auth-tip">{t("hero.authTip")}</span>}
            </Link>
            <Link href="/service-center#order-query" className="home-query-btn">
              <ShoppingBag size={16} />{t("hero.cta.orderQuery")}
            </Link>
          </div>
          <div className="home-hero-ticker"><LiveOrderTicker /></div>
          <div className="home-hero-metrics" aria-label={locale === "en" ? "Platform stats" : "平台运营数据"}>
            {HERO_STATS.map(({ metric, labelKey, icon: Icon }) => (
              <div key={metric} className="home-hero-metric">
                <Icon size={14} />
                <span>{t(labelKey)}</span>
                <b>{localizeMetric(metrics[metric], locale)}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-trust-card">
          <h2>{t("trust.title")}</h2>
          <div className="home-trust-grid">
            {TRUST_ITEMS.map(({ icon: Icon, tKey, dKey }) => (
              <div key={tKey} className="home-trust-item">
                <Icon size={22} />
                <strong>{t(tKey)}</strong>
                <span>{t(dKey)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-services-section">
          <div className="section-head simple-head home-compact-head">
            <div>
              <div className="section-kicker">{t("services.kicker")}</div>
              <h2 className="section-title">{t("services.title")}</h2>
            </div>
          </div>
          <div className="home-services-grid">
            {homeServices.map((s) => (
              <Link key={s.slug} href={`/services/${s.slug}`} className={`home-service-card svc-${s.slug}`}>
                <div className="home-service-logo-wrap">
                  <img src={s.image} alt={s.shortTitle} className="home-service-logo" loading="lazy" decoding="async" width="56" height="56" />
                </div>
                <div className="home-service-info">
                  <div className="home-service-name">{locale === "en" ? (serviceCardEn[s.slug]?.name || s.shortTitle) : s.shortTitle}</div>
                  <div className="home-service-sub">{locale === "en" ? (serviceCardEn[s.slug]?.subtitle || s.subtitle) : s.subtitle}</div>
                </div>
                <div className="home-service-foot">
                  <span className="home-service-price">{locale === "en" ? (serviceCardEn[s.slug]?.price || s.price) : (catByKey[s.key]?.price || s.price)}</span>
                  <ArrowRight size={16} className="home-service-arrow" />
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section id="redeem" className="section container home-redeem-section">
          <RedeemCard autoFillFromQuery />
        </section>

        <section id="layout" className="section container home-layout-section">
          <div className="section-head simple-head home-compact-head">
            <div>
              <div className="section-kicker">{t("process.kicker")}</div>
              <h2 className="section-title">{t("process.title")}</h2>
            </div>
          </div>
          <div className="layout-grid layout-grid-stack home-layout-grid">
            {LAYOUT_CARDS.map(([titleKey, descKey], index) => (
              <div key={titleKey} className="glass-card info-card">
                <div className="info-step">{String(index + 1).padStart(2, "0")}</div>
                <ShoppingBag size={24} className="info-icon" />
                <div className="info-title">{t(titleKey)}</div>
                <div className="info-desc">{t(descKey)}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="section container home-reviews-section">
          <div className="section-head simple-head home-compact-head">
            <div className="home-review-heading">
              <div className="section-kicker">{t("reviews.kicker")}</div>
              <div className="home-review-title-row">
                <h2 className="section-title">{t("reviews.title")}</h2>
                <div className="reviews-summary">
                  <div className="reviews-stars">
                    {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={18} fill="currentColor" />)}
                  </div>
                  <div className="reviews-summary-text">
                    <b>4.98 / 5.0</b>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <HomeTestimonials />
        </section>
      </main>

      <footer className="site-footer home-footer">
        <div className="container footer-inner">
          <div className="footer-company">
            <div className="footer-brand">{locale === "en" ? footerCfg.brandEn : footerCfg.brand}</div>
            <div className="footer-links">
              <Link href="/legal">{t("footer.legal")}</Link>
              <Link href="/announcements">{locale === "en" ? "Announcements" : "公告中心"}</Link>
              <Link href="/services/spotify">Spotify</Link>
              <Link href="/services/ai">{locale === "en" ? "AI" : "AI 会员"}</Link>
              <Link href="/services/netflix">Netflix</Link>
              <Link href="/services/disney">Disney+</Link>
              <Link href="/services/hbo-max">HBO Max</Link>
              <Link href="/services/airport-node">{t("footer.airportNode")}</Link>
              <Link href="/services/proxy-payment">{locale === "en" ? "Proxy Pay" : "全球代付"}</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">{locale === "en" ? footerCfg.addressEn : footerCfg.address}</div>
            <div className="footer-pill">{footerCfg.copyright}</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
