"use client";

import { FileText, RefreshCw } from "lucide-react";
import { itemValidityLabel } from "../lib/order-fulfillment";
import { readRocketSubscriptionUrl, validSubscriptionLink } from "../lib/rocket-subscription";

const SPOTIFY_REGIONS = [
  ["", "选择地区"],
  ["europe", "欧洲区"],
  ["us", "美国区"],
  ["japan", "日本区"],
  ["uk", "英国区"],
  ["other", "其他地区"],
];

const SPOTIFY_OUTCOMES = [
  ["family_joined", "已加入家庭组"],
  ["individual_activated", "个人订阅已开通"],
  ["duo_activated", "双人订阅已开通"],
  ["family_activated", "家庭套餐已开通"],
  ["account_provided", "已提供新账号"],
  ["activated", "订阅已开通"],
];

function CompactSwitch({ checked, onChange, label, hint }) {
  return (
    <div className="admin-delivery-switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`admin-compact-switch${checked ? " active" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      <button type="button" className="admin-delivery-switch-copy" onClick={() => onChange(!checked)}>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </button>
    </div>
  );
}

function SpotifyFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  return (
    <div className="admin-delivery-fields four">
      <label>
        <span>用户名</span>
        <input
          value={fulfillment.username || ""}
          onChange={(event) => onChange({ username: event.target.value })}
          placeholder="例如 User123"
          maxLength={60}
        />
      </label>
      <label>
        <span>开通地区</span>
        <select value={fulfillment.region || ""} onChange={(event) => onChange({ region: event.target.value })}>
          {SPOTIFY_REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        <span>处理结果</span>
        <select value={fulfillment.outcome || "activated"} onChange={(event) => onChange({ outcome: event.target.value })}>
          {SPOTIFY_OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <CompactSwitch
        checked={Boolean(fulfillment.emailConfirmation)}
        onChange={(value) => onChange({ emailConfirmation: value })}
        label="需要确认邮箱"
        hint="加入客户说明"
      />
    </div>
  );
}

function ProfileFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  const fullAccount = item.plan === "full";
  return (
    <div className="admin-delivery-fields three">
      <label>
        <span>{fullAccount ? "用户档案（选填）" : "车位 / 用户档案"}</span>
        <input
          value={fulfillment.profileNumber || ""}
          onChange={(event) => onChange({ profileNumber: event.target.value })}
          placeholder={fullAccount ? "整号可留空" : "例如 3"}
          maxLength={20}
        />
      </label>
      <label>
        <span>PIN（选填）</span>
        <input
          value={fulfillment.pin || ""}
          onChange={(event) => onChange({ pin: event.target.value })}
          placeholder="未设置可留空"
          maxLength={30}
        />
      </label>
      <CompactSwitch
        checked={fulfillment.loginHelp !== false}
        onChange={(value) => onChange({ loginHelp: value })}
        label="加入登录帮助"
        hint="获取帮助说明"
      />
    </div>
  );
}

function RocketFields({ item, onChange, onLinkChange, onGenerateLink, generating }) {
  const fulfillment = item.fulfillment || {};
  // The link is what staff paste, or what the panel returns through the
  // button. Older orders stored a pair, which this still reads. It has to be
  // filled before the order can be completed; nothing is minted for it.
  const link = typeof item.subscriptionLinks === "string" ? item.subscriptionLinks : readRocketSubscriptionUrl(item.subscriptionLinks);
  const filled = validSubscriptionLink(link);
  return (
    <div className="admin-delivery-fields">
      <label className={`admin-delivery-link${filled ? " is-filled" : ""}`}>
        <span>订阅链接 <em>{filled ? "已填写" : "标记完成前必填"}</em></span>
        <div className="admin-delivery-link-row">
          <input
            value={link || ""}
            onChange={(event) => onLinkChange?.(event.target.value)}
            placeholder="粘贴订阅链接，或点击「面板生成」由节点面板开号并返回链接"
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
          />
          <button
            type="button"
            className="admin-delivery-generate"
            onClick={() => onGenerateLink?.()}
            disabled={generating || !onGenerateLink}
            title="按订单号在节点面板开号并套用套餐，返回订阅链接"
          >
            {generating ? <><RefreshCw size={12} className="spin-icon" />生成中</> : <><RefreshCw size={12} />面板生成</>}
          </button>
        </div>
        {link && !filled && <small className="admin-delivery-link-error">链接需以 https:// 开头且不含空格</small>}
      </label>
      <CompactSwitch
        checked={fulfillment.clientGuide !== false}
        onChange={(value) => onChange({ clientGuide: value })}
        label="加入客户端说明"
        hint="Nextin / Shadowrocket / Clash"
      />
    </div>
  );
}

function AiFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  return (
    <div className="admin-delivery-fields two">
      <label>
        <span>登录方式</span>
        <select value={fulfillment.loginMethod || "provided"} onChange={(event) => onChange({ loginMethod: event.target.value })}>
          <option value="provided">订单账号登录</option>
          <option value="email">邮箱登录</option>
          <option value="google">Google 登录</option>
        </select>
      </label>
      <CompactSwitch
        checked={Boolean(fulfillment.twoFactorInstruction)}
        onChange={(value) => onChange({ twoFactorInstruction: value })}
        label="加入 2FA 说明"
        hint="不在此处填写密钥"
      />
    </div>
  );
}

function ItemFields({ item, onChange, onLinkChange, onGenerateLink, generating }) {
  if (item.service === "spotify") return <SpotifyFields item={item} onChange={onChange} />;
  if (["netflix", "disney", "max"].includes(item.service)) return <ProfileFields item={item} onChange={onChange} />;
  if (item.service === "rocket") return <RocketFields item={item} onChange={onChange} onLinkChange={onLinkChange} onGenerateLink={onGenerateLink} generating={generating} />;
  if (item.service === "ai") return <AiFields item={item} onChange={onChange} />;
  return <p className="admin-delivery-generic">本商品沿用客户交付说明，无需额外配置。</p>;
}

export default function DeliveryWorkbench({
  order,
  items,
  customerMessage,
  internalNotes,
  internalReference,
  thirdPartyPlatformNotice,
  deliveryMessageMode,
  onFulfillmentChange,
  onSubscriptionLinkChange,
  onGenerateSubscriptionLink,
  generatingSubscriptionLink,
  onGenerate,
  onCustomerMessageChange,
  onInternalNotesChange,
  onInternalReferenceChange,
  onThirdPartyChange,
}) {
  const expiryOrder = { ...order, items };
  return (
    <section className="admin-modal-section admin-delivery-workbench">
      <div className="admin-delivery-heading">
        <div>
          <h3>交付工作台</h3>
          <p>选择实际处理结果，生成统一的客户说明。</p>
        </div>
        <button type="button" className="admin-delivery-generate" onClick={onGenerate}>
          <RefreshCw size={12} />生成说明
        </button>
      </div>

      <div className="admin-delivery-list">
        {items.map((item, index) => (
          <div className="admin-delivery-item" key={`${item.service || "item"}-${index}`}>
            <div className="admin-delivery-item-head">
              <b>{index + 1}. {item.label}</b>
              <span>{itemValidityLabel(expiryOrder, item, order?.locale === "en" ? "en" : "zh")}</span>
            </div>
            <ItemFields
              item={item}
              onChange={(patch) => onFulfillmentChange(index, patch)}
              onLinkChange={(value) => onSubscriptionLinkChange?.(index, value)}
              onGenerateLink={onGenerateSubscriptionLink ? () => onGenerateSubscriptionLink(index) : undefined}
              generating={Boolean(generatingSubscriptionLink)}
            />
          </div>
        ))}
      </div>

      <div className="admin-delivery-message-head">
        <div>
          <FileText size={13} />
          <b>客户交付说明</b>
          <em>{deliveryMessageMode === "auto" ? "标准生成" : "人工编辑"}</em>
        </div>
        <CompactSwitch
          checked={Boolean(thirdPartyPlatformNotice)}
          onChange={onThirdPartyChange}
          label="第三方平台订单"
          hint="开启后自动加入确认收货提示"
        />
      </div>
      <textarea
        className="admin-notes admin-delivery-customer-note"
        value={customerMessage}
        onChange={(event) => onCustomerMessageChange(event.target.value)}
        rows={4}
        maxLength={1500}
        placeholder="点击“生成说明”，或手动填写需要发送给客户的交付结果。"
      />

      <div className="admin-delivery-internal-tools">
        <label>
          <span>内部编号 <em>选填</em></span>
          <input
            value={internalReference || ""}
            onChange={(event) => onInternalReferenceChange(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))}
            maxLength={32}
            placeholder="用于关联、搜索与批量通知"
          />
        </label>
      </div>

      <label className="admin-delivery-internal">
        <span>内部备注 <em>仅后台可见</em></span>
        <textarea
          className="admin-notes"
          value={internalNotes}
          onChange={(event) => onInternalNotesChange(event.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="采购渠道、成本、家庭组编号或其他内部处理记录。"
        />
      </label>
    </section>
  );
}
