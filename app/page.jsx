"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Headphones,
  Image as ImageIcon,
  LayoutPanelTop,
  MessageCircleMore,
  QrCode,
  Sparkles,
  X,
} from "lucide-react";

const SITE_CONTENT = {
  brandCn: "冒央会社",
  brandEn: "MAOYANG",
  domain: "liumeiti.vip",
  heroBadge: "来自中国台湾，专注流媒体会员服务",
  heroTitleLine1: "冒央会社",
  heroTitleHighlight: "-Maoyang Taiwan Inc",
  heroTitleLine2: "",
  heroDesc:
    "自2020年开始从事会员服务，以全网最低的价格，为客人带来最优质的会员服务，在国内外各大平台均开设有店铺，累计5万+客户，累计销量超10万，收获无数认可好评，百分百好评无一差评！",
  topCards: [
    ["服务类别", "Spotify，Netflix，Disney+，Hbomax，网络服务等"],
    ["公司规模", "设有充值部门售后部门共26人，实时为用户提供优质服务，行业Top3"],
    ["价格优势", "源头会员供应，没有任何中间商赚取差价"],
    ["服务特点", "低价稳定优质，注重用户使用体验"],
  ],
  layoutCards: [
    ["选择所需服务", "Spotify/Netflix/Disney+/Hbomax/机场节点"],
    ["查看详情介绍", "请认真查阅我们的服务介绍,确保服务满足您的要求"],
    ["付款下单", "请在支付备注您的联系方式，工作人员将在30分钟内联系您"],
    ["售后服务", "成交只是开始，专业团队全程售后保障用户使用体验"],
  ],
  faq: [
    {
      q: "是否支持售后服务？",
      a: "支持。我们支持7天无理由退款，并且提供在线客服协助、问题排查与订单服务咨询，如您有任何问题，随时联系我们的在线客服团队。",
    },
    {
      q: "如何联系在线客服？",
      a: "可通过 QQ、WhatsApp、Telegram 与我们联系，在线时间为北京时间早 9 点至晚 11 点。",
    },
    {
      q: "关于我们？",
      a: "冒央会社来自中国台湾，长期专注流媒体会员服务、使用指导、售后协助。 我们重视响应速度、服务体验与长期口碑，持续为用户提供简洁、稳定、优质的服务流程。",
    },
    {
      q: "是否可以定制企业或团队方案？",
      a: "可以。我们全网用于200+代理合作伙伴，若你有长期合作、批量需求或企业场景，可联系客服进一步沟通。",
    },
  ],
  contactTitle: "联系我们",
  contactDesc:
    "为给用户提供更快的支持响应，工单提交暂停开放，请联系我们的实时在线客服获取更快更优质的服务支持",
  contactInputs: [
    "输入您的尊称",
    "输入您的联系方式",
    "咨询的服务类型",
    "输入详情需求描述",
  ],
  supportTitle: "实时在线客服",
  supportItems: [
    "QQ:2802632995",
    "WhatsApp:+1 4315093334",
    "Telegram:+44 7707489977",
    "在线时间:北京时间早九点至晚十一点",
  ],
  footerRecord: "M.Y.",
  footerNote: "Copyright © 2026 Maoyang Taiwan Inc. All rights reserved",
};

const PRODUCTS = [
  {
    key: "spotify",
    image: "/products/spotify.jpg",
    title: "Spotify",
    subtitle: "欧美日高价区家庭计划",
    price: "仅需¥128/年",
    shortIntro: "无损音质，播客，AIDJ，完整曲库，有声读物，合辑歌单等",
    highlights: ["功能齐全", "稳定使用", "售后保障"],
    detailTitle: "欧美日高价区家庭计划，一年仅128元包售后",
    detailBody: "支持无损音质，收听播客，离线下载，合辑歌单，有声读物，曲库完整，如需订阅个人/双人/六人家庭请联系在线客服",
    orderTitle: "Spotify-请支付宝扫码支付128元",
    orderBody: "请在支付宝付款备注您的联系方式，如QQ/微信/WhatsApp等，充值人员将在30分钟内联系您",
    qrHint: "这里放 Spotify 支付二维码区域",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "netflix",
    image: "/products/netflix.jpg",
    title: "Netflix",
    subtitle: "4K杜比套餐，独立车位",
    price: "仅需¥168/年",
    shortIntro: "全球可用顶规套餐，4K画质，杜比音效，一人一位可上锁",
    highlights: ["4K画质", "杜比音效", "售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅168包售后",
    detailBody: "4K杜比最高级别套餐，高峰不排队不被挤，一人独享一个位置，最高4K画质，支持杜比音效，离线下载，位置可上pin，五人一车一人一位互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Netflix-请支付宝扫码支付168元",
    orderBody: "请在支付宝付款备注您的联系方式，如QQ/微信/WhatsApp等，充值人员将在30分钟内联系您",
    qrHint: "这里放 Netflix 支付二维码区域",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "disney",
    image: "/products/disney.jpg",
    title: "Disney+",
    subtitle: "独立车位全球可用4K杜比套餐",
    price: "仅需¥108/年",
    shortIntro: "4人一车绝不超售，全球可用4K杜比套餐，一人一位置互不干扰",
    highlights: ["4K杜比", "位置上锁", "不被挤不排队"],
    detailTitle: "最高级别套餐，独立车位，一年仅108包售后",
    detailBody: "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，4人一车绝不超售，高峰不排队不被挤，位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "Disney-请支付宝扫码支付108元",
    orderBody: "请在支付宝付款备注您的联系方式，如QQ/微信/WhatsApp等，充值人员将在30分钟内联系您",
    qrHint: "这里放 Disney+ 支付二维码区域",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "max",
    image: "/products/hbomax.jpg",
    title: "HBO Max",
    subtitle: "独立车位全球可用4K杜比套餐",
    price: "仅需¥148/年",
    shortIntro: "4人车全球可用4K杜比套餐，一人独享一位置互不干扰高峰不排队",
    highlights: ["4K杜比", "全球可用", "实时售后保障"],
    detailTitle: "最高级别套餐，独立车位，一年仅148包售后",
    detailBody: "4K画质，杜比音效，离线下载，全球可用不限制地区，顶规4K杜比套餐，4人一车绝不超售，高峰不排队不被挤，位置可上锁，用户互不干扰，如需购买整号请联系在线客服",
    orderTitle: "HBOMAX-请支付宝扫码支付148元",
    orderBody: "请在支付宝付款备注您的联系方式，如QQ/微信/WhatsApp等，充值人员将在30分钟内联系您",
    qrHint: "这里放 HBO Max 支付二维码区域",
    qrImage: "/payment/alipay.jpg",
  },
  {
    key: "rocket",
    image: "/products/rocket.jpg",
    title: "机场节点",
    subtitle: "不限设备，不限流量，最高5GBS带宽，解锁所有流媒体/AI/社交软件",
    price: "仅需¥98/年",
    shortIntro: "大厂机房多线路，最高5GBS带宽，解锁所有流媒体/AI/社交软件，高峰不卡顿，线路稳定不异常",
    highlights: ["不限设备/流量/带宽", "高速稳定多地区节点", "全加密协议无日志隐私保障"],
    detailTitle: "大厂机房多线路，不限设备，不限流量，年仅98",
    detailBody: "优选大厂vps，多线路港日台韩新美英德法等，不限制设备，不限制流量，最高速率可达5GBS，高峰不拥堵不卡顿，解锁所有主流流媒体/ai软件/社交软件，全加密协议无日志隐私保障，实时维护24x7线路不中断，请在付款备注用户名，4-10位数字/字母组合（区分大小写），节点订阅链接为，小火箭shadowrocket：https://hk.joinvip.vip:2056/sub/(你所备注的4-10位数字字母组合)，clashmeta订阅链接为：https://hk.joinvip.vip:2056/sub/(你所备注的4-10位数字字母组合)?format=clash，如您备注jenny2(订阅链接为：https://hk.joinvip.vip:2056/sub/jenny2，订阅链接将在付款后30分钟内可用，如有任何问题请在付款后联系我们在线客服",
    orderTitle: "网络节点-请支付宝扫码支付98",
    orderBody: "请在付款备注用户名，4-10位数字/字母组合（区分大小写），节点订阅链接为，小火箭shadowrocket：https://hk.joinvip.vip:2056/sub/(你所备注的4-10位数字字母组合)，clashmeta订阅链接为：https://hk.joinvip.vip:2056/sub/(你所备注的4-10位数字字母组合)?format=clash，如您备注jenny2，订阅链接为：https://hk.joinvip.vip:2056/sub/jenny2，clash：https://hk.joinvip.vip:2056/sub/jenny2?format=clash，订阅链接将在付款后30分钟内可用，如有任何问题请联系在线客服",
    qrHint: "这里放 节点 支付二维码区域",
    qrImage: "/payment/alipay.jpg",
  },
];

function copyText(text) {
  if (typeof window !== "undefined") {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

export default function Page() {
  const [selectedKey, setSelectedKey] = useState(null);
  const [faqOpen, setFaqOpen] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [orderPreviewOpen, setOrderPreviewOpen] = useState(false);

  const selectedProduct = useMemo(
    () => PRODUCTS.find((item) => item.key === selectedKey) || null,
    [selectedKey]
  );

  return (
    <div className="page-shell">
      <div className="bg-orb orb-a" />
      <div className="bg-orb orb-b" />
      <div className="bg-orb orb-c" />

      <header className="site-header">
        <div className="container header-inner">
          <a href="#top" className="brand-wrap">
            <div className="brand-logo">
              <span className="brand-logo-mini">MY</span>
              <span className="brand-logo-cn">冒央</span>
            </div>
            <div>
              <div className="brand-en">{SITE_CONTENT.brandEn}</div>
              <div className="brand-cn">{SITE_CONTENT.brandCn}</div>
            </div>
          </a>

          <nav className="desktop-nav">
            <a href="#products">所有服务</a>
            <a href="#layout">下单流程</a>
            <a href="#faq">FAQ</a>
            <a href="#contact">联系我们</a>
          </nav>

          <a href="#contact" className="pill-link">联系客服</a>
        </div>
      </header>

      <main id="top" className="main-content">
        <section className="hero-section container">
          <div className="hero-badge">
            <Sparkles size={16} />
            {SITE_CONTENT.heroBadge}
          </div>

          <div className="hero-grid">
            <div>
              <h1 className="hero-title">
                {SITE_CONTENT.heroTitleLine1}
                <span className="hero-title-highlight">{SITE_CONTENT.heroTitleHighlight}</span>
                {SITE_CONTENT.heroTitleLine2}
              </h1>
              <p className="hero-desc">{SITE_CONTENT.heroDesc}</p>

              <div className="hero-actions">
                <a href="#products" className="primary-btn">
                  购买会员服务
                  <ArrowRight size={16} />
                </a>
                <a href="#layout" className="secondary-btn">下单流程</a>
              </div>
            </div>

            <div className="hero-cards-grid">
              {SITE_CONTENT.topCards.map(([title, desc]) => (
                <div key={title} className="glass-card small-card">
                  <div className="small-card-title">{title}</div>
                  <div className="small-card-desc">{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="products" className="section container">
          <div className="section-head">
            <div>
              <div className="section-kicker">Services</div>
              <h2 className="section-title">流媒体会员服务</h2>
            </div>
            <div className="section-note">Since 2020，持续为用户提供优质低价服务</div>
          </div>

          <div className="products-grid">
            {PRODUCTS.map((item) => (
              <article key={item.key} className="glass-card product-card">
                <div className="product-card-top">
                  <div>
                    <div className="tiny-pill">服务名称</div>
                    <div className="product-name">{item.title}</div>
                    <div className="product-subtitle">{item.subtitle}</div>
                  </div>
                  <img src={item.image} alt={item.title} className="product-image" />
                </div>

                <div className="price-box">{item.price}</div>
                <div className="intro-box">{item.shortIntro}</div>

                <div className="bullet-list">
                  {item.highlights.map((bullet) => (
                    <div key={bullet} className="bullet-item">
                      <BadgeCheck size={16} />
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>

                <button className="primary-btn left-btn" onClick={() => setSelectedKey(item.key)}>
                  查看详情
                  <ArrowRight size={16} />
                </button>
              </article>
            ))}
          </div>
        </section>

        <section id="layout" className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">Place Guide</div>
              <h2 className="section-title">下单流程介绍</h2>
            </div>
          </div>

          <div className="products-grid layout-grid">
            {SITE_CONTENT.layoutCards.map(([title, desc], idx) => {
              const icons = [LayoutPanelTop, ImageIcon, QrCode, MessageCircleMore];
              const Icon = icons[idx];
              return (
                <div key={title} className="glass-card info-card">
                  <Icon size={32} className="info-icon" />
                  <div className="info-title">{title}</div>
                  <div className="info-desc">{desc}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section id="faq" className="section container">
          <div className="section-head simple-head">
            <div>
              <div className="section-kicker">FAQ</div>
              <h2 className="section-title">常见问题</h2>
            </div>
          </div>

          <div className="faq-list">
            {SITE_CONTENT.faq.map((faq, index) => {
              const open = faqOpen === index;
              return (
                <div key={faq.q} className="faq-card">
                  <button className="faq-button" onClick={() => setFaqOpen(open ? -1 : index)}>
                    <span>{faq.q}</span>
                    <ChevronDown size={18} className={open ? "rotate" : ""} />
                  </button>
                  {open ? <div className="faq-answer">{faq.a}</div> : null}
                </div>
              );
            })}
          </div>
        </section>

        <section id="contact" className="section container">
          <div className="contact-grid">
            <div className="glass-card contact-card">
              <div className="section-kicker">Contact Form</div>
              <h2 className="section-title smaller-title">{SITE_CONTENT.contactTitle}</h2>
              <p className="contact-desc">{SITE_CONTENT.contactDesc}</p>
              <div className="form-preview">
                <input readOnly placeholder={SITE_CONTENT.contactInputs[0]} />
                <input readOnly placeholder={SITE_CONTENT.contactInputs[1]} />
                <input readOnly placeholder={SITE_CONTENT.contactInputs[2]} />
                <textarea readOnly rows={5} placeholder={SITE_CONTENT.contactInputs[3]} />
              </div>
            </div>

            <div className="contact-side">
              <div className="glass-card support-card">
                <div className="tiny-pill support-pill">
                  <Headphones size={14} />
                  {SITE_CONTENT.supportTitle}
                </div>
                <div className="support-list">
                  <button className="support-item" onClick={() => copyText("2802632995")}>
                    <span>{SITE_CONTENT.supportItems[0]}</span>
                    <Copy size={16} />
                  </button>
                  <button className="support-item" onClick={() => copyText("+1 4315093334")}>
                    <span>{SITE_CONTENT.supportItems[1]}</span>
                    <Copy size={16} />
                  </button>
                  <button className="support-item" onClick={() => copyText("+44 7707489977")}>
                    <span>{SITE_CONTENT.supportItems[2]}</span>
                    <Copy size={16} />
                  </button>
                  <div className="support-item muted-item">{SITE_CONTENT.supportItems[3]}</div>
                </div>
              </div>

              <div className="glass-card note-card">
                <div className="tiny-pill support-pill">
                  <Globe size={14} />
                  补充说明
                </div>
                <p className="note-text">
                  冒央会社所有从事服务均符合中国大陆与台湾法律法规，使用过程任何问题请联系我们的在线客服人员。
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container footer-inner">
          <div>
            <div className="footer-brand">{SITE_CONTENT.brandCn} · {SITE_CONTENT.brandEn}</div>
            <div className="footer-sub">{SITE_CONTENT.domain} · Since 2020</div>
          </div>
          <div className="footer-pill">{SITE_CONTENT.footerRecord}</div>
          <div className="footer-pill">{SITE_CONTENT.footerNote}</div>
        </div>
      </footer>

      <div className="floating-wrap">
        {contactOpen ? (
          <div className="floating-panel">
            <div className="floating-head">
              <div className="section-kicker">Support</div>
              <div className="floating-title">在线客服</div>
            </div>
            <div className="floating-list">
              <div className="floating-item">{SITE_CONTENT.supportItems[0]}</div>
              <div className="floating-item">{SITE_CONTENT.supportItems[1]}</div>
              <div className="floating-item">{SITE_CONTENT.supportItems[2]}</div>
            </div>
          </div>
        ) : null}

        <button className="floating-button" onClick={() => setContactOpen((v) => !v)} aria-label="打开客服菜单">
          {contactOpen ? <X size={24} /> : <Headphones size={24} />}
        </button>
      </div>

      {selectedProduct ? (
        <div className="modal-mask">
          <div className="modal-card modal-large">
            <div className="modal-head">
              <div className="modal-head-left">
                <img src={selectedProduct.image} alt={selectedProduct.title} className="modal-product-image" />
                <div>
                  <div className="section-kicker">详情介绍</div>
                  <div className="modal-title">{selectedProduct.title} 详情预览</div>
                </div>
              </div>
              <button className="close-btn" onClick={() => { setSelectedKey(null); setOrderPreviewOpen(false); }}>
                <X size={18} />
              </button>
            </div>

            <div className="modal-grid">
              <div className="modal-left-box">
                <div className="minor-label">左侧信息区</div>
                <div className="modal-price">{selectedProduct.price}</div>
                <div className="modal-intro-box">{selectedProduct.shortIntro}</div>
                <div className="bullet-list">
                  {selectedProduct.highlights.map((bullet) => (
                    <div key={bullet} className="bullet-item">
                      <BadgeCheck size={16} />
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="detail-title">{selectedProduct.detailTitle}</div>
                <div className="detail-body">{selectedProduct.detailBody}</div>
                <div className="modal-actions">
                  <button className="primary-btn" onClick={() => setOrderPreviewOpen(true)}>
                    点击下单
                    <ArrowRight size={16} />
                  </button>
                  <button
                    className="secondary-btn"
                    onClick={() => {
                      setSelectedKey(null);
                      setContactOpen(true);
                      setOrderPreviewOpen(false);
                    }}
                  >
                    联系在线客服
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedProduct && orderPreviewOpen ? (
        <div className="modal-mask second-mask">
          <div className="modal-card modal-medium">
            <div className="modal-head">
              <div>
                <div className="section-kicker">Order Popup</div>
                <div className="modal-title">打开支付宝扫码付款</div>
              </div>
              <button className="close-btn" onClick={() => setOrderPreviewOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="modal-grid second-grid">
              <div className="qr-box-wrap">
                <div className="minor-label strong-label">Alipay/支付宝打开扫一扫</div>
                <div className="qr-box">
                  {selectedProduct.qrImage ? (
                    <img src={selectedProduct.qrImage} alt="二维码预览" className="qr-image" />
                  ) : (
                    <div className="qr-placeholder">
                      <QrCode size={56} />
                      <div>{selectedProduct.qrHint}</div>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="detail-title">{selectedProduct.orderTitle}</div>
                <div className="detail-body">{selectedProduct.orderBody}</div>
                <div className="notice-box">
                  请在支付宝付款准确备注信息，付款后工作人员将尽快联系您，如有问题可主动联系我们。
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
