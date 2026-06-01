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

const OPERATION_SLOT_MINUTES = 10;
const OPERATION_SLOTS_PER_DAY = 24 * 60 / OPERATION_SLOT_MINUTES;
const OPERATION_INITIAL_METRICS = {
  processedToday: "968单",
  averageResponse: "1分钟内",
  queueCount: "8单",
  serviceYears: "近6年",
};

const HERO_STATS = [
  { metric: "processedToday", label: "今日已处理订单", icon: TrendingUp },
  { metric: "averageResponse", label: "平均响应时间", icon: Clock },
  { metric: "queueCount", label: "当前排队数量", icon: Users },
  { metric: "serviceYears", label: "服务运行年限", icon: Award },
];

const TRUST_ITEMS = [
  { icon: ShieldCheck, title: "稳定渠道", desc: "安全稳定" },
  { icon: Users, title: "专业团队", desc: "7x24在线" },
  { icon: BadgeCheck, title: "快速处理", desc: "及时跟进" },
  { icon: Lock, title: "隐私保护", desc: "放心使用" },
];

const LAYOUT_CARDS = [
  ["选择服务", "选购所需服务，或使用兑换码进行兑换"],
  ["填写资料", "按要求填写所需邮箱、联系方式与开通资料"],
  ["确认提交", "核对信息无误后完成支付，兑换码订单无需支付"],
  ["订单进度", "订单状态更新会向你的邮箱发信，也可在服务中心查询"],
];

const TESTIMONIALS = [
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
];

const TESTIMONIALS_PER_PAGE = 4;
const TESTIMONIALS_INTERVAL_MS = 5500;

const LIVE_ORDER_CITIES = [
  "上海", "北京", "广州", "深圳", "杭州", "南京", "成都", "重庆", "武汉", "西安",
  "苏州", "天津", "长沙", "郑州", "青岛", "宁波", "厦门", "福州", "无锡", "合肥",
  "佛山", "东莞", "珠海", "中山", "泉州", "南昌", "贵阳", "昆明", "南宁", "哈尔滨",
  "沈阳", "大连", "长春", "济南", "太原", "石家庄", "呼和浩特", "乌鲁木齐", "兰州", "西宁",
  "银川", "海口", "三亚", "香港", "澳门", "台北", "新北", "新加坡", "悉尼", "温哥华",
];

const LIVE_ORDER_NAMES = [
  "陈**", "林*", "王***", "李**", "张*", "刘**", "黄***", "赵**", "吴*", "周**",
  "徐***", "孙**", "胡*", "朱**", "高***", "何**", "郭*", "马**", "罗***", "梁**",
  "宋*", "郑**", "谢***", "唐**", "韩*", "曹**", "许***", "邓**", "冯*", "曾**",
  "彭***", "萧**", "蔡*", "潘**", "田***", "董**", "袁*", "于**", "余***", "叶**",
  "苏*", "魏**", "姚***", "卢**", "钟*", "严**", "Kane***", "Mia***", "Ray***", "Nina***",
];

const LIVE_ORDER_PRODUCTS = [
  "Spotify 家庭成员", "Spotify 个人订阅", "Spotify 双人订阅", "Spotify 家庭套餐",
  "Netflix 4K 单独车位", "Netflix 整号购买",
  "Disney+ 单独车位", "Disney+ 整号购买",
  "HBO Max 单独车位", "HBO Max 整号购买",
  "机场节点 · 普通套餐", "机场节点 · 高级套餐", "机场节点 · 豪华套餐", "机场节点 · 无限套餐", "机场节点 · 5元10GB测试",
  "Spotify + Netflix", "Netflix + Disney+", "Spotify + HBO Max", "机场节点 + Netflix", "Spotify + 机场节点",
];

const LIVE_ORDER_TIMES = ["刚刚", "1 分钟前", "2 分钟前", "3 分钟前", "5 分钟前", "8 分钟前", "12 分钟前", "18 分钟前", "26 分钟前", "36 分钟前"];

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

function liveOrderAt(index) {
  const seed = 20260602 + index * 97;
  const city = LIVE_ORDER_CITIES[Math.floor(seededUnit(seed + 11) * LIVE_ORDER_CITIES.length) % LIVE_ORDER_CITIES.length];
  const name = LIVE_ORDER_NAMES[Math.floor(seededUnit(seed + 23) * LIVE_ORDER_NAMES.length) % LIVE_ORDER_NAMES.length];
  const product = LIVE_ORDER_PRODUCTS[Math.floor(seededUnit(seed + 37) * LIVE_ORDER_PRODUCTS.length) % LIVE_ORDER_PRODUCTS.length];
  const time = LIVE_ORDER_TIMES[Math.floor(seededUnit(seed + 51) * LIVE_ORDER_TIMES.length) % LIVE_ORDER_TIMES.length];
  return { city, name, product, time };
}

function LiveOrderTicker() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const cycleLength = LIVE_ORDER_CITIES.length * 3;
    const timer = setInterval(() => setIdx((i) => (i + 1) % cycleLength), 3200);
    return () => clearInterval(timer);
  }, []);
  const order = liveOrderAt(idx);
  return (
    <div className="home-announcement-row" role="status" aria-live="polite">
      <Megaphone size={15} />
      <span>
        <b>{order.city}</b> {order.name} 下单了 {order.product} · {order.time}
      </span>
      <ArrowRight size={14} />
    </div>
  );
}

function HomeTestimonials() {
  const [start, setStart] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setStart((value) => (value + TESTIMONIALS_PER_PAGE) % TESTIMONIALS.length);
    }, TESTIMONIALS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  const visible = Array.from({ length: TESTIMONIALS_PER_PAGE }, (_, i) => TESTIMONIALS[(start + i) % TESTIMONIALS.length]);
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
      <header className="site-header">
        <div className="container header-inner">
          <Link href="/" className="brand-wrap" aria-label="冒央会社 Maoyang Taiwan Inc">
            <img src="/logo.png" alt="冒央会社 Maoyang Taiwan Inc" className="brand-img" />
          </Link>
          <div className="mobile-header-actions" aria-label="快捷入口">
            <Link href="/shop" aria-label="服务选购">
              <ShoppingBag size={16} />
              <span>选购</span>
            </Link>
            <Link href="/service-center" aria-label="服务中心">
              <Headphones size={16} />
              <span>客服</span>
            </Link>
          </div>
          <nav className="desktop-nav">
            <Link href="/shop">服务产品</Link>
            <Link href="/#layout">下单流程</Link>
            <Link href="/service-center#order-query">订单查询</Link>
            <Link href="/legal">企业保障</Link>
            <Link href="/service-center#faq">FAQ</Link>
          </nav>
        </div>
      </header>

      <main id="top" className="main-content home-main">
        <section className="home-hero-card container">
          <div className="home-hero-logo-wrap">
            <img src="/logo-transparent.png" alt="冒央会社 Maoyang Taiwan Inc" className="home-hero-full-logo" />
            <h1 className="sr-only">冒央会社 · 流媒体服务</h1>
          </div>
          <p>流媒体会员、节点服务与售后协助一站办理</p>
          <div className="home-hero-badges">
            <span><Zap size={14} />即时开通</span>
            <span><ShieldCheck size={14} />7 天内退款</span>
            <span><BadgeCheck size={14} />全网最低价</span>
          </div>
          <div className="home-hero-actions">
            <Link href="/shop" className="hero-pair-btn primary">
              <Zap size={16} />立即开通
            </Link>
            <Link href={authUser === false ? "/account?auth=login" : "/account"} className={`hero-pair-btn secondary${authUser === false ? " with-auth-tip" : ""}`}>
              <Users size={16} />{authUser === false ? "登录 / 注册" : "个人中心"}
              {authUser === false && <span className="hero-auth-tip">新用户注册立减 ¥8.88</span>}
            </Link>
            <Link href="/service-center#order-query" className="home-query-btn">
              <ShoppingBag size={16} />订单查询
            </Link>
          </div>
          <div className="home-hero-metrics" aria-label="平台运营数据">
            {HERO_STATS.map(({ metric, label, icon: Icon }) => (
              <div key={label} className="home-hero-metric">
                <Icon size={14} />
                <span>{label}</span>
                <b>{metrics[metric]}</b>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-trust-card">
          <h2>平台优势</h2>
          <div className="home-trust-grid">
            {TRUST_ITEMS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="home-trust-item">
                <Icon size={22} />
                <strong>{title}</strong>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="container home-announcement-card">
          <LiveOrderTicker />
        </section>

        <section id="redeem" className="section container home-redeem-section">
          <RedeemCard autoFillFromQuery />
        </section>

        <section id="layout" className="section container home-layout-section">
          <div className="section-head simple-head home-compact-head">
            <div>
              <div className="section-kicker">服务流程</div>
              <h2 className="section-title">下单/兑换流程</h2>
            </div>
          </div>
          <div className="layout-grid layout-grid-stack home-layout-grid">
            {LAYOUT_CARDS.map(([title, desc], index) => (
              <div key={title} className="glass-card info-card">
                <div className="info-step">{String(index + 1).padStart(2, "0")}</div>
                <ShoppingBag size={24} className="info-icon" />
                <div className="info-title">{title}</div>
                <div className="info-desc">{desc}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="section container home-reviews-section">
          <div className="section-head simple-head home-compact-head">
            <div className="home-review-heading">
              <div className="section-kicker">用户反馈</div>
              <div className="home-review-title-row">
                <h2 className="section-title">用户评价</h2>
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
            <div className="footer-brand">冒央会社 · Maoyang Taiwan Inc</div>
            <div className="footer-links">
              <Link href="/legal">企业资质与服务保障</Link>
              <Link href="/services/spotify">Spotify</Link>
              <Link href="/services/netflix">Netflix</Link>
              <Link href="/services/disney">Disney+</Link>
              <Link href="/services/hbo-max">HBO Max</Link>
              <Link href="/services/airport-node">机场节点</Link>
            </div>
          </div>
          <div className="footer-legal">
            <div className="footer-pill">地址：台湾新北市板桥区远东路1号3-218</div>
            <div className="footer-pill">Copyright © 2020-2026 Maoyang Taiwan Inc. All rights reserved</div>
          </div>
        </div>
      </footer>

      <FloatingSupport />
      <MobileNav />
    </div>
  );
}
